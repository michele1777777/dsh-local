/** Unified or paired diff presentation. The underlying recorded change never changes. */
import { reviewDiff, type ReviewLine } from './diff.ts'
import { fitRow, row, span, wrapRow, type Row } from './rich-text.ts'
import { highlight, languageOf } from './syntax.ts'
import { joinPanes } from './panes.ts'
function side(line: ReviewLine | undefined, width: number, old: boolean, language: string): Row[] {
  if (line === undefined) return [row('')]
  const number = old ? line.oldLine : line.newLine
  const tone = line.sign === '-' ? 'error' : line.sign === '+' ? 'success' : 'muted'
  const prefix = `${String(number ?? '').padStart(4)} ${line.sign} `
  return wrapRow(row(...(line.sign === ' ' ? highlight(line.text, language) : [span(line.text, tone)])), Math.max(1, width - prefix.length))
    .map((part, index) => row(span(index === 0 ? prefix : ' '.repeat(prefix.length), tone), ...part.spans))
}
/**
 * Lay out recorded file changes as a header row per file followed by numbered, highlighted hunks. Public for exact layout/line-
 * preservation regression tests.
 * @param diffs - file changes; `oldText: null` marks a created file.
 * @param width - total row width in cells.
 * @param expanded - show every hunk line, side by side at 110 cells or wider; collapsed shows the first 6 lines and a count of the rest.
 * @returns the rendered rows.
 */
export function diffRows(diffs: readonly { path: string; oldText: string | null; newText: string }[],
  width: number, expanded: boolean): Row[] {
  const result: Row[] = []
  for (const diff of diffs) {
    const review = reviewDiff(diff.oldText, diff.newText), language = languageOf(diff.path)
    result.push(...wrapRow(row(span(diff.oldText === null ? 'Create ' : 'Update ', 'muted'), span(diff.path, 'accent', true), span(`  +${review.added}`, 'success'), span(` −${review.removed}`, 'error')), width))
    if (review.lines.length === 0) { result.push(row(span('No line changes', 'muted'))); continue }
    if (review.coarse) result.push(...wrapRow(row(span('Large replacement · non-minimal hunk, all changed lines retained', 'warning')), width))
    const lines = expanded ? review.lines : review.lines.slice(0, 6)
    if (expanded && width >= 110) {
      const left = Math.floor((width - 3) / 2), widths = { left, right: width - left - 3, divider: left }
      result.push(...joinPanes([row(span('BEFORE', 'muted', true))], [row(span('AFTER', 'accent', true))], widths, 1))
      const pair = (a: ReviewLine | undefined, b: ReviewLine | undefined): void => {
        const before = side(a, widths.left, true, language), after = side(b, widths.right, false, language)
        result.push(...joinPanes(before, after, widths, Math.max(before.length, after.length)))
      }
      for (let i = 0; i < lines.length;) {
        const line = lines[i++]
        if (line === undefined) continue
        if (line.hunk !== undefined) { result.push(fitRow(row(span(line.hunk, 'accent')), width)); continue }
        if (line.sign === ' ') { pair(line, line); continue }
        const removed: ReviewLine[] = [], added: ReviewLine[] = []
        ;(line.sign === '-' ? removed : added).push(line)
        for (let next = lines[i]; next !== undefined && next.hunk === undefined && next.sign !== ' '; next = lines[i]) {
          i++; (next.sign === '-' ? removed : added).push(next)
        }
        for (let j = 0; j < Math.max(removed.length, added.length); j++) pair(removed[j], added[j])
      }
    } else for (const line of lines) {
      if (line.hunk !== undefined) { result.push(fitRow(row(span(line.hunk, 'accent')), width)); continue }
      const prefix = width < 50 ? `${line.sign} ` : `${String(line.oldLine ?? '').padStart(4)} ${String(line.newLine ?? '').padStart(4)} ${line.sign} `
      const tone = line.sign === '+' ? 'success' : line.sign === '-' ? 'error' : 'muted'
      const body = line.sign === ' ' ? highlight(line.text, language) : [span(line.text, tone)]
      wrapRow(row(...body), Math.max(1, width - prefix.length)).forEach((part, index) => result.push(row(span(index === 0 ? prefix : ' '.repeat(prefix.length), tone), ...part.spans)))
    }
    if (!expanded && review.lines.length > lines.length) result.push(...wrapRow(row(span(`… ${review.lines.length - lines.length} diff lines · click tool to inspect · /diff to review`, 'muted')), width))
  }
  return result
}
