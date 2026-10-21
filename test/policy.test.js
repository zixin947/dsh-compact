import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  compactStatus,
  resolvePolicy,
  routedTargetOf,
  sanitizeConfig,
  sessionIdOf,
  setSharedConfig,
  unwrapConfig,
} from '../lib/policy.js'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function volatileValue(value) {
  return Object.freeze({ get: () => value, [VOLATILE_WRITE]: () => {} })
}

test('sanitizeConfig fills defaults and freezes the result', () => {
  const config = sanitizeConfig()
  assert.equal(config.enabled, true)
  assert.equal(config.thresholdRatio, DEFAULT_CONFIG.thresholdRatio)
  assert.equal(config.retainRatio, DEFAULT_CONFIG.retainRatio)
  assert.equal(config.recoverOnOverflow, true)
  assert.equal(config.maxOverflowRetries, 1)
  assert.deepEqual(config.modelPolicies, [])
  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.modelPolicies))
})

test('sanitizeConfig rejects cross-field and out-of-range values', () => {
  assert.throws(() => sanitizeConfig({ thresholdRatio: 0.5, retainRatio: 0.5 }), /retainRatio must be less than thresholdRatio/)
  assert.throws(() => sanitizeConfig({ thresholdRatio: 0.99 }), /between 0.5 and 0.95/)
  assert.throws(() => sanitizeConfig({ retainRatio: 0.01 }), /between 0.05 and 0.5/)
  assert.throws(() => sanitizeConfig({ maxOverflowRetries: 2 }), /must be 0 or 1/)
  assert.throws(() => sanitizeConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => sanitizeConfig({ modelPolicies: {} }), /modelPolicies must be an array/)
})

test('sanitizeConfig validates model policies', () => {
  const config = sanitizeConfig({
    modelPolicies: [
      { provider: 'deepseek-account', model: 'deepseek-flash', thresholdRatio: 0.8 },
    ],
  })
  assert.equal(config.modelPolicies.length, 1)
  assert.throws(() => sanitizeConfig({ modelPolicies: [{ provider: 'deepseek-account' }] }), /requires provider and model/)
  assert.throws(
    () => sanitizeConfig({
      modelPolicies: [
        { provider: 'p', model: 'm' },
        { provider: 'p', model: 'm' },
      ],
    }),
    /duplicate model policy/,
  )
  assert.throws(
    () => sanitizeConfig({ modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.5, retainRatio: 0.5 }] }),
    /retainRatio must be less than thresholdRatio/,
  )
})

test('resolvePolicy applies the exact provider/model override', () => {
  const config = sanitizeConfig({
    thresholdRatio: 0.75,
    modelPolicies: [{ provider: 'deepseek-account', model: 'deepseek-flash', thresholdRatio: 0.9, enabled: false }],
  })
  const matched = resolvePolicy(config, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(matched.thresholdRatio, 0.9)
  assert.equal(matched.enabled, false)
  const unmatched = resolvePolicy(config, { provider: 'deepseek-account', model: 'other' })
  assert.equal(unmatched.thresholdRatio, 0.75)
  assert.equal(unmatched.enabled, true)
  assert.equal(resolvePolicy(config, undefined).thresholdRatio, 0.75)
})

test('unwrapConfig resolves volatile references and leaves plain values alone', () => {
  const unwrapped = unwrapConfig({
    enabled: volatileValue(false),
    thresholdRatio: 0.8,
    modelPolicies: volatileValue([{ provider: 'p', model: 'm' }]),
  })
  assert.deepEqual(unwrapped, {
    enabled: false,
    thresholdRatio: 0.8,
    modelPolicies: [{ provider: 'p', model: 'm' }],
  })
  assert.deepEqual(unwrapConfig(undefined), {})
  assert.deepEqual(unwrapConfig([1, 2]), [1, 2])
})

test('an invalid volatile snapshot is rejected instead of silently applied', () => {
  const before = setSharedConfig({ thresholdRatio: 0.75 })
  const rejected = (() => {
    try {
      setSharedConfig(unwrapConfig({ thresholdRatio: volatileValue(0.2) }))
      return false
    } catch {
      return true
    }
  })()
  assert.equal(rejected, true)
  assert.equal(resolvePolicy(before).thresholdRatio, 0.75)
  setSharedConfig(DEFAULT_CONFIG)
})

test('routedTargetOf prefers the routed request header then the agent options', () => {
  const routed = {
    session: { requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }) },
    options: { provider: 'fallback', model: 'fallback' },
  }
  assert.deepEqual(routedTargetOf(routed), { provider: 'deepseek-account', model: 'deepseek-flash' })

  const fallback = { session: { requestHeader: () => undefined }, options: { provider: 'p', model: 'm' } }
  assert.deepEqual(routedTargetOf(fallback), { provider: 'p', model: 'm' })
  assert.equal(routedTargetOf({}), undefined)
  assert.equal(routedTargetOf(undefined), undefined)
})

test('sessionIdOf accepts the agent id, session id, and header id', () => {
  assert.equal(sessionIdOf({ id: 'agent-1' }), 'agent-1')
  assert.equal(sessionIdOf({ session: { id: 'session-1' } }), 'session-1')
  assert.equal(sessionIdOf({ session: { header: { id: 'header-1' } } }), 'header-1')
  assert.equal(sessionIdOf(undefined), '')
})

test('compactStatus stores per-session patches and clears them', () => {
  compactStatus.clear('s1')
  assert.deepEqual(compactStatus.get('s1'), { sessionId: 's1', state: 'idle', active: false, updatedAt: null })

  const next = compactStatus.set('s1', { state: 'measuring', active: true })
  assert.equal(next.state, 'measuring')
  assert.equal(next.active, true)
  assert.notEqual(next.updatedAt, null)
  assert.equal(compactStatus.get('s1').state, 'measuring')

  compactStatus.clear('s1')
  assert.equal(compactStatus.get('s1').state, 'idle')
  assert.deepEqual(compactStatus.set('', { state: 'measuring' }), {
    sessionId: '',
    state: 'idle',
    active: false,
    updatedAt: null,
  })
})
