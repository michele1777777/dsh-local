/**
 * Human prompts the chat answers on the model's behalf: tool approvals
 * (`approval/request`) and `ask_user` questions (`user-questions/request`).
 * Each pending prompt carries its own settle callbacks, so the UI answers it
 * without knowing which waterfall produced it.
 * @module @deepseek-ai/dsh-tui-app/interaction
 */

import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** A tool approval awaiting a decision; `resolve` delivers the outcome to the requesting waterfall. */
export interface PendingApproval {
  kind: 'approval'
  id: string
  toolName: string
  reason: string | undefined
  detail: string | undefined
  owner: string
  cwd?: string | undefined
  resolve(outcome: ApprovalOutcome): void
}

/** An `ask_user` request awaiting answers; `reject` fails the tool call. */
export interface PendingQuestion {
  kind: 'question'
  id: string
  questions: AskUserQuestionItem[]
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: unknown): void
}

/** Any prompt the chat shows until the human answers it. */
export type Pending = PendingApproval | PendingQuestion

/**
 * Settle callbacks that fire at most once, whichever side answers first.
 * @param fn - the callback to guard.
 * @returns a wrapper that ignores every call after the first.
 */
export function once<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  let done = false
  return (...args) => {
    if (done) return
    done = true
    fn(...args)
  }
}
