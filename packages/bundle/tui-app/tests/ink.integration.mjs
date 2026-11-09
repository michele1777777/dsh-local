/** Real React/Ink paint checks. Requires pnpm install; never uses ui-loader. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToString } from 'ink'
import { Screen } from '../src/components.tsx'
import { itemRows } from '../src/document.ts'
import { fitScreen, approvalDetails, approvalControls, panelLayout } from '../src/screen.ts'
import { widthOf } from '../src/rich-text.ts'
import { safeText } from '../src/terminal.ts'
import { conversation, approval } from './fixtures.mjs'
for (const width of [29,40,80,120]) test(`real Ink paints complete document rows at ${width} columns`, () => {
  const rows=conversation().flatMap(item=>itemRows(item,{width,expanded:true,overrides:{}}))
  const rendered=safeText(renderToString(createElement(Screen,{rows,width,theme:'mono'}),{columns:width+1}))
  assert.match(rendered,/Authentication fixed/)
  assert.doesNotMatch(rendered,/\[object Object\]/)
  for(const line of rendered.split('\n'))assert.ok(widthOf(line)<=width)
})
test('real Ink retains permission actions at the smallest supported size', () => {
  const width=28,height=8
  const frame=panelLayout('Permission',approvalDetails(approval(),width),approvalControls(width,false,1),width,height,0)
  const rendered=safeText(renderToString(createElement(Screen,{rows:fitScreen(frame.rows,width,height),width,theme:'mono'}),{columns:width+1}))
  assert.match(rendered,/Reject/);assert.match(rendered,/Allow once/)
})

// New interaction surfaces still need the real painter, not only the hook harness.
const { row, textOfRow } = await import('../src/rich-text.ts')
const { joinPanes, paneWidths } = await import('../src/panes.ts')
const { linkRows } = await import('../src/links.ts')
for (const columns of [40, 80, 160]) test(`real Ink keeps Copy and pane widths at ${columns} columns`, () => {
  const width = columns - 1
  const item = { kind: 'assistant', id: 'paint-copy', text: '```powershell\nInvoke-RestMethod -Uri "https://api.example.test/v1" `\n  -Method Get\n```', reasoning: '', settled: true }
  const rows = itemRows(item, { width, expanded: true, overrides: {} })
  const linked = linkRows(rows, '/workspace', true)
  const painted = safeText(renderToString(createElement(Screen, { rows: linked, width, theme: 'mono' }), { columns }))
  assert.match(painted, /─ Copy ─╮/)
  assert.doesNotMatch(painted, /\[object Object\]/)
  assert.ok(painted.split('\n').every(line => widthOf(line) <= width))
  const panes = paneWidths(width, 'auto')
  if (panes) {
    const joined = joinPanes([row('Conversation')], [row('Selected tool details')], panes, 8)
    const text = safeText(renderToString(createElement(Screen, { rows: joined, width, theme: 'mono' }), { columns }))
    assert.match(text, /Conversation/); assert.match(text, /Selected tool details/)
    assert.ok(text.split('\n').every(line => widthOf(line) <= width))
    assert.ok(joined.every(value => widthOf(textOfRow(value)) <= width))
  }
})
const { promptHeader } = await import('../src/screen.ts')
for (const width of [28, 80]) test(`real Ink paints the sticky prompt header within ${width} columns`, () => {
  const header = promptHeader('Fix the login flow\nand then  run   every test 👩🏽‍💻 東京', 'user-1', 2, 5, width)
  assert.ok(header.spans.every(part => part.action?.kind === 'jump-prompt' && part.action.itemId === 'user-1'))
  const painted = safeText(renderToString(createElement(Screen, { rows: [header], width, theme: 'dark' }), { columns: width + 1 }))
  assert.match(painted, /↑ › Fix the/)
  assert.doesNotMatch(painted, /\n.*\S/u)
  assert.ok(widthOf(painted) <= width)
  if (width >= 80) assert.match(painted, /and then run every test.*prompt 2\/5/u)
})


const { statusRow } = await import('../src/screen.ts')
const { fixture } = await import('./fixtures.mjs')
for (const width of [28, 40, 80, 120]) test(`real Ink paints the one-row status line with Auto permission and the running timer at ${width} columns`, () => {
  const state = fixture({ status: 'running', projections: { ...fixture().projections, permissions: { currentValue: 'auto' } } })
  state.transcript.workStartedAt = 1000
  const rows = [statusRow(state, width, 0, 41000)]
  const painted = safeText(renderToString(createElement(Screen, { rows, width, theme: 'mono' }), { columns: width + 1 }))
  assert.match(painted, / · {1,2}auto/)
  assert.doesNotMatch(painted, /permissions:/)
  // The timer leaves before the context bar and numbers do.
  if (width >= 80) assert.match(painted, /40s/)
  if (width >= 40) assert.match(painted, /ctx 15%/)
  assert.equal(painted.split('\n').length, 1)
  assert.ok(painted.split('\n').every(line => widthOf(line) <= width))
  assert.ok(rows[0].spans.some(span => span.action?.kind === 'open-permissions'))
})


test('Ink decodes Ctrl+Enter separately from Enter in the extended keyboard protocol', async () => {
  const { default: parseKeypress } = await import('../node_modules/ink/build/parse-keypress.js')
  const key = parseKeypress('\x1b[13;5u')
  assert.equal(key.name, 'return'); assert.equal(key.ctrl, true)
  assert.equal(parseKeypress('\r').ctrl, false)
})
