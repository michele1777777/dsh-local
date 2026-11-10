/** Presentation store; durable session state remains owned by SessionController. */
import type { ModelSelection, PromptContentPart, SessionControlFrame, SessionProjectionValues, SkillEntry } from '@deepseek-ai/dsh-api-session-controller'
import type { JobView } from '@deepseek-ai/dsh-api-job-controller'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Pending } from './interaction.ts'
import type { PermissionAuditRow } from './permission-audit.ts'
import type { ThemeName } from './theme.ts'
import type { Transcript } from './transcript.ts'

/**
 * One pending Inbox message as the terminal lists it. `next-turn` rows wait
 * for the next turn (queued); human `next-step` rows steer the running turn,
 * any other `next-step` producer is injected context.
 */
export interface QueuedItem {
  readonly id: MessageId
  readonly placement: 'queued' | 'steering' | 'context'
  readonly message: { readonly id: MessageId; readonly content: readonly JsonValue[] }
}
/**
 * The shown Session's projection values after one `session/control` frame. A baseline replaces them; a projection
 * frame sets every key its committed event changed and keeps the keys it does not list.
 * @param current - projection values before the frame.
 * @param frame - the control frame, already addressed to the shown Session.
 * @param sessionId - the shown Session, which selects its values from a baseline.
 * @returns the new projection values.
 */
export function projectionsAfter(
  current: SessionProjectionValues, frame: SessionControlFrame, sessionId: SessionId,
): SessionProjectionValues {
  if (frame.type === 'baseline') return frame.value.projections[sessionId]?.values ?? {}
  const next = { ...current }
  for (const change of frame.changes) next[change.key] = change.val
  return next
}

/**
 * Presentation-only read of the shared `inbox` projection, the same value the Web queue dock reads.
 * @param projections - the shown Session's projection values.
 * @returns `next-turn` rows, then `next-step` rows; malformed entries are skipped.
 */
export function queueOf(projections: SessionProjectionValues): QueuedItem[] {
  const inbox = projections.inbox as { readonly [target: string]: unknown } | undefined
  const rows = (target: 'next-turn' | 'next-step'): QueuedItem[] => {
    const list = inbox?.[target]
    if (!Array.isArray(list)) return []
    return list.flatMap((value: unknown) => {
      if (value === null || typeof value !== 'object') return []
      const message = value as { id?: unknown; source?: { kind?: unknown }; content?: unknown }
      if (typeof message.id !== 'string' || !Array.isArray(message.content)) return []
      const id = message.id as MessageId
      const placement = target === 'next-turn' ? 'queued' : message.source?.kind === 'user' ? 'steering' : 'context'
      return [{ id, placement, message: { id, content: message.content as JsonValue[] } }]
    })
  }
  return [...rows('next-turn'), ...rows('next-step')]
}
/** Full-screen panels that replace the transcript view. */
export type Panel = 'transcript' | 'context' | 'permissions' | 'tasks' | 'jobs' | 'goal' | 'help'
/** Choosing a row runs `command`, else places `draft` in the composer, else only closes the picker. */
export interface PickerRow { id: string; label: string; detail: string; command?: string; draft?: string; current?: boolean }
/** An open selection list and the rows it offers; `all` widens session lists beyond the current directory. */
export interface Picker { kind: 'sessions' | 'models' | 'efforts' | 'themes' | 'skills' | 'permissions'; title: string; rows: readonly PickerRow[]; all?: boolean }
/** A failed local action as the composer shows it: what went wrong and, for a malformed command, its correct form. */
export interface ComposerError { message: string; usage?: string }
/** An attachment staged in the composer, sent with the next prompt. */
export interface StagedAttachment { name: string; part: PromptContentPart }
/** Everything the terminal UI renders; presentation state only, never durable session data. */
export interface ChatState {
  transcript: Transcript
  status: 'idle' | 'running'
  pending: Pending[]
  selection: ModelSelection
  sessionId: string
  cwd: string
  title: string
  preset: string | undefined
  /** UI preferences never enter a SessionController request. */
  theme?: ThemeName
  /** Wheel reporting; off returns click and drag to the terminal's own selection. */
  mouse?: boolean
  layout?: 'auto' | 'single' | 'split'
  links?: boolean
  notifications?: 'off' | 'bell' | 'desktop'
  terminalTitle?: boolean
  /** Animated decorations, such as the whale on an empty conversation. */
  motion?: boolean
  panel?: Panel | undefined
  approvalPolicy?: 'ask' | 'never' | undefined
  /** Local views of shared approval events; no permission decisions originate here. */
  reviewingApprovals?: number
  permissionAudit?: readonly PermissionAuditRow[]
  goalActivation?: 'armed' | 'disarmed' | undefined
  /** The permission preset new sessions start with; the status line names the current preset only when it differs. */
  defaultPermission?: string | undefined
  expandedTools: boolean
  /** Transient information shown above the composer; it clears after a few seconds or when a prompt or command is sent. */
  hint: string | undefined
  /** A failed local action, shown above the composer until the next keystroke, prompt or command; never a transcript entry. */
  composerError?: ComposerError | undefined
  exiting: boolean
  busy: string | undefined
  picker: Picker | undefined
  /** User-invocable skills of the current session, offered as `/name` beside commands. */
  skills?: readonly SkillEntry[]
  /** Derived from `projections.inbox`; never a TUI-owned queue mirror. */
  queue: readonly QueuedItem[]
  /** Latest `job.list` roster frame for the current session. */
  jobs: readonly JobView[]
  selectedJob?: JobView['id'] | undefined
  jobDetail?: { jobId: JobView['id']; text: string; streaming: boolean; gapBefore: boolean; error?: string } | undefined
  projections: SessionProjectionValues
  attachments: StagedAttachment[]
  /** Reset viewport anchors on session changes/clear; never edit durable history. */
  viewEpoch: number
  hiddenBefore: number
  /** Failed/cancelled opening prompt, restored only into an empty composer. */
  recoveredInput: string | undefined
}
/** Holder of {@link ChatState} with copy-on-write updates and change subscriptions. */
export interface Store {
  getState: () => ChatState
  /**
   * Apply one change.
   * @param mutate - the change, applied to an isolated snapshot.
   * @param coalesce - announce with the next frame instead of immediately.
   *   Streamed tokens use this: one repaint per token costs more than the
   *   interval between tokens on a long transcript and starves keyboard input.
   *   The state itself is current for `getState` as soon as this returns, and
   *   any immediate change announces the coalesced ones with it.
   */
  update: (mutate: (state: ChatState) => void, coalesce?: boolean) => void
  subscribe: (listener: () => void) => () => void
}
/** Repaint interval for coalesced changes; Ink paints at 30 frames a second. */
export const FRAME_MS = 33
/**
 * Create the presentation store.
 * @param initial - the starting state.
 * @param frame - delay in ms before coalesced changes are announced.
 * @returns a store whose updates apply to a copy of the root, transcript items, pending list and attachments.
 */
export function createStore(initial: ChatState, frame = FRAME_MS): Store {
  let state = initial
  let pending: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const announce = (): void => {
    if (pending !== undefined) { clearTimeout(pending); pending = undefined }
    for (const listener of [...listeners]) listener()
  }
  return {
    getState: () => state,
    update(mutate, coalesce = false) {
      // Snapshot isolation also covers mutable transcript rows, not just the root.
      const next: ChatState = {
        ...state,
        transcript: { ...state.transcript, items: state.transcript.items.map(item => ({ ...item })) },
        pending: [...state.pending],
        attachments: [...state.attachments],
      }
      mutate(next)
      state = next
      if (!coalesce) { announce(); return }
      if (pending !== undefined) return
      // A queued repaint never keeps the process alive on its own.
      pending = setTimeout(announce, frame).unref()
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
