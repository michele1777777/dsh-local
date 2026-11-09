/** Small terminal-layout helpers, independent of Ink and of prompt admission. */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/**
 * Common terminal cell widths; ambiguous-width characters follow narrow locales.
 * @param value - one grapheme.
 * @returns cells occupied: 0, 1, 2, or 4 for a tab.
 */
export function cellWidth(value: string): number {
  if (value === '\t') return 4
  if (value.length === 1 && value >= ' ' && value <= '~') return 1
  if (/^[\p{Mark}\u0000-\u001f\u007f-\u009f]+$/u.test(value)) return 0
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)) return 2
  const code = value.codePointAt(0) ?? 0
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x20000 && code <= 0x3fffd)) ? 2 : 1
}
/** One soft-wrapped line: UTF-16 offsets `[start, end)` into the draft and its visible text. */
export interface VisualLine { start: number; end: number; text: string }
/**
 * Keep UTF-16 offsets so the visible cursor points into the unmodified draft.
 * @param text - draft text; `\n` starts a new line.
 * @param width - cells per line, at least 1.
 * @returns at least one visual line.
 */
export function wrapEditor(text: string, width: number): VisualLine[] {
  const limit = Math.max(1, width)
  const lines: VisualLine[] = []
  let start = 0; let cells = 0; let shown = ''
  for (const part of graphemes.segment(text)) {
    if (part.segment === '\n') {
      lines.push({ start, end: part.index, text: shown })
      start = part.index + 1; cells = 0; shown = ''; continue
    }
    const size = cellWidth(part.segment)
    if (cells + size > limit && cells > 0) {
      lines.push({ start, end: part.index, text: shown })
      start = part.index; cells = 0; shown = ''
    }
    shown += part.segment; cells += size
  }
  lines.push({ start, end: text.length, text: shown })
  return lines
}
/**
 * Last soft-wrapped lines of streaming text.
 * @param text - full text.
 * @param width - cells per line.
 * @param limit - most lines kept.
 * @returns the kept lines joined by `\n` and the count of hidden leading lines.
 */
export function liveTail(text: string, width: number, limit: number): { text: string; hidden: number } {
  const lines = wrapEditor(text, width)
  const hidden = Math.max(0, lines.length - limit)
  return { text: lines.slice(hidden).map(line => line.text).join('\n'), hidden }
}
/**
 * Cursor line for soft wrapping (a boundary belongs to the following line).
 * @param lines - output of `wrapEditor`.
 * @param cursor - UTF-16 offset.
 * @returns index into `lines`; the last line when no line contains the cursor.
 */
export function activeLine(lines: readonly VisualLine[], cursor: number): number {
  const found = lines.findIndex((line, index) => {
    const atLineEnd = cursor === line.end && lines[index + 1]?.start !== cursor
    return cursor >= line.start && (cursor < line.end || atLineEnd)
  })
  return found < 0 ? Math.max(0, lines.length - 1) : found
}
/**
 * Move by terminal cells across soft-wrapped lines without splitting a grapheme.
 * @param state - draft text and cursor.
 * @param direction - -1 for the line above, 1 for the line below.
 * @param width - cells per line.
 * @returns the moved state, or undefined at the first or last line.
 */
export function moveVisual(state: { text: string; cursor: number }, direction: -1 | 1,
  width: number): { text: string; cursor: number } | undefined {
  const lines = wrapEditor(state.text, width)
  const active = activeLine(lines, state.cursor), target = lines[active + direction]
  if (target === undefined) return undefined
  let column = 0
  for (const part of graphemes.segment(state.text.slice(lines[active]?.start ?? 0, state.cursor))) column += cellWidth(part.segment)
  let used = 0, offset = target.start
  for (const part of graphemes.segment(target.text)) {
    const size = cellWidth(part.segment)
    if (used + size > column) break
    used += size; offset = target.start + part.index + part.segment.length
  }
  return { text: state.text, cursor: offset }
}
