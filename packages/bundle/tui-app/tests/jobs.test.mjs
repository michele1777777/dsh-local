import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures.mjs'
import { statusRow, inspectorRows } from '../src/screen.ts'
import { textOfRow } from '../src/rich-text.ts'

const job = { id: 'job-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 1, output: { total: 5, earliest: 0 } }
test('background jobs have footer and inspector click targets, including empty finished jobs', () => {
  const state = fixture({ jobs: [job, { ...job, id: 'job-2', status: 'completed', output: { total: 0, earliest: 0 } }] })
  assert.ok(statusRow(state, 100, 0, 10).spans.some(span => span.action?.kind === 'open-jobs'))
  assert.ok(!statusRow(fixture({ jobs: [{ ...job, status: 'completed', finishedAt: 2 }] }), 100, 0, 10).spans.some(span => span.action?.kind === 'open-jobs'))
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

test('job rows name what the job does, colour its status, order live jobs first and show the command muted', () => {
  const started = { kind: 'tool', id: 'call-1', name: 'bash', args: { command: 'pnpm dev --port 3000', description: 'Start the dev server', run_in_background: true },
    call: { card: 'terminal', title: 'pnpm dev --port 3000' }, resultText: 'started background job bash-1a2b', isError: false, settled: true }
  const dev = { id: 'bash-1a2b', kind: 'bash', label: 'pnpm dev --port 3000', status: 'running', progress: 'listening on :3000', startedAt: 1_000, output: { total: 5, earliest: 0 } }
  const old = { id: 'bash-3c4d', kind: 'bash', label: 'pnpm test', status: 'failed', detail: 'exit code: 1', startedAt: 0, finishedAt: 4_000, output: { total: 5, earliest: 0 } }
  const late = { id: 'bash-5e6f', kind: 'bash', label: 'pnpm build', status: 'completed', startedAt: 0, finishedAt: 9_000, output: { total: 5, earliest: 0 } }
  const state = fixture({ jobs: [old, late, dev], transcript: { ...fixture().transcript, items: [started] } })
  const rows = inspectorRows(state, 'jobs', [], 60, 13_000).slice(2)
  assert.deepEqual(rows.map(textOfRow), [
    `◌ Start the dev server${' '.repeat(35)}12s`,
    '  pnpm dev --port 3000 · listening on :3000',
    `✓ pnpm build${' '.repeat(44)}9.0s`,
    '  completed',
    `× pnpm test${' '.repeat(45)}4.0s`,
    '  exit code: 1',
  ])
  assert.equal(rows[0].spans[0].tone, 'accent')
  assert.equal(rows[2].spans[0].tone, 'success')
  assert.equal(rows[4].spans[0].tone, 'error')
  assert.ok(rows[1].spans.every(part => part.tone === 'muted'))
  assert.ok(rows.every(value => value.spans.every(part => part.action?.kind === 'inspect-job')))
  const detail = inspectorRows({ ...state, selectedJob: dev.id }, 'jobs', [], 60, 13_000).map(textOfRow).join('\n')
  assert.match(detail, /Description {2}Start the dev server/)
})
