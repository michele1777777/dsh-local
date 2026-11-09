/** Failed local actions as the composer shows them: above its top rule until the next keystroke, never in the transcript. */
import type { ComposerError } from './store.ts'

/** A malformed local command: what is wrong with it, and its correct form. The message carries both for non-terminal output. */
export class UsageError extends Error {
  /**
   * @param problem - what is wrong, naming the command.
   * @param usage - the command's correct form.
   */
  constructor(readonly problem: string, readonly usage: string) {
    super(`${problem} · usage: ${usage}`)
    this.name = 'UsageError'
  }
}

/**
 * The composer's view of a failure.
 * @param error - a rejected local action: a {@link UsageError}, another `Error`, or any thrown value.
 * @returns the message, and for a {@link UsageError} its problem and usage separately.
 */
export function composerError(error: unknown): ComposerError {
  if (error instanceof UsageError) return { message: error.problem, usage: error.usage }
  return { message: error instanceof Error ? error.message : String(error) }
}
