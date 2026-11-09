/** Stable document anchors: new streamed rows do not drag a reader to the end. */
import type { Row } from './rich-text.ts'
/** Scroll position pinned to an item: rows below the item's first row, with an absolute row used when the item is gone. */
export interface Anchor { itemId?: string; local: number; fallback: number }
/**
 * Resolve an anchor to the viewport's first row.
 * @param rows - the rendered document.
 * @param height - viewport rows.
 * @param anchor - the anchor, or null to follow the end.
 * @returns the top row, clamped to the last full page.
 */
export function topOf(rows: readonly Row[], height: number, anchor: Anchor | null): number {
  const maximum = Math.max(0, rows.length - Math.max(1, height))
  if (anchor === null) return maximum
  const first = anchor.itemId === undefined ? -1 : rows.findIndex(row => row.itemId === anchor.itemId)
  return Math.max(0, Math.min(maximum, first < 0 ? anchor.fallback : first + anchor.local))
}
/**
 * Anchor a document row to the item that owns it.
 * @param rows - the rendered document.
 * @param top - the row to anchor; clamped to the document.
 * @returns the anchor for that row.
 */
export function anchorAt(rows: readonly Row[], top: number): Anchor {
  const position = Math.max(0, Math.min(Math.max(0, rows.length - 1), top))
  const itemId = rows[position]?.itemId
  const first = itemId === undefined ? position : rows.findIndex(row => row.itemId === itemId)
  return { ...(itemId === undefined ? {} : { itemId }), local: position - first, fallback: position }
}
/**
 * Scroll by a row delta.
 * @param rows - the rendered document.
 * @param height - viewport rows.
 * @param anchor - the current anchor, or null when following the end.
 * @param delta - rows to move; negative scrolls up.
 * @returns the new anchor, or null when the result reaches the last page and should follow new rows.
 */
export function scrollBy(rows: readonly Row[], height: number, anchor: Anchor | null, delta: number): Anchor | null {
  const maximum = Math.max(0, rows.length - Math.max(1, height))
  const next = Math.max(0, Math.min(maximum, topOf(rows, height, anchor) + delta))
  return next >= maximum ? null : anchorAt(rows, next)
}
/**
 * Scroll the minimum distance that makes a row visible.
 * @param rows - the rendered document.
 * @param height - viewport rows.
 * @param anchor - the current anchor, or null when following the end.
 * @param index - the row to show.
 * @returns the current anchor when the row is already visible, otherwise an anchor with the row at the top or bottom edge.
 */
export function reveal(rows: readonly Row[], height: number, anchor: Anchor | null, index: number): Anchor | null {
  const top = topOf(rows, height, anchor)
  if (index >= top && index < top + height) return anchor
  return anchorAt(rows, index < top ? index : index - height + 1)
}
/** One user prompt in the document: its item, its first row and its `› You` heading row. */
export interface PromptMark { itemId: string; first: number; heading: number }
/**
 * Locate user prompts in rendered rows.
 * @param rows - the rendered document.
 * @param prompts - item ids of the user messages.
 * @returns the prompts in document order.
 */
export function promptMarks(rows: readonly Row[], prompts: ReadonlySet<string>): PromptMark[] {
  const marks: PromptMark[] = []
  rows.forEach((value, index) => {
    if (value.itemId === undefined || !prompts.has(value.itemId)) return
    const last = marks.at(-1)
    if (last?.itemId !== value.itemId) marks.push({ itemId: value.itemId, first: index, heading: value.heading === true ? index : -1 })
    else if (value.heading === true && last.heading < 0) last.heading = index
  })
  return marks.map(mark => mark.heading < 0 ? { ...mark, heading: mark.first } : mark)
}
/**
 * The request of the section being read, named by the sticky prompt header:
 * the latest prompt whose heading is at or above the top row, which the
 * header covers. A prompt shown from its first row, as a jump leaves it, is
 * not above the top, so the header then names the one before it and repeated
 * jumps walk back through the conversation.
 * @param marks - prompts in document order.
 * @param top - first document row of the viewport.
 * @returns the prompt to name, or undefined when none starts above the viewport.
 */
export function promptAbove(marks: readonly PromptMark[], top: number): PromptMark | undefined {
  return marks.findLast(mark => mark.heading <= top)
}
/**
 * The next prompt down: the first one starting below the top row.
 * @param marks - prompts in document order.
 * @param top - first document row of the viewport.
 * @returns the prompt, or undefined after the last one.
 */
export function promptBelow(marks: readonly PromptMark[], top: number): PromptMark | undefined {
  return marks.find(mark => mark.first > top)
}
/**
 * Put a prompt's first row, the spacer above `› You`, at the top of the
 * viewport, where the sticky header may cover it.
 * @param rows - the rendered document.
 * @param height - viewport rows.
 * @param mark - the prompt to show.
 * @returns the anchor, or null when the prompt sits on the live last page.
 */
export function promptAnchor(rows: readonly Row[], height: number, mark: PromptMark): Anchor | null {
  const maximum = Math.max(0, rows.length - Math.max(1, height))
  return mark.first >= maximum ? null : anchorAt(rows, mark.first)
}
