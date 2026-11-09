/** Real Ink output through xterm: geometry changes can destroy otherwise unchanged rows. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable, PassThrough } from 'node:stream'
import { createElement } from 'react'
import xterm from '@xterm/headless'
import { claimTerminal } from '../src/terminal-guard.ts'

// The test runner has no physical TTY; enable the SGR styles that a real TUI emits.
process.env.FORCE_COLOR = '1'
const { render } = await import('ink')
const { Screen } = await import('../src/components.tsx')

for (const incrementalRendering of [true, false]) test(`resize bursts restore every row, incremental=${incrementalRendering}`, async () => {
  const vt = new xterm.Terminal({ cols: 100, rows: 30, convertEol: true, allowProposedApi: true })
  const input = new PassThrough(); input.isTTY = false
  let writes = 0
  const output = new Writable({ write(chunk, _encoding, done) { writes++; vt.write(chunk, done) } })
  Object.assign(output, { columns: 100, rows: 30, isTTY: true })
  const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
  const claim = claimTerminal(output, stderr, () => {})
  const frame = (version = 'A') => createElement(Screen, { width: output.columns - 1, theme: 'mono',
    rows: Array.from({ length: output.rows }, (_, i) => ({ spans: [{ text: i === output.rows - 1 ? 'FOOTER' : `ROW ${i} ${version} ${'long line '.repeat(12)}` }] })) })
  const app = render(frame(), { stdout: claim.stdout, stderr, stdin: input, interactive: true,
    patchConsole: false, exitOnCtrlC: false, alternateScreen: true, incrementalRendering, maxFps: 60 })
  const unsubscribe = claim.onResize(() => { app.invalidate() })
  const resize = (columns, rows) => { output.columns = columns; output.rows = rows; vt.resize(columns, rows); output.emit('resize') }
  const verify = (version = 'A') => {
    const lines = Array.from({ length: output.rows }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? '')
    lines.forEach((line, i) => i === output.rows - 1
      ? assert.equal(line, 'FOOTER') : assert.ok(line.startsWith(`ROW ${i} ${version} `), `row ${i}: ${line}`))
  }
  try {
    await app.waitUntilRenderFlush(); verify()
    // Same final dimensions and content: Ink must not mistake a destroyed screen for an unchanged frame.
    resize(20, 8); resize(100, 30)
    const before = writes
    app.rerender(frame()); await app.waitUntilRenderFlush(); verify()
    assert.ok(writes > before)
    for (const [cols, rows] of [[50, 30], [80, 35], [30, 15], [100, 30], [55, 35], [20, 8], [120, 40]]) {
      resize(cols, rows); app.rerender(frame()); await app.waitUntilRenderFlush(); verify()
    }
    // Pending streaming paints must not reintroduce the old geometry after a resize.
    app.rerender(frame('B')); resize(40, 20); app.rerender(frame('C'))
    await app.waitUntilRenderFlush(); verify('C')
    app.rerender(frame('D')); await app.waitUntilRenderFlush(); verify('D')
    for (const inverse of [true, false]) {
      const next = frame('D')
      next.props.rows[1].spans[0].inverse = inverse
      app.rerender(next); await app.waitUntilRenderFlush()
      assert.equal(Boolean(vt.buffer.active.getLine(1).getCell(0).isInverse()), inverse)
    }
  } finally {
    unsubscribe(); app.unmount(); await app.waitUntilExit(); app.cleanup(); claim.release()
    input.destroy(); output.destroy(); stderr.destroy(); vt.dispose()
  }
})
