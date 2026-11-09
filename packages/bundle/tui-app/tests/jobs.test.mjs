import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures.mjs'
import { statusRow, inspectorRows } from '../src/screen.ts'
import { textOfRow } from '../src/rich-text.ts'

const job = { id: 'job-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 1, output: { total: 5, earliest: 0 } }
test('background jobs have footer and inspector click targets, including empty finished jobs', () => {
  const state = fixture({ jobs: [job, { ...job, id: 'job-2', status: 'completed', output: { total: 0, earliest: 0 } }] })
  assert.ok(statusRow(state, 100, 0, 10).spans.some(span => span.action?.kind === 'open-jobs'))
  for (const panel of ['tasks', 'jobs']) {
    const actions = inspectorRows(state, panel, [], 100).flatMap(row => row.spans).map(span => span.action).filter(Boolean)
    assert.ok(actions.some(action => action.kind === 'inspect-job' && action.jobId === 'job-1'))
    assert.ok(actions.some(action => action.kind === 'inspect-job' && action.jobId === 'job-2'))
  }
})
test('selected job shows status and literal output with no executable output actions', () => {
  const state = fixture({ jobs: [job], selectedJob: job.id, jobDetail: { jobId: job.id, text: 'ready\n[run](evil)\x1b[2J', streaming: true, gapBefore: true } })
  const rows = inspectorRows(state, 'jobs', [], 100)
  const text = rows.map(textOfRow).join('\n')
  assert.match(text, /running/)
  assert.match(text, /ready/)
  assert.match(text, /Some earlier output/)
  assert.doesNotMatch(text, /\x1b/)
})

const { createStore } = await import('../src/store.ts')
const { followJob } = await import('../src/job-observer.ts')
test('observer bounds output, preserves gaps, and does not overwrite a closed panel', async () => {
  const store = createStore(fixture({ panel: 'jobs', selectedJob: job.id, jobs: [job] }))
  const abort = new AbortController()
  async function* frames() {
    yield { type: 'opened', job, from: 0 }
    yield { type: 'output', chunks: [{ text: 'x'.repeat(150000) + 'last line' }], next: 150009 }
    yield { type: 'status', job: { ...job, status: 'completed' } }
  }
  await followJob(store, job.id, frames(), abort.signal)
  assert.equal(store.getState().jobDetail.text.length, 128 * 1024)
  assert.ok(store.getState().jobDetail.text.endsWith('last line'))
  assert.equal(store.getState().jobDetail.gapBefore, true)
  assert.equal(store.getState().jobDetail.streaming, false)
  assert.equal(store.getState().jobs[0].status, 'completed')
  async function* closed() {
    store.update(state => { state.panel = undefined; state.jobDetail = undefined })
    yield { type: 'output', chunks: [{ text: 'stale' }], next: 5 }
  }
  await followJob(store, job.id, closed(), abort.signal)
  assert.equal(store.getState().jobDetail, undefined)
})
