/** UI-only terminal signals; all interpolated labels are escaped, bounded and single-line. */
import { safeText } from './terminal.ts'
/** Enable terminal focus-in/focus-out reporting. */
export const FOCUS_ON = '\u001b[?1004h'
/** Disable terminal focus reporting. */
export const FOCUS_OFF = '\u001b[?1004l'
/** Save the terminal window title on the terminal's title stack. */
export const TITLE_PUSH = '\u001b[22;2t'
/** Restore the window title saved by `TITLE_PUSH`. */
export const TITLE_POP = '\u001b[23;2t'
/** Session state compared between renders to derive titles and attention signals. */
export interface SignalSnapshot { sessionId: string; title: string; running: boolean; pendingId?: string; pendingKind?: string }
const label = (value: string): string => safeText(value).replace(/[\r\n\t]/gu, ' ').slice(0, 120)
const SPINNER = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const
/**
 * A small circle of braille dots whose gap turns clockwise, shown before the name while a turn runs.
 * @param frame - animation frame; each frame turns the gap one dot.
 * @returns one braille glyph.
 */
export function titleSpinner(frame: number): string {
  return SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length] ?? '⣾'
}
/**
 * The OSC 2 window title naming the session and its state.
 * @param value - the session state to name.
 * @param frame - spinner frame while a turn runs; omitted for a still title.
 * @returns one escape sequence with every interpolated label escaped.
 */
export function terminalTitle(value: SignalSnapshot, frame?: number): string {
  const busy = value.pendingId === undefined && value.running
  const name = busy && frame !== undefined ? `${titleSpinner(frame)} DSH` : 'DSH'
  return `\u001b]2;${name} · ${label(value.title || 'New session')} · ${value.pendingId !== undefined ? 'attention' : value.running ? 'working' : 'ready'}\u0007`
}
/**
 * No completion notifications on first render, resume, or metadata updates.
 * @param previous - state at the previous render; undefined on first render.
 * @param next - current state.
 * @returns notification text for a new pending approval or question or an ended turn; otherwise undefined.
 */
export function attention(previous: SignalSnapshot | undefined, next: SignalSnapshot): string | undefined {
  if (previous === undefined || previous.sessionId !== next.sessionId) return undefined
  if (next.pendingId !== undefined && previous.pendingId !== next.pendingId) return next.pendingKind === 'approval' ? 'DSH · permission required' : 'DSH · your answer is required'
  if (previous.running && !next.running && next.pendingId === undefined) return 'DSH · turn ended'
  return undefined
}
/**
 * OSC 9 is opt-in: terminals may ignore it; no unsupported delivery claim is made.
 * @param text - notification text; escaped, single-line, at most 120 characters.
 * @param mode - `off` writes nothing, `bell` a BEL, `desktop` an OSC 9 notification.
 * @returns the bytes to write.
 */
export function notification(text: string, mode: 'off' | 'bell' | 'desktop'): string {
  return mode === 'off' ? '' : mode === 'desktop' ? `\u001b]9;${label(text)}\u0007` : '\u0007'
}
