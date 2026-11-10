/** Cell-bounded display rows; raw model messages never pass through this module. */
import { cellWidth } from './layout.ts'
import { safeText } from './terminal.ts'
import type { UiAction } from './actions.ts'
import type { BackgroundTone, Tone } from './theme.ts'
/** A run of text with one style; `href` emits an OSC 8 link and `action` makes the run clickable. */
export interface Span {
  text: string
  tone?: Tone
  /** The background under the run; themes without that tone leave the terminal background. */
  background?: BackgroundTone
  bold?: boolean
  italic?: boolean
  inverse?: boolean
  underline?: boolean
  href?: string
  action?: UiAction
}
/** One display line; `itemId` names the transcript item it belongs to. */
export interface Row { spans: Span[]; itemId?: string; heading?: boolean; codeHeader?: boolean }
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/** Printable ASCII, tab and newline hold one grapheme per code unit, so such text skips the segmenter. */
const SIMPLE = /^[\t\n\x20-\x7e]*$/u, PRINTABLE = /^[\x20-\x7e]*$/u
/** The grapheme clusters of `text`. */
function graphemes(text: string): Iterable<string> {
  return SIMPLE.test(text) ? text : Array.from(segments.segment(text), part => part.segment)
}
/**
 * A styled span.
 * @param text - the span text.
 * @param tone - the theme tone.
 * @param bold - whether the span is bold.
 * @returns the span.
 */
export const span = (text: string, tone: Tone = 'text', bold = false): Span => ({ text, tone, bold })
/**
 * A row of spans.
 * @param spans - the spans; strings become default-tone spans.
 * @returns the row.
 */
export const row = (...spans: (Span | string)[]): Row => ({ spans: spans.map(value => typeof value === 'string' ? span(value) : value) })
/**
 * The unstyled text of a row.
 * @param value - the row.
 * @returns its span texts joined.
 */
export const textOfRow = (value: Row): string => value.spans.map(part => part.text).join('')
/**
 * The terminal cell width of text, measured per grapheme cluster.
 * @param text - the text.
 * @returns the width in cells.
 */
export function widthOf(text: string): number {
  if (PRINTABLE.test(text)) return text.length
  let width = 0
  for (const part of segments.segment(text)) width += cellWidth(part.segment)
  return width
}
function append(parts: Span[], style: Span, text: string): void {
  const last = parts.at(-1)
  if (last !== undefined && last.tone === style.tone && last.bold === style.bold && last.italic === style.italic
    && last.inverse === style.inverse && last.underline === style.underline && last.background === style.background
    && last.href === style.href && last.action === style.action) last.text += text
  else parts.push({ ...style, text })
}
/**
 * The column limit each row this module produced was fitted to. A row already
 * fitted to that limit or a narrower one needs no second pass: laying out a
 * streamed message repeats these passes on every frame, and escaping and
 * grapheme segmentation are the expensive part of them.
 */
const fitted = new WeakMap<Row, number>()
/** Records a row as fitted, and returns it. */
function fit(value: Row, limit: number): Row {
  fitted.set(value, Math.min(limit, fitted.get(value) ?? limit))
  return value
}
/**
 * Wrap all content, with style/grapheme boundaries intact. Nothing is discarded.
 * @param value - the row to wrap; escapes are made safe and tabs expand to 4-column stops.
 * @param width - the column limit, at least 1.
 * @returns one row per display line; a row already fitted to `width` or narrower is returned as is.
 */
export function wrapRow(value: Row, width: number): Row[] {
  const limit = Math.max(1, Math.floor(width))
  const already = fitted.get(value)
  if (already !== undefined && already <= limit) return [value]
  const output: Row[] = []
  let parts: Span[] = []; let used = 0
  const emit = (): void => { output.push(fit({ ...value, spans: parts.length === 0 ? [span('')] : parts }, limit)); parts = []; used = 0 }
  for (const style of value.spans) {
    for (const segment of graphemes(safeText(style.text).replace(/\r\n?/gu, '\n'))) {
      if (segment === '\n') { emit(); continue }
      const text = segment === '\t' ? ' '.repeat(4 - used % 4) : segment
      for (const cell of graphemes(text)) {
        const size = cellWidth(cell)
        if (used + size > limit && used > 0) emit()
        // A two-cell grapheme cannot fit in a one-column terminal.
        if (size > limit) { append(parts, style, '�'); used++; continue }
        append(parts, style, cell); used += size
      }
    }
  }
  emit()
  return output
}
/**
 * Single-line UI metadata only; conversation bodies use wrapRow instead.
 * @param value - the row; whitespace, including newlines, becomes spaces.
 * @param width - the column limit.
 * @param ellipsis - the muted marker appended when text is cut.
 * @returns the row truncated to `width` cells.
 */
export function fitRow(value: Row, width: number, ellipsis = '…'): Row {
  const clean: Row = { ...value, spans: value.spans.map(part => ({ ...part, text: safeText(part.text).replace(/\s/gu, ' ') })) }
  if (widthOf(textOfRow(clean)) <= width) return fit(clean, Math.max(0, width))
  const result: Span[] = []; let used = 0
  const limit = Math.max(0, width - widthOf(ellipsis))
  outer: for (const style of clean.spans) {
    for (const part of graphemes(style.text)) {
      const size = cellWidth(part)
      if (used + size > limit) break outer
      append(result, style, part); used += size
    }
  }
  if (width > 0) result.push(span(ellipsis, 'muted'))
  return fit({ ...value, spans: result }, Math.max(0, width))
}
/**
 * Right-pads text with spaces.
 * @param text - the text.
 * @param width - the target cell width.
 * @returns `text` padded to `width` cells; longer text is unchanged.
 */
export function padText(text: string, width: number): string { return text + ' '.repeat(Math.max(0, width - widthOf(text))) }
/**
 * A row on a background that runs its whole width: every span takes `tone` unless it has its own background, and spaces
 * pad the row to `width` cells.
 * @param value - the row, no wider than `width`.
 * @param width - cells the background covers.
 * @param tone - the background tone.
 * @returns the padded row, fitted to `width`.
 */
export function onBackground(value: Row, width: number, tone: BackgroundTone): Row {
  const used = widthOf(textOfRow(value))
  const spans: Span[] = value.spans.map(part => part.background === undefined ? { ...part, background: tone } : part)
  if (used < width) spans.push({ text: ' '.repeat(width - used), background: tone })
  return fit({ ...value, spans }, Math.max(0, width))
}
/**
 * A muted horizontal rule.
 * @param width - the rule width in cells.
 * @param label - optional text set into the rule's start.
 * @returns the rule row.
 */
export function rule(width: number, label = ''): Row {
  const prefix = label === '' ? '' : `── ${label} `
  return fitRow(row(span(prefix + '─'.repeat(Math.max(0, width - widthOf(prefix))), 'muted')), width)
}
/** Narrowest box that keeps both side borders and one cell of content. */
export const BOX_MIN_WIDTH = 6
/**
 * The top border of a closed box, `╭─ caption ───── label ─╮`, exactly `width` cells.
 * @param caption - spans set after `╭─ `; cut, or left out, to leave room for the label and one rule cell.
 * @param width - total width including corners, at least {@link BOX_MIN_WIDTH}.
 * @param tone - border tone.
 * @param label - spans set before the top-right corner, such as a button; omitted when it cannot fit.
 * @returns the border row; caption and label keep their own spans.
 */
export function boxTop(caption: readonly Span[], width: number, tone: Tone, label: readonly Span[] = []): Row {
  const labelWidth = widthOf(textOfRow(row(...label)))
  const shown = labelWidth > 0 && labelWidth + 7 <= width ? label : []
  const tail = shown.length === 0 ? 1 : labelWidth + 4
  const head = fitRow(row(...caption), Math.max(0, width - 5 - tail))
  const headWidth = widthOf(textOfRow(head))
  const opening = headWidth === 0 ? [span('╭─', tone)] : [span('╭─ ', tone), ...head.spans]
  const fill = Math.max(0, width - widthOf(textOfRow(row(...opening))) - tail - (headWidth === 0 ? 0 : 1))
  const middle = span(`${headWidth === 0 ? '' : ' '}${'─'.repeat(fill)}${shown.length === 0 ? '' : ' '}`, tone)
  return fit(row(...opening, middle, ...shown, span(shown.length === 0 ? '╮' : ' ─╮', tone)), Math.max(0, width))
}
/**
 * One body row of a closed box: `│ content │`, padded so every right border shares one column.
 * @param content - a row no wider than `width - 4`; wider content is cut.
 * @param width - total width including borders.
 * @param tone - border tone.
 * @returns the bordered row.
 */
export function boxLine(content: Row, width: number, tone: Tone): Row {
  const inner = Math.max(0, width - 4), fitted = fitRow(content, inner)
  return fit({ ...content, spans: [span('│ ', tone), ...fitted.spans, span(`${' '.repeat(Math.max(0, inner - widthOf(textOfRow(fitted))))} │`, tone)] }, Math.max(0, width))
}
/**
 * The bottom border of a closed box, `╰────╯`.
 * @param width - total width including corners.
 * @param tone - border tone.
 * @returns the border row.
 */
export function boxBottom(width: number, tone: Tone): Row {
  return fit(row(span(`╰${'─'.repeat(Math.max(0, width - 2))}╯`, tone)), Math.max(0, width))
}
/**
 * Replace one span's text without moving the rest of the row: a run of `─` that ends the preceding span absorbs the width
 * difference, so a rule's end stays in its column.
 * @param value - the row.
 * @param index - the span to relabel.
 * @param text - its new text.
 * @param style - extra style for the relabelled span.
 * @returns the relabelled row; without an adjustable rule run only the span text changes.
 */
export function relabel(value: Row, index: number, text: string, style: Partial<Span> = {}): Row {
  const target = value.spans[index]
  if (target === undefined) return value
  const delta = widthOf(text) - widthOf(target.text)
  const spans = value.spans.map((part, at) => at === index ? { ...part, ...style, text } : part)
  const before = spans[index - 1], rule = before === undefined ? undefined : /─+(?=\s*$)/u.exec(before.text)
  if (before !== undefined && rule !== null && rule !== undefined && rule[0].length > delta) {
    const kept = '─'.repeat(rule[0].length - delta)
    spans[index - 1] = { ...before, text: before.text.slice(0, rule.index) + kept + before.text.slice(rule.index + rule[0].length) }
  }
  return { ...value, spans }
}
/**
 * Places `left` and `right` at opposite ends of one row.
 * @param left - the left content, truncated to the space `right` leaves.
 * @param right - the right content, truncated to 55% of `width`.
 * @param width - the row width in cells.
 * @returns the combined row.
 */
export function twoSides(left: Row, right: Row, width: number): Row {
  const r = fitRow(right, Math.max(0, Math.floor(width * 0.55)))
  const l = fitRow(left, Math.max(0, width - widthOf(textOfRow(r)) - 2))
  return row(...l.spans, ' '.repeat(Math.max(1, width - widthOf(textOfRow(l)) - widthOf(textOfRow(r)))), ...r.spans)
}
/**
 * Wraps rows and prefixes every resulting line.
 * @param rows - the rows to indent.
 * @param prefix - the muted prefix.
 * @param width - the total width including the prefix.
 * @param marker - replaces the prefix on the first line; it must be as wide as `prefix`.
 * @returns the wrapped, prefixed rows.
 */
export function indentRows(rows: readonly Row[], prefix = '  ', width = 80, marker?: Span): Row[] {
  const limit = Math.max(1, width - widthOf(prefix))
  let first = marker !== undefined
  return rows.flatMap(value => wrapRow(value, limit).map((line) => {
    const lead = first && marker !== undefined ? marker : span(prefix, 'muted')
    first = false
    return fit({ ...line, spans: [lead, ...line.spans] }, Math.max(1, width))
  }))
}
/**
 * Word-aware prose wrapping; long tokens still wrap by complete graphemes.
 * @param value - the row to wrap.
 * @param width - the column limit, at least 1.
 * @returns one row per display line.
 */
export function wrapProse(value: Row, width: number): Row[] {
  const limit = Math.max(1, Math.floor(width))
  const tokens: { parts: Span[]; whitespace: boolean; newline: boolean; width: number }[] = []
  for (const style of value.spans) for (const text of safeText(style.text).split(/(\n|[^\S\n]+|[^\s]+)/u).filter(Boolean)) {
    const whitespace = /^\s+$/u.test(text), newline = text === '\n', last = tokens.at(-1)
    if (last !== undefined && !last.newline && !newline && whitespace === last.whitespace) {
      last.parts.push({ ...style, text })
      last.width += widthOf(text)
    }
    else tokens.push({ parts: [{ ...style, text }], whitespace, newline, width: widthOf(text) })
  }
  const result: Row[] = []; let parts: Span[] = [], used = 0
  const emit = (): void => { result.push(fit({ ...value, spans: parts.length === 0 ? [span('')] : parts }, limit)); parts = []; used = 0 }
  for (const token of tokens) {
    if (token.newline) { emit(); continue }
    // Spaces that would overflow become the line break; the next line starts with the next word.
    if (token.whitespace && used > 0 && used + token.width > limit) { emit(); continue }
    if (!token.whitespace && token.width <= limit && used > 0 && used + token.width > limit) emit()
    for (const style of token.parts) for (const part of graphemes(style.text)) {
      const text = part === '\t' ? ' '.repeat(4 - used % 4) : part
      for (const cell of graphemes(text)) {
        const size = cellWidth(cell)
        if (used > 0 && used + size > limit) emit()
        append(parts, style, size > limit ? '�' : cell); used += Math.min(size, limit)
      }
    }
  }
  emit(); return result
}
