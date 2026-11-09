/** Foreground waits that the owner's human can move to the background without cancelling the producer. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry } from './index.ts'
import type { JobId, JobView } from './types.ts'

/**
 * Wait for completion or timeout; the owner's human can release the wait
 * through {@link JobRegistry.releaseWaits}, leaving the job running.
 * @param registry - the registry retaining the producer and output.
 * @param id - the job to wait for.
 * @param timeoutMs - maximum foreground wait.
 * @param agent - the owning agent whose human can release the wait.
 * @param signal - ordinary cancellation; takes precedence over a release.
 * @returns The job view, or undefined when a release leaves the job running in the background.
 */
export async function waitForForegroundJob(
  registry: JobRegistry, id: JobId, timeoutMs: number, agent: Agent | undefined, signal: AbortSignal,
): Promise<JobView | undefined> {
  signal.throwIfAborted()
  if (agent === undefined) return registry.wait(id, timeoutMs, undefined, signal)
  const released = new AbortController()
  const withdraw = registry.holdWait(agent.id, () => { released.abort() })
  try {
    return await registry.wait(id, timeoutMs, agent.id, AbortSignal.any([signal, released.signal]))
  } catch (error) {
    if (released.signal.aborted && !signal.aborted) return undefined
    throw error
  } finally {
    withdraw()
  }
}
