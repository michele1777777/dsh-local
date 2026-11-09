/** Responsive, cell-based pane layout and hit testing, independent of React or the terminal. */
import type { UiAction } from './actions.ts'
import { fitRow, row, span, textOfRow, widthOf, type Row } from './rich-text.ts'
/** Column widths in cells for a split layout. */
export interface PaneWidths { left: number; right: number; divider: number }
/**
 * Always open menus, session previews, and tool details in-page rather than
 * splitting a secondary side-menu to the right.
 * @param _width - terminal width; no width splits the screen.
 * @param _mode - requested layout; no mode splits the screen.
 * @returns always undefined: no split.
 */
export function paneWidths(_width: number, _mode: 'auto' | 'single' | 'split' = 'auto'): PaneWidths | undefined {
  return undefined
}
/**
 * Join without losing span actions or OSC link targets; pad both columns to a fixed height.
 * @param left - left column rows.
 * @param right - right column rows.
 * @param widths - column widths; each row is fitted to its column.
 * @param height - number of rows to produce; missing rows are blank.
 * @returns `height` rows with a muted `│` divider.
 */
export function joinPanes(left: readonly Row[], right: readonly Row[], widths: PaneWidths, height: number): Row[] {
  return Array.from({ length: height }, (_, index) => {
    const a = fitRow(left[index] ?? row(''), widths.left), b = fitRow(right[index] ?? row(''), widths.right)
    return row(...a.spans, ' '.repeat(Math.max(0, widths.left - widthOf(textOfRow(a)))), span(' │ ', 'muted'), ...b.spans)
  })
}
/**
 * SGR coordinates are zero based here. Blank space, stale/offscreen rows and half-open edges do not click.
 * @param rows - rows as painted on screen.
 * @param x - zero-based column.
 * @param y - zero-based row.
 * @returns the action of the span under the cell, or undefined.
 */
export function hitTest(rows: readonly Row[], x: number, y: number): UiAction | undefined {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) return undefined
  const value = rows[y]
  if (value === undefined) return undefined
  let at = 0
  for (const part of value.spans) {
    const end = at + widthOf(part.text)
    if (x >= at && x < end) return part.action
    at = end
  }
  return undefined
}
