import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./ui-loader.mjs', import.meta.url)
const { App } = await import('../src/app.tsx')
const { createHarness } = await import('./ui-harness.mjs')
const { createStore } = await import('../src/store.ts')
const { mergeCommands } = await import('../src/commands.ts')
const { textOfRow } = await import('../src/rich-text.ts')
const { anchorAt, promptAbove, promptAnchor, promptBelow, promptMarks, topOf } = await import('../src/viewport.ts')
const { fixture } = await import('./fixtures.mjs')

function setup(overrides = {}, columns = 80, height = 24) {
  const store = createStore(fixture(overrides)), calls = { submit: [], commands: [], sendQueue: 0, cancel: 0, errors: [] }
  const controller = {
    async submit(text, gesture = 'enter') { calls.submit.push([text, gesture]) }, async runCommand(line) { calls.commands.push(line) },
    async sendQueue() { calls.sendQueue++ },
    cancel() { calls.cancel++ }, exit() {}, commands() { return mergeCommands([]) }, answerApproval() {}, answerQuestion() {},
    hint(text) { store.update((s) => { s.hint = text }) }, closePicker() {}, report(error) { calls.errors.push(error.message) },
  }
  return { h: createHarness(App, store, controller, columns, height), store, calls, controller }
}
const queued = (text, placement = 'queued') => ({ id: `q-${text}`, placement, message: { id: `q-${text}`, content: [{ type: 'text', text }] } })

test('a turn in progress: Enter steers it, Tab queues for the next turn', async () => {
  const { h, calls } = setup({ status: 'running' })
  try {
    assert.match(h.text(), /Enter steers this turn · Tab queues for the next one/)
    await h.paste('look at the failing test first'); await h.key('', { return: true })
    await h.paste('then update the changelog'); await h.key('\t', { tab: true })
    assert.deepEqual(calls.submit, [['look at the failing test first', 'enter'], ['then update the changelog', 'queue']])
  } finally { h.dispose() }
})

test('at idle Tab never sends and Enter starts a turn', async () => {
  const { h, calls } = setup()
  try {
    assert.match(h.text(), /Ask anything/)
    await h.paste('draft'); await h.key('\t', { tab: true })
    assert.deepEqual(calls.submit, [])
    await h.key('', { return: true })
    assert.deepEqual(calls.submit, [['draft', 'enter']])
  } finally { h.dispose() }
})

test('an empty Enter sends parked queue rows; without a queue it does nothing', async () => {
  const parked = setup({ queue: [queued('left after Ctrl+C')] })
  try {
    assert.match(parked.h.text(), /^ {2}1 next turn {2}left after Ctrl\+C +×$/mu)
    await parked.h.key('', { return: true })
    assert.equal(parked.calls.sendQueue, 1)
    assert.deepEqual(parked.calls.submit, [])
  } finally { parked.h.dispose() }
  const running = setup({ status: 'running', queue: [queued('next', 'steering')] })
  try { assert.match(running.h.text(), /^ {2}1 this turn {2}next +×$/mu) } finally { running.h.dispose() }
  const empty = setup()
  try { await empty.h.key('', { return: true }); assert.equal(empty.calls.sendQueue, 0); assert.deepEqual(empty.calls.submit, []) } finally { empty.h.dispose() }
})

/* Sticky prompt header. Rows: [blank, › first line, more lines] per prompt, padding between. */
const doc = (layout) => layout.flatMap(([id, kind, size]) => kind === 'user'
  ? [{ spans: [], itemId: id, heading: false }, { spans: [], itemId: id, heading: true }, { spans: [], itemId: id }]
  : Array.from({ length: size }, (_, index) => ({ spans: [], itemId: id, heading: index === 0 })))

test('the header names the latest prompt at or above the top row, and jumps walk back', () => {
  const rows = doc([['u1', 'user'], ['a1', 'assistant', 20], ['u2', 'user'], ['a2', 'assistant', 20], ['u3', 'user'], ['a3', 'assistant', 20]])
  const marks = promptMarks(rows, new Set(['u1', 'u2', 'u3']))
  assert.deepEqual(marks, [{ itemId: 'u1', first: 0, heading: 1 }, { itemId: 'u2', first: 23, heading: 24 }, { itemId: 'u3', first: 46, heading: 47 }])
  assert.equal(promptAbove(marks, 0), undefined)
  assert.equal(promptAbove(marks, 1)?.itemId, 'u1')
  assert.equal(promptAbove(marks, 30)?.itemId, 'u2')
  // A jump shows the prompt from its spacer row: the header moves to the one before.
  const height = 10
  let top = topOf(rows, height, null)
  assert.equal(promptAbove(marks, top)?.itemId, 'u3')
  for (const expected of ['u2', 'u1', undefined]) {
    top = topOf(rows, height, promptAnchor(rows, height, promptAbove(marks, top)))
    assert.equal(promptAbove(marks, top)?.itemId, expected)
  }
  assert.equal(top, 0)
  assert.equal(promptBelow(marks, top)?.itemId, 'u2')
  assert.equal(promptBelow(marks, 46), undefined)
  // A prompt on the live last page is reached by following the tail.
  const short = doc([['u1', 'user'], ['a1', 'assistant', 20], ['u2', 'user'], ['a2', 'assistant', 3]])
  const shortMarks = promptMarks(short, new Set(['u1', 'u2']))
  assert.equal(promptAnchor(short, height, shortMarks[1]), null)
  assert.deepEqual(promptAnchor(short, height, shortMarks[0]), anchorAt(short, 0))
  assert.deepEqual(promptAnchor(rows, height, marks[1]), anchorAt(rows, 23))
})

function conversation() {
  const items = []
  for (const n of [1, 2, 3]) {
    items.push({ kind: 'user', id: `user-${n}`, text: `PROMPT-${n} please`, settled: true, queued: false })
    items.push({ kind: 'assistant', id: `assistant-${n}`, reasoning: '', text: Array.from({ length: 30 }, (_, i) => `- A${n}-${i}`).join('\n'), settled: true })
  }
  const transcript = fixture().transcript
  transcript.items = items
  return transcript
}
const headerLine = h => h.rows().findIndex(value => textOfRow(value).startsWith('↑ › '))
const click = async (h, y) => { await h.key(`[<0;5;${y + 1}M`); await h.key(`[<0;5;${y + 1}m`) }

test('clicking the sticky header jumps to its prompt; repeated clicks walk back', async () => {
  const { h } = setup({ transcript: conversation() })
  try {
    let y = headerLine(h)
    assert.ok(y >= 0)
    assert.match(textOfRow(h.rows()[y]), /PROMPT-3 please.*prompt 3\/3/)
    await click(h, y)
    // PROMPT-3 now opens the viewport, right under a header naming PROMPT-2.
    y = headerLine(h)
    assert.match(textOfRow(h.rows()[y]), /PROMPT-2 please.*prompt 2\/3/)
    assert.match(textOfRow(h.rows()[y + 1]), /^▌ PROMPT-3 please/)
    await click(h, y)
    assert.match(textOfRow(h.rows()[headerLine(h)]), /PROMPT-1 please/)
    await click(h, headerLine(h))
    // The first prompt has nothing above it: the header disappears.
    assert.equal(headerLine(h), -1)
    assert.match(h.text(), /PROMPT-1 please/)
  } finally { h.dispose() }
})

test('Alt+↑ and Alt+↓ walk prompts from the keyboard and rejoin the live tail', async () => {
  const { h } = setup({ transcript: conversation() })
  try {
    await h.key('', { upArrow: true, meta: true })
    assert.match(textOfRow(h.rows()[headerLine(h)]), /PROMPT-2/)
    await h.key('', { upArrow: true, meta: true })
    assert.match(textOfRow(h.rows()[headerLine(h)]), /PROMPT-1/)
    await h.key('', { downArrow: true, meta: true })
    assert.match(textOfRow(h.rows()[headerLine(h)]), /PROMPT-2/)
    await h.key('', { downArrow: true, meta: true })
    await h.key('', { downArrow: true, meta: true })
    assert.match(h.text(), /A3-29/)
    assert.doesNotMatch(h.text(), /History /)
  } finally { h.dispose() }
})

test('no header without a prompt above the viewport', async () => {
  const transcript = fixture().transcript
  transcript.items = [{ kind: 'user', id: 'user-1', text: 'ONLY PROMPT', settled: true, queued: false }]
  const { h } = setup({ transcript })
  try { assert.equal(headerLine(h), -1); assert.match(h.text(), /ONLY PROMPT/) } finally { h.dispose() }
})


test('Ctrl+Enter submits an immediate interrupt gesture; empty Ctrl+Enter sends pending steering', async () => {
  const { h, calls, store } = setup({ status: 'running' })
  try {
    await h.paste('read this now'); await h.key('', { return: true, ctrl: true })
    assert.deepEqual(calls.submit, [['read this now', 'interrupt']])
    store.update(state => { state.queue = [queued('read this now', 'steering')] })
    await h.flush()
    await h.key('', { return: true, ctrl: true })
    assert.equal(calls.sendQueue, 1)
  } finally { h.dispose() }
})

test('second Enter waits for in-flight admission, then sends the accepted message once', async () => {
  const { h, calls, controller } = setup({ status: 'running' })
  let accept
  controller.submit = () => new Promise(resolve => { accept = resolve })
  try {
    await h.paste('correction'); await h.key('', { return: true })
    await h.key('', { return: true }); await h.key('', { return: true })
    assert.equal(calls.sendQueue, 0)
    accept(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.sendQueue, 1)
  } finally { h.dispose() }
})

test('failed admission retains the draft and does not interrupt; switching sessions does not send another queue', async () => {
  for (const fail of [false, true]) {
    const { h, calls, store, controller } = setup({ status: 'running' })
    let settle
    controller.submit = () => new Promise((resolve, reject) => { settle = () => fail ? reject(new Error('rejected')) : resolve() })
    try {
      await h.paste('correction'); await h.key('', { return: true }); await h.key('', { return: true })
      if (!fail) store.update(state => { state.sessionId = 'other-session' })
      settle(); await h.flush()
      assert.equal(calls.sendQueue, 0)
      if (fail) { assert.match(h.text(), /correction/); assert.deepEqual(calls.errors, ['rejected']) }
    } finally { h.dispose() }
  }
})
