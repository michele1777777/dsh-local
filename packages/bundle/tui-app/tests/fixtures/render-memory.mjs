/** Test-only renderer workload: each frame contains new streamed text. */
import assert from 'node:assert/strict'
import { Writable, PassThrough } from 'node:stream'
import { setImmediate as immediate } from 'node:timers/promises'
import { createElement } from 'react'
import { render } from 'ink'
import { Screen } from '../../src/components.tsx'

assert.equal(typeof global.gc, 'function', 'run with --expose-gc')
let painted = ''
const output = new Writable({ write(chunk, _encoding, done) {
  const text = String(chunk)
  if (text.includes('Thinking ')) painted = text
  done()
} })
Object.assign(output, { columns: 100, rows: 40, isTTY: true })
const input = new PassThrough()
input.isTTY = false
const frame = index => createElement(Screen, {
  width: 99, theme: 'mono',
  rows: Array.from({ length: 35 }, (_, line) => ({
    spans: [{ text: `Thinking ${index}, line ${line}: ${'streamed text 東京 '.repeat(10)}` }],
  })),
})
const app = render(frame(0), {
  stdout: output, stderr: output, stdin: input, interactive: true,
  patchConsole: false, exitOnCtrlC: false, maxFps: 100000,
})
try {
  for (let index = 1; index <= 4000; index++) {
    app.rerender(frame(index))
    await app.waitUntilRenderFlush()
    await immediate()
    if (index % 1000 === 0) {
      assert.ok(painted.includes(`Thinking ${index}`), 'the renderer must actually paint each sampled frame')
      global.gc()
      console.log(JSON.stringify({
        frame: index, measures: performance.getEntriesByType('measure').length,
        heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss,
      }))
    }
  }
} finally {
  app.unmount()
  await app.waitUntilExit()
  app.cleanup()
  input.destroy()
  output.destroy()
}
