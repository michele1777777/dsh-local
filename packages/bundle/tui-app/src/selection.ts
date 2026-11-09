/**
 * Mouse text selection over rendered rows.
 *
 * Selection is a view over a frozen document or screen frame: it reads what the
 * reader sees, wrapped exactly as the terminal wrapped it, and never reaches
 * back into the transcript model. Whole rows between the two ends are taken,
 * the first and last are cut at their cell, and trailing blanks are dropped so
 * padded columns do not travel with the text.
 * @module @deepseek-ai/dsh-tui-app/selection
 */

import { cellWidth } from './layout.ts'
import type { Row, Span } from './rich-text.ts'

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** One cell, in the coordinates of the supplied row array. */
export interface Point { x: number; y: number }
/** A drag: where the button went down and where the pointer is now. */
export interface Selection { anchor: Point; head: Point }

/**
 * Order the two ends, so `from` precedes `to` on screen.
 * @param value - the drag.
 * @returns the ends in reading order.
 */
export function selectionRange(value: Selection): { from: Point; to: Point } {
  const { anchor, head } = value
  const forward = anchor.y < head.y || (anchor.y === head.y && anchor.x <= head.x)
  return forward ? { from: anchor, to: head } : { from: head, to: anchor }
}

/** Cells selected on one row, as a half-open column range. */
function columns(value: Selection, y: number, width: number): { start: number; end: number } | undefined {
  const { from, to } = selectionRange(value)
  if (y < from.y || y > to.y) return undefined
  // The cell under the pointer belongs to the selection, as a terminal's own
  // drag does; a row in the middle is taken whole.
  const start = y === from.y ? from.x : 0
  const end = y === to.y ? to.x + 1 : width
  return end > start ? { start, end } : undefined
}

/** Walk one row's graphemes with the cell each occupies. */
function* cells(value: Row): Generator<{ style: Span; text: string; at: number; width: number }> {
  let at = 0
  for (const style of value.spans) {
    for (const part of segments.segment(style.text)) {
      const width = cellWidth(part.segment)
      yield { style, text: part.segment, at, width }
      at += width
    }
  }
}

/**
 * True when the drag covers no cell, as a plain click does.
 * @param value - the drag, or undefined when none.
 * @returns true for no drag or one whose ends coincide.
 */
export function isEmptySelection(value: Selection | undefined): boolean {
  if (value === undefined) return true
  return value.anchor.x === value.head.x && value.anchor.y === value.head.y
}

/**
 * The selected text, ready for the clipboard.
 * @param rows - the painted frame, unmodified.
 * @param value - the drag to read.
 * @returns one line per covered row, without trailing blanks or empty tail lines.
 */
export function selectedText(rows: readonly Row[], value: Selection | undefined): string {
  if (value === undefined) return ''
  const { from, to } = selectionRange(value)
  const lines: string[] = []
  for (let y = from.y; y <= Math.min(to.y, rows.length - 1); y++) {
    const line = rows[y]
    if (line === undefined) continue
    const range = columns(value, y, Number.MAX_SAFE_INTEGER)
    if (range === undefined) { lines.push(''); continue }
    let text = ''
    for (const cell of cells(line)) if (cell.at >= range.start && cell.at < range.end) text += cell.text
    lines.push(text.replace(/\s+$/u, ''))
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/**
 * Show the selected cells inverse, leaving every other style untouched.
 * @param rows - the painted frame.
 * @param value - the drag, or undefined when none.
 * @returns new rows with the inverse flag toggled on selected cells; unselected rows are the same objects.
 */
export function paintSelection(rows: readonly Row[], value: Selection | undefined): Row[] {
  if (value === undefined || isEmptySelection(value)) return [...rows]
  return rows.map((line, y) => {
    const range = columns(value, y, Number.MAX_SAFE_INTEGER)
    if (range === undefined) return line
    const spans: Span[] = []
    for (const cell of cells(line)) {
      const inverse = cell.at >= range.start && cell.at < range.end ? !(cell.style.inverse === true) : cell.style.inverse === true
      const last = spans.at(-1)
      if (last !== undefined && last.tone === cell.style.tone && last.bold === cell.style.bold
        && last.italic === cell.style.italic && last.underline === cell.style.underline
        && last.href === cell.style.href && last.inverse === inverse) last.text += cell.text
      else spans.push({ ...cell.style, inverse, text: cell.text })
    }
    return { ...line, spans: spans.length === 0 ? line.spans : spans }
  })
}
