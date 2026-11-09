/** Bounded permission presentation. Never a grant cache or a second policy engine. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalReview } from '@deepseek-ai/dsh-user-approval/types'

/** One approval request in the bounded audit list; `outcome` and `review` arrive with its decision. */
export interface PermissionAuditRow {
  id: string
  owner: string
  toolName: string
  time: number
  outcome?: ApprovalOutcome
  review?: ApprovalReview
}

/**
 * Fold the original audit pair, retaining the authoritative outcome alongside the recommendation.
 * @param rows - the current audit rows.
 * @param event - a session event; only `approval/asked` and `approval/decided` change rows.
 * @param owner - the Session or agent that emitted the event, keying rows with their id.
 * @returns new rows, keeping the latest 50 requests.
 */
export function foldPermissionAudit(rows: readonly PermissionAuditRow[], event: SessionEvent, owner: string): PermissionAuditRow[] {
  if (event.type === 'approval/asked') {
    return [...rows, { id: event.data.id, owner, toolName: event.data.toolName, time: event.time }].slice(-50)
  }
  if (event.type !== 'approval/decided') return [...rows]
  return rows.map(item => item.id === event.data.id && item.owner === owner
    ? { ...item, outcome: event.data.outcome, ...event.data.review === undefined ? {} : { review: event.data.review } }
    : item)
}

/**
 * Describe a machine recommendation without calling a cancelled or rejected action approved.
 * @param item - the audit row.
 * @returns `<tool> · <outcome or review label>`; an undecided row reads `pending`.
 */
export function permissionAuditLabel(item: PermissionAuditRow): string {
  const decision = item.review
  const outcome = item.outcome ?? 'pending'
  if (decision === undefined) return `${item.toolName} · ${outcome}`
  const label = outcome === 'allowed-once' && decision.decision === 'allow'
    ? `auto-approved · ${decision.source}`
    : decision.decision === 'ask' ? `human fallback → ${outcome}` : `${decision.source} ${decision.decision} → ${outcome}`
  return `${item.toolName} · ${label}`
}
