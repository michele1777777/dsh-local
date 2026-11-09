/** A bounded, non-consuming view; closing it only releases the observer. */
import type { JobFollowFrame, JobView } from '@deepseek-ai/dsh-api-job-controller'
import type { ChatState, Store } from './store.ts'

/** Match the Web inspector's bounded render tail (UTF-16 code units). */
const RENDER_TAIL_LIMIT = 128 * 1024
/**
 * Follow retained output without advancing the model's read cursor.
 * @param store - the current terminal presentation.
 * @param jobId - selected job.
 * @param frames - job.follow stream owned by the caller's signal.
 * @param signal - closes observation on panel or session changes.
 * @returns Resolves after settlement, cancellation, or a displayed error.
 */
export async function followJob(store: Store, jobId: JobView['id'], frames: AsyncIterable<JobFollowFrame>, signal: AbortSignal): Promise<void> {
  const current = () => !signal.aborted && store.getState().panel === 'jobs' && store.getState().selectedJob === jobId
  if (!current()) return
  let view: NonNullable<ChatState['jobDetail']> = { jobId, text: '', streaming: true, gapBefore: false }
  store.update((state) => { state.jobDetail = view })
  try {
    for await (const frame of frames) {
      if (!current()) return
      store.update((state) => {
        if (frame.type === 'output') {
          const text = view.text + frame.chunks.map(chunk => chunk.text).join('')
          let cut = Math.max(0, text.length - RENDER_TAIL_LIMIT)
          if (cut > 0 && text.charCodeAt(cut) >= 0xDC00 && text.charCodeAt(cut) <= 0xDFFF) cut++
          view = { ...view, text: text.slice(cut),
            gapBefore: view.gapBefore || cut > 0 || frame.lossy === true || frame.chunks.some(chunk => chunk.gapBefore === true) }
        } else {
          state.jobs = state.jobs.map(job => job.id === jobId ? frame.job : job)
          view = { ...view, streaming: frame.type !== 'status',
            gapBefore: view.gapBefore || (frame.type === 'opened' && (frame.from > 0 || frame.from < frame.job.output.earliest)) }
        }
        state.jobDetail = view
      }, true)
    }
  } catch (error) {
    if (current()) store.update((state) => { state.jobDetail = { ...view, streaming: false, error: String(error) } })
  }
}
