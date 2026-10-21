import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_CONFIG,
  compactStatus,
  getSharedConfig,
  resolvePolicy,
  routedTargetOf,
  sanitizeConfig,
  setSharedConfig,
  sessionIdOf,
  unwrapConfig,
} from './policy.js'

export const name = 'dsh-compact'
export const STATUS_ENDPOINT = '/api/dsh-compact/status'
export const COMPACT_ENDPOINT = '/api/dsh-compact/compact-now'
export const CONFIG_ENDPOINT = '/api/dsh-compact/config'

const ModelPolicy = Schema.object({
  provider: Schema.string().description('精确匹配 provider'),
  model: Schema.string().description('精确匹配 model'),
  enabled: Schema.boolean(),
  thresholdRatio: Schema.number().min(0.5).max(0.95).step(0.01),
  retainRatio: Schema.number().min(0.05).max(0.5).step(0.01),
  recoverOnOverflow: Schema.boolean(),
  maxOverflowRetries: Schema.union([Schema.const(0), Schema.const(1)]),
})

// Volatile fields are the ones Settings may edit without remounting this entry:
// the Host updates the same references in place and emits `loader/volatile-update`.
export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled).volatile()
    .description('启用请求前自动压缩'),
  thresholdRatio: Schema.number().min(0.5).max(0.95).step(0.01)
    .default(DEFAULT_CONFIG.thresholdRatio).role('slider').volatile()
    .description('自动压缩触发比例'),
  retainRatio: Schema.number().min(0.05).max(0.5).step(0.01)
    .default(DEFAULT_CONFIG.retainRatio).role('slider').volatile()
    .description('压缩后保留近期上下文比例'),
  recoverOnOverflow: Schema.boolean().default(DEFAULT_CONFIG.recoverOnOverflow).volatile()
    .description('上下文溢出后压缩并重试原请求'),
  maxOverflowRetries: Schema.union([Schema.const(0), Schema.const(1)])
    .default(DEFAULT_CONFIG.maxOverflowRetries).volatile()
    .description('单轮溢出恢复次数'),
  modelPolicies: Schema.array(ModelPolicy).default([]).volatile()
    .description('provider/model 专属策略'),
}).description('DSH 请求路径上下文压缩')

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function authorize(req, res) {
  if (!isLoopback(req.socket?.remoteAddress)) {
    jsonResponse(res, 403, { error: 'local access only' })
    return false
  }
  const origin = req.headers?.origin
  if (origin) {
    let originHost
    try { originHost = new URL(origin).host } catch {}
    if (!originHost || originHost !== req.headers.host) {
      jsonResponse(res, 403, { error: 'origin mismatch' })
      return false
    }
  }
  return true
}

async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 4096) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object')
  return value
}

/**
 * Read a Cordis service without declaring it as a hard dependency: the agent
 * registry, the preset registry, and Settings are optional neighbours of this
 * entry, and a missing one must not strand the plugin.
 * @param ctx - plugin or request context.
 * @param name - service name.
 * @returns the service, or undefined when it is not mounted.
 */
function serviceOf(ctx, name) {
  if (typeof ctx.get === 'function') {
    const service = ctx.get(name)
    if (service !== undefined) return service
  }
  return ctx[name]
}

/**
 * Resolve the agent a request is about. The Web settings surface no longer
 * hands the active session to a plugin, so an unnamed request means the most
 * recently registered root agent.
 * @param ctx - plugin context carrying the agents registry.
 * @param sessionId - explicitly requested session id, or an empty string.
 * @returns the live agent, or undefined when none is available.
 */
export function resolveAgent(ctx, sessionId) {
  const agents = serviceOf(ctx, 'agents')
  if (sessionId) return agents?.get?.(sessionId)
  const roots = agents?.roots?.() ?? []
  return Array.isArray(roots) ? roots.at(-1) : undefined
}

export function createStatusHandler(ctx) {
  return async (req, res) => {
    if (!authorize(req, res)) return
    if (req.method !== 'GET') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    const url = new URL(req.url ?? STATUS_ENDPOINT, `http://${req.headers.host ?? '127.0.0.1'}`)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const agent = resolveAgent(ctx, sessionId)
    const service = agent ? serviceOf(ctx, 'agentPresets')?.serviceFor?.(agent, 'compaction') : undefined
    const policy = agent ? resolvePolicy(getSharedConfig(), routedTargetOf(agent)) : undefined
    jsonResponse(res, 200, {
      ...compactStatus.get(sessionId),
      sessionId: sessionIdOf(agent) || sessionId,
      engineActive: service?.dshCompact === true,
      ...(policy ? { policy } : {}),
    })
  }
}

export function createCompactNowHandler(ctx) {
  return async (req, res) => {
    if (!authorize(req, res)) return
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    let body
    try { body = await readJson(req) } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const agent = resolveAgent(ctx, sessionId)
    if (!agent) {
      jsonResponse(res, 404, { error: 'session is not active' })
      return
    }
    const service = serviceOf(ctx, 'agentPresets')?.serviceFor?.(agent, 'compaction')
    if (!service || service.dshCompact !== true || typeof service.compactNow !== 'function') {
      jsonResponse(res, 409, { error: 'current preset does not use dsh-compact' })
      return
    }
    try {
      const result = await service.compactNow(agent, AbortSignal.timeout(120000))
      jsonResponse(res, 200, {
        ok: true,
        compacted: result !== null,
        status: compactStatus.get(sessionIdOf(agent)),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const busy = error?.code === 'busy' || /\bbusy\b|requires an idle agent/i.test(message)
      jsonResponse(res, busy ? 409 : 500, { error: message, code: busy ? 'busy' : 'failed' })
    }
  }
}

/**
 * Settings surface for this entry. The Host no longer registers per-plugin
 * settings namespaces: the profile entry id is the namespace, and only the
 * volatile fields declared by `Config` are written here.
 * @param ctx - plugin context; `ctx.get('settings')` may appear after mount.
 * @param config - composition entry config carrying volatile references.
 * @returns the request handler.
 */
export function createConfigHandler(ctx, config) {
  const entryId = entryIdOf(ctx)
  const settingsOf = () => (typeof ctx.get === 'function' ? ctx.get('settings') : undefined)
  const current = () => {
    try {
      return sanitizeConfig(unwrapConfig(config))
    } catch {
      return getSharedConfig()
    }
  }
  return async (req, res) => {
    if (!authorize(req, res)) return
    if (req.method === 'GET') {
      jsonResponse(res, 200, {
        config: current(),
        namespace: entryId ?? null,
        writable: entryId !== undefined && settingsOf() !== undefined,
      })
      return
    }
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    const settings = settingsOf()
    if (entryId === undefined || settings === undefined) {
      jsonResponse(res, 409, { error: 'settings are unavailable outside a profile entry' })
      return
    }
    let body
    try { body = await readJson(req) } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const patch = body.patch
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      jsonResponse(res, 400, { error: 'patch must be an object' })
      return
    }
    try {
      sanitizeConfig({ ...unwrapConfig(getSharedConfig()), ...patch })
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    try {
      await settings.update(entryId, patch)
      refreshConfig(ctx, config)
      jsonResponse(res, 200, { ok: true, config: getSharedConfig(), namespace: entryId })
    } catch (error) {
      jsonResponse(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Read the Loader entry id that backs this plugin instance.
 * @param ctx - plugin context.
 * @returns the entry id, or undefined when mounted outside the Loader.
 */
export function entryIdOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Resolve the composition entry config into the shared policy store.
 * @param ctx - plugin context, used only for the warning channel.
 * @param config - composition entry config, possibly carrying volatile references.
 * @returns whether the config was accepted.
 */
export function refreshConfig(ctx, config) {
  try {
    setSharedConfig(unwrapConfig(config))
    return true
  } catch (error) {
    ctx.logger?.warn?.(
      `dsh-compact config rejected: ${error instanceof Error ? error.message : String(error)}; keeping the previous policy`,
    )
    return false
  }
}

export function apply(ctx, config = {}) {
  refreshConfig(ctx, config)
  // Settings edits a volatile field in place; the entry is not remounted.
  ctx.on?.('loader/volatile-update', () => refreshConfig(ctx, config))
  // The client half renders its own settings card, so the generated form for
  // this entry stays out of the way where the Settings service exists.
  ctx.inject?.(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'dsh-compact: settings presentation',
    )
  })
  ctx.inject?.(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: STATUS_ENDPOINT,
        handler: createStatusHandler(ctx),
      }),
      'dsh-compact: status endpoint',
    )
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: COMPACT_ENDPOINT,
        handler: createCompactNowHandler(ctx),
      }),
      'dsh-compact: compact-now endpoint',
    )
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: 'exact',
        path: CONFIG_ENDPOINT,
        handler: createConfigHandler(ctx, config),
      }),
      'dsh-compact: config endpoint',
    )
  })
}

export { DshCompactEngine } from './engine.js'
export { DEFAULT_CONFIG, compactStatus, resolvePolicy, sanitizeConfig } from './policy.js'
