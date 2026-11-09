/**
 * Exclusive terminal ownership for the fullscreen renderer. Ink's incremental
 * renderer rewrites only rows whose text changed, so any byte another writer
 * puts on the TTY (a Node warning, a plugin's stderr line) scrolls the
 * alternate screen and leaves rows the renderer believes current showing an
 * older frame. While claimed, every write to the process streams except the
 * renderer's and the TUI's own control sequences goes to a sink instead.
 *
 * The claim also owns resizes. Ink's own resize handler repaints the previous
 * React tree, laid out for the old size, and erases the screen whenever the
 * width shrinks; the TUI instead re-renders from {@link TerminalSize}, so every
 * frame painted after a resize already has the new size.
 * @module @deepseek-ai/dsh-tui-app/terminal-guard
 */

/** The writer the guard replaces; `process.stderr` satisfies it. */
export interface GuardedStream { write: NodeJS.WritableStream['write'] }

/** The painted terminal stream; `process.stdout` satisfies it. */
export interface TerminalStream extends GuardedStream {
  columns: number
  rows: number
  on(event: 'resize', listener: () => void): unknown
  off(event: 'resize', listener: () => void): unknown
}

/** Receives one diverted chunk; a throwing sink drops the chunk rather than painting it. */
export type DivertSink = (text: string, stream: 'stdout' | 'stderr') => void

/** The live terminal size and its changes, for the component that lays out frames. */
export interface TerminalSize {
  /** @returns the terminal's current size in cells. */
  size(): { columns: number; rows: number }
  /**
   * @param listener - called after each terminal resize.
   * @returns the unsubscribe function.
   */
  onResize(listener: () => void): () => void
}

/** An active claim on the terminal. */
export interface TerminalClaim<T extends TerminalStream> extends TerminalSize {
  /** The renderer's stream: the real stdout with its original writer; it never delivers `resize`. */
  stdout: T
  /** Write a control sequence (OSC 52, terminal modes) straight to the terminal. */
  write(text: string): void
  /** Restore both streams' original writers. */
  release(): void
}

const SUBSCRIBE = new Set<PropertyKey>(['on', 'addListener', 'prependListener', 'once', 'prependOnceListener', 'off', 'removeListener'])

/**
 * Claim the terminal for one fullscreen renderer.
 * @param stdout - the terminal stream the renderer paints.
 * @param stderr - the error stream sharing the same terminal.
 * @param divert - receives every write made through either stream by anyone else.
 * @returns the renderer's stream, a direct control writer, the live size, and the release.
 */
export function claimTerminal<T extends TerminalStream>(stdout: T, stderr: GuardedStream, divert: DivertSink): TerminalClaim<T> {
  const paint = stdout.write.bind(stdout) as T['write']
  const restore = [replace(stdout, 'stdout', divert), replace(stderr, 'stderr', divert)]
  const renderer: T = new Proxy(stdout, {
    get(target, key): unknown {
      if (key === 'write') return paint
      const value: unknown = Reflect.get(target, key)
      if (!SUBSCRIBE.has(key) || typeof value !== 'function') return value
      return (event: string | symbol, ...rest: unknown[]): unknown =>
        event === 'resize' ? renderer : Reflect.apply(value, target, [event, ...rest])
    },
  })
  return {
    stdout: renderer,
    write(text) { paint(text) },
    size: () => ({ columns: stdout.columns, rows: stdout.rows }),
    onResize(listener) {
      stdout.on('resize', listener)
      return () => { stdout.off('resize', listener) }
    },
    release() { for (const undo of restore.splice(0)) undo() },
  }
}

type WriteCallback = (error?: Error | null) => void

function replace(stream: GuardedStream, name: 'stdout' | 'stderr', divert: DivertSink): () => void {
  const own = Object.prototype.hasOwnProperty.call(stream, 'write'), previous = stream.write
  const write = (chunk: string | Uint8Array, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
    try { divert(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'), name) }
    catch { /* The sink failed: dropping the chunk keeps the frame intact, which is this guard's purpose. */ }
    const done = typeof encoding === 'function' ? encoding : callback
    if (done !== undefined) setImmediate(done)
    return true
  }
  stream.write = write
  return () => {
    if (own) stream.write = previous
    else delete (stream as Partial<GuardedStream>).write
  }
}
