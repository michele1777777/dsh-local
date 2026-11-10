/** Prefill and decode speed over the latest model responses: samples from log events, the averages and their display. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyTranscript, applyEvent, SPEED_SAMPLES } from '../src/transcript.ts'
import { recentSpeed } from '../src/metrics.ts'
import { statusRow, inspectorRows } from '../src/screen.ts'
import { textOfRow } from '../src/rich-text.ts'
import { fixture } from './fixtures.mjs'

const presenters = { call: name => ({ card: 'generic', title: name }), result: () => undefined }
const event = (type, data, extra = {}) => ({ type, data, seq: 0, time: 1, ...extra })
/** One response: step start at `start`, first token `prefillMs` later, committed `decodeMs` after that. */
function respond(t, start, { prefillMs, decodeMs, input, output, replay = false }) {
  applyEvent(t, event('step/start', { turn: 1, step: 1 }, { time: start }), presenters, replay)
  const first = start + prefillMs
  const stream = [{ type: 'text-chunks', time0: first, index: 0, dt: [], texts: ['ok'] }]
  applyEvent(t, event('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] }, stream, usage: { inputTokens: input, outputTokens: output } },
    { surfaceOp: 'append', time: first + decodeMs }), presenters, replay)
}

test('each committed response adds its prefill and decode timings; the averages weigh tokens over time', () => {
  const t = emptyTranscript()
  respond(t, 1000, { prefillMs: 2000, decodeMs: 1000, input: 400, output: 30 })
  respond(t, 9000, { prefillMs: 500, decodeMs: 4000, input: 100, output: 90 })
  assert.deepEqual(t.speedSamples, [
    { prefillTokens: 400, prefillMs: 2000, decodeTokens: 30, decodeMs: 1000 },
    { prefillTokens: 100, prefillMs: 500, decodeTokens: 90, decodeMs: 4000 },
  ])
  // (400 + 100) tokens / 2.5 s and (30 + 90) tokens / 5 s, not the mean of the per-response rates.
  assert.deepEqual(recentSpeed(t), { prefill: 200, decode: 24 })
})

test('only the latest responses count, replayed history included', () => {
  const t = emptyTranscript()
  respond(t, 0, { prefillMs: 1000, decodeMs: 1000, input: 9000, output: 9000, replay: true })
  for (let index = 0; index < SPEED_SAMPLES; index++) respond(t, 10_000 * (index + 1), { prefillMs: 1000, decodeMs: 2000, input: 300, output: 50 })
  assert.equal(t.speedSamples.length, SPEED_SAMPLES)
  assert.deepEqual(recentSpeed(t), { prefill: 300, decode: 25 })
})

test('a response without a step start, a first token or usage adds no sample, and an unmeasured phase is left out', () => {
  const t = emptyTranscript()
  applyEvent(t, event('assistant/message', { message: { content: [{ type: 'text', text: 'a' }] }, stream: [{ type: 'text-chunks', time0: 5, index: 0, dt: [], texts: ['a'] }], usage: { inputTokens: 1, outputTokens: 1 } },
    { surfaceOp: 'append', time: 9 }), presenters, false)
  applyEvent(t, event('step/start', { turn: 1, step: 1 }, { time: 10 }), presenters, false)
  applyEvent(t, event('assistant/message', { message: { content: [{ type: 'text', text: 'b' }] }, stream: [], usage: { inputTokens: 1, outputTokens: 1 } },
    { surfaceOp: 'append', time: 20 }), presenters, false)
  applyEvent(t, event('step/start', { turn: 1, step: 2 }, { time: 30 }), presenters, false)
  applyEvent(t, event('assistant/message', { message: { content: [{ type: 'text', text: 'c' }] }, stream: [{ type: 'text-chunks', time0: 40, index: 0, dt: [], texts: ['c'] }] },
    { surfaceOp: 'append', time: 50 }), presenters, false)
  assert.equal(t.speedSamples, undefined)
  assert.deepEqual(recentSpeed(t), {})
  // A fully cached prompt has no prefill tokens to time.
  respond(t, 100, { prefillMs: 200, decodeMs: 1000, input: 0, output: 40 })
  assert.deepEqual(recentSpeed(t), { decode: 40 })
})

test('the status line shows both speeds, drops them before jobs and the timer, and the context panel explains them', () => {
  const t = emptyTranscript()
  respond(t, 1000, { prefillMs: 2000, decodeMs: 1000, input: 400, output: 30 })
  respond(t, 9000, { prefillMs: 500, decodeMs: 4000, input: 100, output: 90 })
  const state = fixture({ transcript: t })
  assert.match(textOfRow(statusRow(state, 140, 0, 0)), /·  prefill 200 · decode 24\.0 tok\/s/)
  assert.doesNotMatch(textOfRow(statusRow(fixture(), 140, 0, 0)), /tok\/s/)
  // Narrower, the keys control and the model leave first, then the speeds.
  const narrow = textOfRow(statusRow(state, 72, 0, 0))
  assert.doesNotMatch(narrow, /deepseek\/reasoner|\? keys/)
  assert.match(narrow, /tok\/s/)
  assert.doesNotMatch(textOfRow(statusRow(state, 50, 0, 0)), /tok\/s/)
  const panel = inspectorRows(state, 'context', [], 100).map(textOfRow).join('\n')
  assert.match(panel, /Speed · latest 10 responses/)
  assert.match(panel, /Prefill {2}200 tok\/s/)
  assert.match(panel, /Decode {2}24\.0 tok\/s/)
})
