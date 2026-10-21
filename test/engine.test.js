import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import DshCompactEngine, { summarizeWithToolFreeFallback } from '../lib/engine.js'

const EMPTY_SUMMARY_ERROR = 'summarization produced no text summary content'

test('the compact engine reuses the official backend contract', () => {
  assert.deepEqual(DshCompactEngine.inject, BasicCompactionEngine.inject)
  assert.equal(DshCompactEngine.Config, BasicCompactionEngine.Config)
  for (const method of ['compactIfNeeded', 'compactNow', 'summarize', 'policyFor', 'withPolicySnapshot', 'currentConfig']) {
    assert.equal(typeof DshCompactEngine.prototype[method], 'function', `${method} must stay overridable`)
  }
})

test('summarization passes the original input through when the model answers', async () => {
  const seen = []
  const result = await summarizeWithToolFreeFallback(
    async (input) => {
      seen.push(input)
      return { text: ['summary'] }
    },
    { system: 'sys', tools: ['tool'], messages: ['m'] },
  )
  assert.deepEqual(result, { text: ['summary'] })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { system: 'sys', tools: ['tool'], messages: ['m'] })
})

test('an empty summary retries once without the agent system prompt and tools', async () => {
  const seen = []
  const retries = []
  const result = await summarizeWithToolFreeFallback(
    async (input) => {
      seen.push(input)
      if (seen.length === 1) throw new Error(EMPTY_SUMMARY_ERROR)
      return { text: ['retried'] }
    },
    { system: 'sys', tools: ['tool'], messages: ['m'] },
    (error) => retries.push(error.message),
  )
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0], { system: 'sys', tools: ['tool'], messages: ['m'] })
  assert.deepEqual(seen[1], { messages: ['m'] })
  assert.deepEqual(result, { text: ['retried'] })
  assert.deepEqual(retries, [EMPTY_SUMMARY_ERROR])
})

test('other summarization failures are not retried', async () => {
  let calls = 0
  await assert.rejects(
    summarizeWithToolFreeFallback(async () => {
      calls += 1
      throw new Error('provider refused the request')
    }, { messages: [] }),
    /provider refused the request/,
  )
  assert.equal(calls, 1)
})
