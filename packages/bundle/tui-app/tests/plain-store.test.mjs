import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createStore, projectionsAfter } from '../src/store.ts'
import { runPlain } from '../src/plain.ts'
import { emptyTranscript, applyEvent, applyChunk } from '../src/transcript.ts'
const present = { call: name => ({ card: 'generic', title: name }), result: () => undefined }
function setup() {
  const store = createStore({ transcript: emptyTranscript(), sessionId: 's1', pending: [], attachments: [], expandedTools: false, exiting: false })
  const submitted = []; const exits = []; let count = 0
  const controller = {
    async submit(text) {
      submitted.push(text)
      store.update(state => applyEvent(state.transcript, { type: 'user/message', seq: count, surfaceOp: 'append', data: { id: `u${++count}`, source: { kind: 'user' }, content: [{ type: 'text', text }] } }, present, false))
      await new Promise(resolve => setTimeout(resolve, 5))
      store.update(state => applyEvent(state.transcript, { type: 'assistant/message', seq: count, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: `answer ${count}` }] }, stream: [] } }, present, false))
    },
    async runCommand() { store.update(state => { state.sessionId = 's2'; state.transcript = emptyTranscript() }) },
    exit(code = 0) { exits.push(code); store.update(state => { state.exiting = true }) },
  }
  return { store, controller, submitted, exits }
}
test('plain mode subscribes before opening prompt and buffers piped lines', async () => {
  const { store, controller, submitted, exits } = setup(); let output = ''
  await runPlain(store, controller, value => { output += value }, 'opening', Readable.from(['  line one  \nline two\n']))
  assert.deepEqual(submitted, ['opening', '  line one  ', 'line two'])
  assert.equal(output.match(/answer 1/g)?.length, 1)
  assert.ok(output.includes('answer 3')); assert.ok(exits.includes(0))
})
test('plain mode resumes another transcript without skipping rows from reused IDs', async () => {
  const { store, controller } = setup(); let output = ''
  await runPlain(store, controller, value => { output += value }, undefined, Readable.from(['first\n/resume other\nsecond\n']))
  assert.ok(output.includes('first')); assert.ok(output.includes('second')); assert.ok(output.includes('answer 2'))
})
test('plain mode failure requests nonzero exit and propagates error', async () => {
  const { store, controller, exits } = setup()
  controller.submit = async () => { throw new Error('rejected') }
  await assert.rejects(runPlain(store, controller, () => {}, 'opening', Readable.from([])), /rejected/)
  assert.ok(exits.includes(1))
})
test('store snapshots do not mutate previously rendered stream rows', () => {
  const { store } = setup()
  store.update(state => applyChunk(state.transcript, { type: 'text-delta', index: 0, text: 'one' }))
  const previous = store.getState()
  store.update(state => applyChunk(state.transcript, { type: 'text-delta', index: 0, text: 'two' }))
  assert.equal(previous.transcript.items[0].text, 'one')
  assert.equal(store.getState().transcript.items[0].text, 'onetwo')
})
test('coalesced changes are readable at once and announced on the next frame', async () => {
  const { store } = setup()
  let announced = 0
  store.subscribe(() => { announced++ })
  for (const text of ['one', 'two', 'three']) store.update(state => applyChunk(state.transcript, { type: 'text-delta', index: 0, text }), true)
  assert.equal(store.getState().transcript.items[0].text, 'onetwothree')
  assert.equal(announced, 0)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(announced, 1)
  // An immediate change carries the coalesced ones with it, exactly once.
  store.update(state => applyChunk(state.transcript, { type: 'text-delta', index: 0, text: '!' }), true)
  store.update(state => { state.sessionId = 's3' })
  assert.equal(announced, 2)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(announced, 2)
})

test('queue rows are read from the shared inbox projection, queued before steering', async () => {
  const { queueOf } = await import('../src/store.ts')
  const message = (id, kind, text) => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] })
  const rows = queueOf({ inbox: {
    'next-turn': [message('q1', 'user', 'later')],
    'next-step': [message('s1', 'user', 'now'), message('c1', 'runtime-context', 'ctx'), { broken: true }],
  } })
  assert.deepEqual(rows.map(row => [row.id, row.placement, row.message.content[0].text]), [['q1', 'queued', 'later'], ['s1', 'steering', 'now'], ['c1', 'context', 'ctx']])
  assert.deepEqual(queueOf({}), [])
})

test('a projection frame sets every key its event changed and keeps the rest; a baseline replaces the values', () => {
  const current = { title: 'Old', agentPreset: 'standard', inbox: { 'next-turn': [] } }
  const frame = { type: 'projection', sessionId: 'one', seq: 7, changes: [{ key: 'title', val: 'New' }, { key: 'goal', val: null }] }
  assert.deepEqual(projectionsAfter(current, frame, 'one'), { title: 'New', agentPreset: 'standard', inbox: { 'next-turn': [] }, goal: null })
  assert.deepEqual(current.title, 'Old')
  const baseline = { type: 'baseline', value: { projections: { one: { values: { title: 'Fresh' } } } } }
  assert.deepEqual(projectionsAfter(current, baseline, 'one'), { title: 'Fresh' })
  assert.deepEqual(projectionsAfter(current, baseline, 'two'), {})
})
