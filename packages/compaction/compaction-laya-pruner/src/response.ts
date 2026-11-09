/** Reads resident Laya JSON or a managed DS4 lifecycle stream. */
export type LayaPhase = 'release' | 'start' | 'prune' | 'stop' | 'restore'

const phases: readonly string[] = ['release', 'start', 'prune', 'stop', 'restore']

/**
 * Return the pruning result only after the server's terminal record and EOF.
 * @param response - HTTP response whose body belongs to this operation.
 * @param progress - receives observed server phases, never estimated timers.
 * @returns parsed Laya result; rejects malformed, failed or incomplete streams.
 */
export async function readLayaResponse(response: Response, progress: (phase: LayaPhase) => void): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) return response.json()
  if (response.body === null) throw new Error('Laya lifecycle stream has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let result: unknown
  let settled = false
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 16 * 1024 * 1024) throw new Error('Laya lifecycle stream exceeds 16 MiB')
      pending += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim().length === 0) continue
        const record: unknown = JSON.parse(line)
        if (record === null || typeof record !== 'object' || Array.isArray(record) || settled) throw new Error('Invalid Laya lifecycle record')
        if ('error' in record) throw new Error(typeof record.error === 'string' ? record.error : 'Laya worker failed')
        if ('result' in record) { result = record.result; settled = true }
        else if ('phase' in record && typeof record.phase === 'string' && phases.includes(record.phase)) progress(record.phase as LayaPhase)
        else throw new Error('Unknown Laya lifecycle phase')
      }
    }
    pending += decoder.decode()
    if (!settled || pending.trim().length !== 0) throw new Error('Incomplete Laya lifecycle stream')
    return result
  } finally {
    // Cancellation closes the fetch body; DS4 retains ownership of worker cleanup.
    await reader.cancel().catch((error: unknown) => { void error /* The stream may already be aborted. */ })
    reader.releaseLock()
  }
}
