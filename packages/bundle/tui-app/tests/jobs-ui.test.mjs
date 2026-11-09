import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./ui-loader.mjs', import.meta.url)
const { App } = await import('../src/app.tsx')
const { createHarness } = await import('./ui-harness.mjs')
const { createStore } = await import('../src/store.ts')
const { textOfRow } = await import('../src/rich-text.ts')
const { fixture } = await import('./fixtures.mjs')

test('the status-line job count opens jobs, row click follows output, and Escape disposes the observer', async () => {
  const job = { id: 'job-1', kind: 'bash', label: 'background-build', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }
  const store = createStore(fixture({ jobs: [job] }))
  let observed, signal
  const controller = { commands: () => [], hint() {}, report(error) { throw error }, async followJob(id, abort) {
    observed = id; signal = abort
    store.update(state => { state.jobDetail = { jobId: id, text: 'build output', streaming: true, gapBefore: false } })
  } }
  const h = createHarness(App, store, controller, 100, 30)
  async function click(text) {
    const y = h.rows().findIndex(row => textOfRow(row).includes(text))
    assert.ok(y >= 0, `missing ${text}`)
    const x = textOfRow(h.rows()[y]).indexOf(text) + 2
    await h.key(`[<0;${x};${y + 1}M`)
    await h.key(`[<0;${x};${y + 1}m`)
  }
  try {
    assert.match(h.text(), /·  1 job  /)
    await click('1 job')
    assert.equal(store.getState().panel, 'jobs')
    await click('background-build')
    assert.equal(observed, job.id)
    assert.match(h.text(), /build output/)
    await h.key('', { escape: true })
    assert.equal(signal.aborted, true)
    assert.equal(store.getState().panel, undefined)
  } finally { h.dispose() }
})

test('the status line counts only live jobs; settled records stay reachable', () => {
  const settled = { id: 'job-2', kind: 'bash', label: 'finished-build', status: 'completed', startedAt: 1, finishedAt: 2, output: { total: 0, earliest: 0 } }
  const h = createHarness(App, createStore(fixture({ jobs: [settled] })), { commands: () => [], hint() {}, report(error) { throw error } }, 100, 30)
  try {
    assert.match(h.text(), /1 finished job/)
    assert.doesNotMatch(h.text(), /\d jobs? /)
  } finally { h.dispose() }
})
