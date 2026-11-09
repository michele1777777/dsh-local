/**
 * Wheel reporting for the alternate screen.
 *
 * With reporting disabled a terminal answers the wheel with cursor-key
 * presses, which the composer reads as prompt history rather than as
 * scrolling. Button-event reporting (1002) with SGR coordinates (1006)
 * delivers the wheel, each button press and the motion between a press and
 * its release as their own escape sequences. Drag motion is what lets this
 * application draw and copy a selection itself, which is the trade for the
 * terminal's own selection: most terminals still select with Shift held, and
 * `/mouse off` restores the terminal's handling for the rest of the session.
 * @module @deepseek-ai/dsh-tui-app/mouse
 */

/** Button and drag reporting with SGR coordinates; written once the screen is owned. */
export const MOUSE_ON = '\u001b[?1002h\u001b[?1006h'
/** Restores the terminal's own mouse handling. Written before the screen is released. */
export const MOUSE_OFF = '\u001b[?1006l\u001b[?1002l\u001b[?1000l'
/** Rows one wheel notch moves, matching the step terminals scroll by. */
export const WHEEL_ROWS = 3

/** A vertical wheel notch: −1 scrolls towards older rows, 1 towards newer. */
export interface WheelReport { kind: 'wheel'; direction: -1 | 1; ctrl: boolean; shift: boolean; x: number; y: number }
/**
 * Any other report: recognized so its bytes never reach the prompt.
 * `motion` marks a drag sample, which carries the button held at the press.
 */
export type ButtonReport = { kind: 'legacy' }
  | { kind: 'button'; x: number; y: number; pressed: boolean; primary: boolean; modified: boolean; motion: boolean }
/** One recognized mouse report. */
export type MouseReport = WheelReport | ButtonReport

const SGR = /^\u001b?\[<(\d+);(\d+);(\d+)([Mm])$/u
/** Bytes a legacy X10 report appends after its prefix, to be dropped. */
export const LEGACY_BYTES = 3

/**
 * Classify one input event as a mouse report.
 * @param input - one keypress event, with or without its escape prefix.
 * @returns the report, or undefined when the event is ordinary key input.
 */
export function parseMouse(input: string): MouseReport | undefined {
  // A terminal that ignores 1006 answers in X10 encoding, whose three
  // coordinate bytes arrive as plain text; the prefix is reported so the
  // caller can drop them instead of inserting them into the prompt.
  if (input === '\u001b[M' || input === '[M') return { kind: 'legacy' }
  const match = SGR.exec(input)
  if (match === null) return undefined
  const code = Number(match[1] ?? '0')
  const x = Math.max(0, Number(match[2]) - 1), y = Math.max(0, Number(match[3]) - 1)
  const motion = (code & 32) !== 0
  const button: ButtonReport = {
    kind: 'button', x, y, motion, pressed: match[4] === 'M',
    primary: (code & 3) === 0, modified: (code & 28) !== 0,
  }
  if ((code & 64) === 0) return button
  const axis = code & 3
  // Horizontal notches (2, 3) carry no vertical intent.
  if (axis > 1) return { ...button, primary: false }
  return { kind: 'wheel', direction: axis === 0 ? -1 : 1, ctrl: (code & 16) !== 0, shift: (code & 4) !== 0, x, y }
}
