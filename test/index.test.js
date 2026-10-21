import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPACT_ENDPOINT,
  CONFIG_ENDPOINT,
  Config,
  STATUS_ENDPOINT,
  apply,
  compactStatus,
  createCompactNowHandler,
  createConfigHandler,
  createStatusHandler,
  entryIdOf,
  refreshConfig,
  resolveAgent,
} from '../lib/index.js'
import { DEFAULT_CONFIG, getSharedConfig, sanitizeConfig, setSharedConfig } from '../lib/policy.js'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function volatileValue(value) {
  return Object.freeze({ get: () => value, [VOLATILE_WRITE]: () => {} })
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload ?? ''
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

function makeReq({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

function agent(id, target = { provider: 'deepseek-account', model: 'deepseek-flash' }) {
  return {
    id,
    options: target,
    session: { id, requestHeader: () => ({ config: target }) },
  }
}

test('the entry Config exposes the documented volatile fields', () => {
  const value = Config({})
  assert.equal(typeof value.enabled.get(), 'boolean')
  assert.equal(value.thresholdRatio.get(), DEFAULT_CONFIG.thresholdRatio)
  assert.equal(value.retainRatio.get(), DEFAULT_CONFIG.retainRatio)
  assert.equal(value.recoverOnOverflow.get(), true)
  assert.equal(value.maxOverflowRetries.get(), 1)
  assert.deepEqual(value.modelPolicies.get(), [])
  const schema = Config.toJSON()
  assert.equal(schema.refs[schema.uid].type, 'object')
  assert.equal(typeof Config({}).thresholdRatio.get, 'function')
})

test('entryIdOf reads the Loader entry and tolerates a plugin mounted elsewhere', () => {
  assert.equal(entryIdOf({ fiber: { entry: { options: { id: 'compact' } } } }), 'compact')
  assert.equal(entryIdOf({ fiber: { entry: { options: { id: '' } } } }), undefined)
  assert.equal(entryIdOf({}), undefined)
})

test('resolveAgent prefers an explicit session and defaults to the newest root agent', () => {
  const first = agent('a')
  const second = agent('b')
  const ctx = { agents: { get: (id) => (id === 'a' ? first : undefined), roots: () => [first, second] } }
  assert.equal(resolveAgent(ctx, 'a'), first)
  assert.equal(resolveAgent(ctx, 'missing'), undefined)
  assert.equal(resolveAgent(ctx, ''), second)
  assert.equal(resolveAgent({}, ''), undefined)
})

test('the status endpoint reports engine availability and the routed policy', async () => {
  compactStatus.clear('a')
  const targeted = agent('a')
  const ctx = {
    agents: { get: () => targeted, roots: () => [targeted] },
    agentPresets: { serviceFor: () => ({ dshCompact: true }) },
  }
  setSharedConfig(sanitizeConfig({}))
  const handler = createStatusHandler(ctx)

  const res = makeRes()
  await handler(makeReq({ url: `${STATUS_ENDPOINT}?sessionId=a` }), res)
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.engineActive, true)
  assert.equal(body.sessionId, 'a')
  assert.equal(body.policy.thresholdRatio, DEFAULT_CONFIG.thresholdRatio)
})

test('the status endpoint never serves a non-loopback caller', async () => {
  const handler = createStatusHandler({ agents: { get: () => undefined, roots: () => [] } })
  const res = makeRes()
  await handler(makeReq({ remoteAddress: '10.0.0.7' }), res)
  assert.equal(res.status, 403)
  assert.equal(res.json().error, 'local access only')
})

test('the status endpoint rejects a mismatched origin', async () => {
  const handler = createStatusHandler({ agents: { get: () => undefined, roots: () => [] } })
  const res = makeRes()
  await handler(makeReq({ headers: { origin: 'https://evil.example', host: '127.0.0.1:13337' } }), res)
  assert.equal(res.status, 403)
  assert.equal(res.json().error, 'origin mismatch')
})

test('the status endpoint refuses methods other than GET', async () => {
  const handler = createStatusHandler({ agents: { get: () => undefined, roots: () => [] } })
  const res = makeRes()
  await handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.status, 405)
})

test('compact-now compacts through the active preset service', async () => {
  const targeted = agent('a')
  const calls = []
  const ctx = {
    agents: { get: () => targeted, roots: () => [targeted] },
    agentPresets: {
      serviceFor: () => ({
        dshCompact: true,
        compactNow: async (which, signal) => {
          calls.push({ which, aborted: signal.aborted })
          return { shadowedSeqs: [1, 2] }
        },
      }),
    },
  }
  const handler = createCompactNowHandler(ctx)
  const res = makeRes()
  await handler(makeReq({ method: 'POST', body: {} }), res)
  assert.equal(res.status, 200)
  assert.equal(res.json().compacted, true)
  assert.equal(calls.length, 1)
})

test('compact-now maps a busy agent and an inactive preset to distinct statuses', async () => {
  const targeted = agent('a')
  const busyCtx = {
    agents: { get: () => targeted, roots: () => [targeted] },
    agentPresets: {
      serviceFor: () => ({
        dshCompact: true,
        compactNow: async () => {
          const error = new Error('requires an idle agent')
          throw error
        },
      }),
    },
  }
  const busyRes = makeRes()
  await createCompactNowHandler(busyCtx)(makeReq({ method: 'POST', body: {} }), busyRes)
  assert.equal(busyRes.status, 409)
  assert.equal(busyRes.json().code, 'busy')

  const idleCtx = {
    agents: { get: () => targeted, roots: () => [targeted] },
    agentPresets: { serviceFor: () => ({ dshCompact: true }) },
  }
  const idleRes = makeRes()
  await createCompactNowHandler(idleCtx)(makeReq({ method: 'POST', body: {} }), idleRes)
  assert.equal(idleRes.status, 409)
  assert.match(idleRes.json().error, /does not use dsh-compact/)

  const missingRes = makeRes()
  await createCompactNowHandler({ agents: { get: () => undefined, roots: () => [] } })(
    makeReq({ method: 'POST', body: {} }),
    missingRes,
  )
  assert.equal(missingRes.status, 404)
})

test('the config endpoint reports the live policy and the entry namespace', async () => {
  const entryId = 'compact'
  const settings = { update: async () => {} }
  const ctx = {
    fiber: { entry: { options: { id: entryId } } },
    get: (name) => (name === 'settings' ? settings : undefined),
  }
  const config = { enabled: volatileValue(true), thresholdRatio: volatileValue(0.8) }
  const handler = createConfigHandler(ctx, config)

  const res = makeRes()
  await handler(makeReq(), res)
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.namespace, entryId)
  assert.equal(body.writable, true)
  assert.equal(body.config.thresholdRatio, 0.8)
})

test('the config endpoint writes volatile fields through the settings service', async () => {
  const writes = []
  const settings = { update: async (ns, patch) => { writes.push({ ns, patch }) } }
  const ctx = {
    fiber: { entry: { options: { id: 'compact' } } },
    get: () => settings,
  }
  const config = { thresholdRatio: volatileValue(0.8) }
  const handler = createConfigHandler(ctx, config)

  const res = makeRes()
  await handler(makeReq({ method: 'POST', body: { patch: { thresholdRatio: 0.9 } } }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(writes, [{ ns: 'compact', patch: { thresholdRatio: 0.9 } }])
})

test('the config endpoint refuses invalid patches and a missing entry', async () => {
  const settings = { update: async () => {} }
  const ctx = { fiber: { entry: { options: { id: 'compact' } } }, get: () => settings }
  const handler = createConfigHandler(ctx, {})
  const invalid = makeRes()
  await handler(makeReq({ method: 'POST', body: { patch: { thresholdRatio: 2 } } }), invalid)
  assert.equal(invalid.status, 400)

  const detached = makeRes()
  await createConfigHandler({ get: () => settings }, {})(
    makeReq({ method: 'POST', body: { patch: { enabled: false } } }),
    detached,
  )
  assert.equal(detached.status, 409)

  const noBody = makeRes()
  await handler(makeReq({ method: 'POST', body: {} }), noBody)
  assert.equal(noBody.status, 400)
})

test('refreshConfig applies volatile snapshots and keeps the previous policy on failure', () => {
  const warnings = []
  const ctx = { logger: { warn: (message) => warnings.push(message) } }
  assert.equal(refreshConfig(ctx, { thresholdRatio: volatileValue(0.8), retainRatio: volatileValue(0.2) }), true)
  assert.equal(getSharedConfig().thresholdRatio, 0.8)

  assert.equal(refreshConfig(ctx, { thresholdRatio: volatileValue(0.2) }), false)
  assert.equal(getSharedConfig().thresholdRatio, 0.8)
  assert.equal(warnings.length, 1)
  setSharedConfig(DEFAULT_CONFIG)
})

test('apply registers the local endpoints and follows volatile updates', () => {
  const routes = []
  const listeners = []
  const injects = []
  const ctx = {
    logger: { warn: () => {} },
    fiber: {},
    on: (event, callback) => {
      listeners.push({ event, callback })
      return () => {}
    },
    inject: (deps, callback) => {
      injects.push(deps)
      const child = {
        effect: (register) => register(),
        webServer: { register: (route) => routes.push(route) },
        settings: { configure: () => () => {} },
      }
      callback(child)
    },
  }
  const config = { thresholdRatio: volatileValue(0.8), retainRatio: volatileValue(0.2) }
  apply(ctx, config)

  assert.deepEqual(injects, [['settings'], ['webServer']])
  assert.deepEqual(routes.map((route) => [route.kind, route.path]), [
    ['exact', STATUS_ENDPOINT],
    ['exact', COMPACT_ENDPOINT],
    ['exact', CONFIG_ENDPOINT],
  ])
  for (const route of routes) assert.equal(typeof route.handler, 'function')
  assert.equal(getSharedConfig().thresholdRatio, 0.8)

  const listener = listeners.find((entry) => entry.event === 'loader/volatile-update')
  assert.ok(listener)
  config.thresholdRatio = volatileValue(0.9)
  listener.callback()
  assert.equal(getSharedConfig().thresholdRatio, 0.9)
  setSharedConfig(DEFAULT_CONFIG)
})
