import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readDecision, reviewOptions } from '../src/reviewer.ts'
export function chunks(text = '{"decision":"allow","risk":"low","reason":"Scoped read"}') {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
async function* stream(values) { yield* values }
const signal = () => new AbortController().signal
test('review uses a separate same-model request with no agent session route or tools', () => {
  const input = { provider: 'local', model: 'reasoner', text: '{"action":"x"}' }
  const output = reviewOptions(input, { maxOutputTokens: 99, maxOutputChars: 4096 }, signal())
  assert.equal(output.provider, input.provider)
  assert.equal(output.model, input.model)
  assert.equal(output.messages.length, 1)
  assert.equal(output.messages[0].content[0].text, input.text)
  assert.deepEqual(output.tools, [])
  assert.equal(output.sessionId, undefined)
  assert.equal(output.maxTokens, 99)
  // Request-only input: never persisted, so no durable id or message source.
  assert.equal(output.messages[0].role, 'user')
  assert.equal(output.messages[0].source, undefined)
  assert.equal(output.messages[0].id, undefined)
})
test('real core assembler accepts one complete stop', async () => {
  assert.equal((await readDecision(stream(chunks()), 10000, signal())).decision, 'allow')
})
test('reasoning is consumed privately, never treated as authorization JSON', async () => {
  const data = [{ type: 'block-start', index: 1, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 1, text: 'private' }, { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'private' } }, ...chunks()]
  assert.equal((await readDecision(stream(data), 10000, signal())).reason, 'Scoped read')
})
for (const [label, data] of [
  ['missing finish', chunks().slice(0,-1)],
  ['truncated output', [...chunks().slice(0,-1), { type: 'finish', reason: { kind: 'length' } }]],
  ['data after finish', [...chunks(), { type: 'text-delta', index: 0, text: 'trailing' }]],
  ['tool call', [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'x', name: 'bash', arguments: '{}' } }, { type: 'finish', reason: { kind: 'stop' } }]],
  ['multiple final blocks', [...chunks().slice(0,-1), { type: 'block-end', index: 1, block: { type: 'text', text: 'second' } }, { type: 'finish', reason: { kind: 'stop' } }]],
]) test(`review refuses ${label}`, async () => { await assert.rejects(readDecision(stream(data), 10000, signal())) })
test('response size includes reasoning and chunks, not only final text', async () => { await assert.rejects(readDecision(stream(chunks()), 10, signal()), /size limit/) })
test('cancelled review cannot grant', async () => { const controller = new AbortController(); controller.abort(); await assert.rejects(readDecision(stream(chunks()), 10000, controller.signal)) })
