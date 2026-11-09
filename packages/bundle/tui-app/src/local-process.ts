/** Bounded, cancellable OS helpers. Content goes over stdin, never through a shell. */
import { spawn } from 'node:child_process'
/** One helper invocation. Defaults: 5000 ms timeout, 64 KiB stdout limit, inherited environment, captured output. */
export interface ProcessRequest {
  command: string
  args: readonly string[]
  input?: string | Uint8Array
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  env?: NodeJS.ProcessEnv
  /** Clipboard setters may fork a selection owner: do not inherit its output pipes. */
  captureOutput?: boolean
}
/** Runs a helper and resolves its stdout; rejects on spawn failure, non-zero exit, timeout, cancellation or oversized output. */
export type ProcessRunner = (request: ProcessRequest) => Promise<Buffer>
/**
 * Spawns without a shell, writes `input` to stdin, and sends SIGKILL 250 ms after a cancellation or timeout if the child has not exited.
 * @param request - the invocation.
 * @returns the child's stdout.
 */
export const runProcess: ProcessRunner = request => new Promise((resolve, reject) => {
  request.signal?.throwIfAborted()
  const child = spawn(request.command, [...request.args], { shell: false, windowsHide: true, stdio: ['pipe', request.captureOutput === false ? 'ignore' : 'pipe', request.captureOutput === false ? 'ignore' : 'pipe'], env: request.env ?? process.env })
  const chunks: Buffer[] = []; let size = 0, stderr = '', failure: Error | undefined, closed = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const stop = (error: Error): void => {
    if (closed || failure !== undefined) return
    failure = error; child.kill()
    // A helper must not keep the terminal hung after cancellation or a timeout.
    killTimer = setTimeout(() => { child.kill('SIGKILL') }, 250).unref()
  }
  const abort = (): void => { stop(new Error('Local operation cancelled')) }
  const timer = setTimeout(() => { stop(new Error(`${request.command}: clipboard helper timed out`)) }, request.timeoutMs ?? 5000).unref()
  request.signal?.addEventListener('abort', abort, { once: true })
  if (request.signal?.aborted) abort()
  child.on('error', (error) => { failure ??= error })
  child.stdout?.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > (request.maxBytes ?? 64 * 1024)) stop(new Error(`${request.command}: output exceeds the allowed size`))
    else chunks.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 2000) stderr += chunk.toString('utf8').slice(0, 2000 - stderr.length) })
  child.stdin?.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error) })
  child.on('close', (code) => {
    closed = true; clearTimeout(timer); if (killTimer !== undefined) clearTimeout(killTimer)
    request.signal?.removeEventListener('abort', abort)
    if (failure !== undefined) reject(failure)
    else if (code !== 0) reject(new Error(`${request.command}: ${stderr.trim() || `exited ${String(code)}`}`))
    else resolve(Buffer.concat(chunks))
  })
  child.stdin?.end(request.input)
})
/**
 * Fixed PowerShell source; data is kept out of its code and command-line quoting.
 * @param script - PowerShell source, encoded as UTF-16LE base64.
 * @returns powershell arguments that run the script non-interactively in an STA thread without a profile.
 */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}
