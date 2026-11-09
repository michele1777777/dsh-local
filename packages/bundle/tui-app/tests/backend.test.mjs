import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TerminalBackend, promptRequest } from '../src/backend.ts'

const sessionId = 'session-shared'
test('prompt envelope equals the Web request shape and preserves raw content', () => {
  const text = '  first\n\tsecond  '
  const file = { type: 'file', receiptId: 'receipt-1' }
  const image = { type: 'image', mediaType: 'image/png', data: 'AA==', name: 'demo.png' }
  assert.deepEqual(promptRequest(sessionId, text, 'UTC', 'steer', [image, file], 'request-1'), {
    requestId: 'request-1', sessionId, mode: 'steer', content: [{ type: 'text', text }, image, file], clientTimeZone: 'UTC',
  })
  assert.equal(promptRequest(sessionId, '', 'UTC', 'queue', [file]).content.length, 1)
  assert.notEqual(promptRequest(sessionId, 'x', 'UTC').requestId, promptRequest(sessionId, 'x', 'UTC').requestId)
})
test('create/resume/prompt/select delegate to the exact shared service instance', async () => {
  const calls = []
  const agent = { id: sessionId }
  const api = {
    create: async value => { calls.push(['create', value]); return { sessionId } },
    resolveAgent: async id => { calls.push(['resume', id]); return { agent } },
    prompt: async (value, signal) => { calls.push(['prompt', value, signal]); return { accepted: true } },
    selectModel: async value => { calls.push(['select', value]); return { selected: { provider: value.provider, model: value.model } } },
  }
  const backend = new TerminalBackend({ sessionController: api }, 'UTC')
  assert.equal(backend.api, api)
  assert.equal(await backend.create('/work', 'standard'), agent)
  assert.deepEqual(calls.slice(0, 2), [['create', { cwd: '/work', agentPreset: 'standard' }], ['resume', sessionId]])
  const signal = new AbortController().signal
  await backend.prompt(agent, ' x ', signal)
  assert.equal(calls[2][1].content[0].text, ' x '); assert.equal(calls[2][2], signal)
  await backend.select(agent, { provider: 'p', model: 'm' })
  assert.deepEqual(calls[3], ['select', { sessionId, provider: 'p', model: 'm' }])
})
test('admission and resume errors propagate instead of becoming phantom successes', async () => {
  const error = new Error('admission rejected')
  const backend = new TerminalBackend({ sessionController: { resolveAgent: async () => ({ error }), prompt: async () => { throw error } } }, 'UTC')
  await assert.rejects(backend.resume(sessionId), error)
  await assert.rejects(backend.prompt({ id: sessionId }, 'x', new AbortController().signal), error)
})
test('selection display follows the Agent model owner, then the global default', () => {
  let current = { provider: 'pending', model: 'next' }
  const backend = new TerminalBackend({ sessionController: {}, agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'default' }) } }, 'UTC')
  const agent = { model: { current: () => current } }
  assert.equal(backend.selection(agent), current)
  current = { provider: 'old', model: 'old', reasoningEffort: 'high' }
  assert.equal(backend.selection(agent).reasoningEffort, 'high')
  current = undefined
  assert.equal(backend.selection(agent).provider, 'default')
})
