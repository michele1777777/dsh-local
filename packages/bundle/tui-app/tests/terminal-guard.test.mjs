import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { claimTerminal } from '../src/terminal-guard.ts'

/** A TTY stand-in that records what reaches the terminal. */
function terminal() {
  const stream = new EventEmitter()
  stream.isTTY = true; stream.columns = 80; stream.rows = 24
  stream.painted = []
  stream.write = function (chunk, encoding, callback) {
    this.painted.push(String(chunk))
    const done = typeof encoding === 'function' ? encoding : callback
    if (typeof done === 'function') done()
    return true
  }
  return stream
}

test('foreign writes never reach a claimed terminal; the renderer and control writes do', () => {
  const stdout = terminal(), stderr = terminal(), diverted = []
  const claim = claimTerminal(stdout, stderr, (text, stream) => { diverted.push([stream, text]) })
  // A Node warning is two lines, the first wider than the terminal: painted, it scrolls the
  // alternate screen and leaves rows the incremental renderer believes current showing an older frame.
  stderr.write('(node:1) MaxListenersExceededWarning: Possible EventTarget memory leak detected.\n(Use `node --trace-warnings ...`)\n')
  stdout.write('stray log line\n')
  claim.stdout.write('\u001b[2Kframe row')
  claim.write('\u001b]52;c;eA==\u0007')
  assert.deepEqual(stdout.painted, ['\u001b[2Kframe row', '\u001b]52;c;eA==\u0007'])
  assert.deepEqual(stderr.painted, [])
  assert.deepEqual(diverted.map(([stream]) => stream), ['stderr', 'stdout'])
  assert.match(diverted[0][1], /MaxListenersExceededWarning/)
  claim.release()
})

test('resizes reach the TUI through the claim, never the renderer, which reads live size', () => {
  const stdout = terminal(), stderr = terminal()
  const claim = claimTerminal(stdout, stderr, () => {})
  let renderer = 0, owner = 0, other = 0
  // Ink repaints its previous tree on `resize`, laid out for the old size.
  assert.equal(claim.stdout.on('resize', () => { renderer++ }), claim.stdout)
  claim.stdout.on('drain', () => { other++ })
  const stop = claim.onResize(() => { owner++; assert.deepEqual(claim.size(), { columns: 120, rows: 40 }) })
  stdout.columns = 120; stdout.rows = 40; stdout.emit('resize'); stdout.emit('drain')
  assert.equal(claim.stdout.columns, 120)
  assert.equal(claim.stdout.isTTY, true)
  assert.deepEqual([renderer, owner, other], [0, 1, 1])
  stop(); stdout.emit('resize')
  assert.equal(owner, 1)
  claim.release()
})

test('a diverted write still completes its callback, and release restores both streams', () => {
  const stdout = terminal(), stderr = terminal()
  const claim = claimTerminal(stdout, stderr, () => {})
  let completed = 0
  assert.equal(stderr.write('x', () => { completed++ }), true)
  assert.equal(stderr.write('y', 'utf8', () => { completed++ }), true)
  claim.release()
  stderr.write('after release\n')
  assert.deepEqual(stderr.painted, ['after release\n'])
  return new Promise((resolve) => { setImmediate(() => { assert.equal(completed, 2); resolve() }) })
})

test('a failing sink cannot put the output back on the terminal', () => {
  const stdout = terminal(), stderr = terminal()
  const claim = claimTerminal(stdout, stderr, () => { throw new Error('disk full') })
  stderr.write('warning\n')
  assert.deepEqual(stderr.painted, [])
  claim.release()
})
