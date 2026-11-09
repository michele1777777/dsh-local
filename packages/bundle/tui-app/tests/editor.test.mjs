import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edit, editorAtEnd, insertText, moveLine, previousBoundary, nextBoundary, windowAround } from '../src/editor.ts'
import { wrapEditor, cellWidth, liveTail } from '../src/layout.ts'
import { safeText, displayTree, contentSummary } from '../src/terminal.ts'

test('editing inserts at the cursor without trimming whitespace', () => {
  const at = edit(editorAtEnd('  abc  '), '', { leftArrow: true })
  assert.deepEqual(insertText(at, 'Z'), { text: '  abc Z ', cursor: 7 })
})
test('Backspace removes an entire emoji grapheme; Delete removes forward', () => {
  const text = 'a👨‍👩‍👧‍👦éb'
  const end = text.length - 1
  assert.equal(edit({ text, cursor: end }, '', { backspace: true }).text, 'a👨‍👩‍👧‍👦b')
  assert.equal(edit({ text, cursor: 1 }, '', { delete: true }).text, 'aéb')
  assert.equal(previousBoundary('👍🏽', 4), 0)
  assert.equal(nextBoundary('👍🏽x', 0), 4)
})
test('Home/End and Ctrl+A/E are logical-line operations', () => {
  const state = { text: 'first\nsecond\nthird', cursor: 8 }
  assert.equal(edit(state, '', { home: true }).cursor, 6)
  assert.equal(edit(state, 'e', { ctrl: true }).cursor, 12)
})
test('word deletion and kill-to-end preserve remaining lines', () => {
  assert.equal(edit(editorAtEnd('one two'), 'w', { ctrl: true }).text, 'one ')
  assert.equal(edit({ text: 'one two\nlast', cursor: 4 }, 'k', { ctrl: true }).text, 'one \nlast')
})
test('modified enter and Ctrl+J insert, never submit', () => {
  assert.equal(edit(editorAtEnd('x'), '', { return: true, meta: true }).text, 'x\n')
  assert.equal(edit(editorAtEnd('x'), 'j', { ctrl: true }).text, 'x\n')
  assert.equal(edit(editorAtEnd('x'), '', { return: true }).text, 'x')
})
test('paste preserves lines, tabs and indentation; normalizes CRLF', () => {
  assert.equal(insertText(editorAtEnd(''), '  a\r\n\tb\r').text, '  a\n\tb\n')
})
test('multiline cursor stays on grapheme boundaries and yields to history only at edges', () => {
  assert.equal(moveLine({ text: '\nhello', cursor: 0 }, -1), undefined)
  assert.equal(moveLine({ text: '\nhello', cursor: 0 }, 1).cursor, 1)
  assert.equal(moveLine({ text: 'abc\n😀d', cursor: 1 }, 1).cursor, 4)
  assert.equal(moveLine({ text: 'abc\nxy', cursor: 6 }, 1), undefined)
})
test('long pickers keep selection on screen', () => {
  const rows = Array.from({ length: 50 }, (_, i) => i)
  for (let index = 0; index < rows.length; index++) assert.ok(windowAround(rows, index, 7).items.includes(index))
})
test('wrapping preserves source offsets and wide graphemes', () => {
  assert.equal(cellWidth('界'), 2); assert.equal(cellWidth('👩‍💻'), 2)
  const lines = wrapEditor('abcd界ef\nxy', 4)
  assert.deepEqual(lines.map(line => line.text), ['abcd', '界ef', 'xy'])
  assert.equal(lines[2].start, 8)
  assert.equal(liveTail('1\n2\n3\n4', 80, 2).text, '3\n4')
})
test('terminal escapes and bidirectional spoofing are removed only in presentation', () => {
  const raw = 'ok\x1b]52;c;Zm9v\x07\x1b[2J\x1b[31mred\x1b[0m\u202e!'
  assert.equal(safeText(raw), 'okred!')
  const source = { content: [raw] }; const view = displayTree(source)
  assert.equal(source.content[0], raw); assert.equal(view.content[0], 'okred!')
})

test('queue previews show attachment labels, never inline binary payloads', () => {
  const summary = contentSummary([{ type: 'text', text: '  exact text ' }, { type: 'image', name: 'preview.png', data: 'SECRETBASE64' }, { type: 'file', receiptId: 'SECRETRECEIPT' }])
  assert.equal(summary, '  exact text \n[image: preview.png]\n[file]')
  assert.ok(!summary.includes('SECRET'))
})

const { selectionOf } = await import('../src/editor.ts')
const selected = (text, anchor, cursor) => ({ text, cursor, anchor })
test('a draft selection is the span between anchor and cursor, in either direction', () => {
  assert.deepEqual(selectionOf(selected('fix the phrase', 4, 7)), { start: 4, end: 7 })
  assert.deepEqual(selectionOf(selected('fix the phrase', 7, 4)), { start: 4, end: 7 })
  assert.equal(selectionOf(selected('fix', 2, 2)), undefined)
  assert.equal(selectionOf({ text: 'fix', cursor: 1 }), undefined)
})
test('Backspace and Delete remove the selected text', () => {
  assert.deepEqual(edit(selected('fix the phrase', 3, 7), '', { backspace: true }), { text: 'fix phrase', cursor: 3 })
  assert.deepEqual(edit(selected('fix the phrase', 7, 3), '', { delete: true }), { text: 'fix phrase', cursor: 3 })
})
test('typing, a newline, or a paste replaces the selection', () => {
  assert.deepEqual(edit(selected('fix the phrase', 4, 7), 'a', {}), { text: 'fix a phrase', cursor: 5 })
  assert.deepEqual(edit(selected('fix the phrase', 4, 7), 'j', { ctrl: true }), { text: 'fix \n phrase', cursor: 5 })
  assert.deepEqual(insertText(selected('fix the phrase', 4, 7), 'my'), { text: 'fix my phrase', cursor: 6 })
})
test('arrows collapse the selection to the side they point to; other keys drop it', () => {
  assert.deepEqual(edit(selected('fix the phrase', 7, 4), '', { leftArrow: true }), { text: 'fix the phrase', cursor: 4 })
  assert.deepEqual(edit(selected('fix the phrase', 4, 7), '', { rightArrow: true }), { text: 'fix the phrase', cursor: 7 })
  assert.deepEqual(edit(selected('fix the phrase', 4, 7), '', { end: true }), { text: 'fix the phrase', cursor: 14 })
  assert.deepEqual(edit(selected('fix the phrase', 4, 7), '', { escape: true }), { text: 'fix the phrase', cursor: 7 })
})
