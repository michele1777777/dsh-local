/** Unified or paired diff presentation. The underlying recorded change never changes. */
import { reviewDiff, type ReviewLine } from './diff.ts'
import { fitRow, onBackground, row, span, wrapRow, type Row, type Span } from './rich-text.ts'
import { highlight, languageOf } from './syntax.ts'
import { joinPanes } from './panes.ts'
import type { BackgroundTone } from './theme.ts'

/** The part of a changed line that differs from its counterpart, as offsets into the line's text. */
interface Changed { from: number; to: number }

/**
 * The parts that differ between a removed line and the added line that replaced it: what is left after their common start
 * and common end.
 * @param before - the removed line.
 * @param after - the added line.
 * @returns the differing range of each line, or undefined when the lines share less than a third of the shorter one and
 *   so read as different lines rather than one edited line.
 */
function changedParts(before: string, after: string): { before: Changed; after: Changed } | undefined {
  const limit = Math.min(before.length, after.length)
  let start = 0
  while (start < limit && before[start] === after[start]) start++
  let end = 0
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  if (start + end < Math.ceil(limit / 3) || start + end === 0) return undefined
  return { before: { from: start, to: before.length - end }, after: { from: start, to: after.length - end } }
}

/** For every removed line that an added line replaced in place, and that added line, the part that changed. */
function emphasis(lines: readonly ReviewLine[]): Map<ReviewLine, Changed> {
  const found = new Map<ReviewLine, Changed>()
  for (let index = 0; index < lines.length;) {
    const removed: ReviewLine[] = [], added: ReviewLine[] = []
    for (let line = lines[index]; line !== undefined && line.hunk === undefined && line.sign !== ' '; line = lines[++index]) {
      (line.sign === '-' ? removed : added).push(line)
    }
    removed.forEach((line, at) => {
      const pair = added[at]
      const parts = pair === undefined ? undefined : changedParts(line.text, pair.text)
      if (parts === undefined || pair === undefined) return
      found.set(line, parts.before); found.set(pair, parts.after)
    })
    if (removed.length + added.length === 0) index++
  }
  return found
}

/** Highlighted spans of a line with `strong` under the cells from `part.from` to `part.to`. */
function marked(spans: readonly Span[], part: Changed | undefined, strong: BackgroundTone): Span[] {
  if (part === undefined || part.from >= part.to) return [...spans]
  const output: Span[] = []
  let at = 0
  for (const value of spans) {
    const end = at + value.text.length
    const from = Math.max(at, part.from), to = Math.min(end, part.to)
    if (from >= to) output.push(value)
    else {
      if (from > at) output.push({ ...value, text: value.text.slice(0, from - at) })
      output.push({ ...value, text: value.text.slice(from - at, to - at), background: strong })
      if (to < end) output.push({ ...value, text: value.text.slice(to - at) })
    }
    at = end
  }
  return output
}

/**
 * One line of a diff, `width` cells wide: its number, its sign in the success or error tone, and its highlighted text. A
 * changed line stands on the added or removed background across the whole width, with the stronger background under the
 * part that differs from its counterpart; a context line has no background.
 */
function lineRows(line: ReviewLine, number: number | undefined, width: number, language: string, part: Changed | undefined,
  numbered: boolean): Row[] {
  const changed = line.sign !== ' '
  const tone = line.sign === '+' ? 'success' : line.sign === '-' ? 'error' : 'muted'
  const sign = line.sign === '-' ? '−' : line.sign
  const prefix = numbered ? `${String(number ?? '').padStart(4)} ` : ''
  const body = marked(highlight(line.text, language), part, line.sign === '+' ? 'addedStrong' : 'removedStrong')
  return wrapRow(row(...body), Math.max(1, width - prefix.length - 2)).map((wrapped, index) => {
    const value = row(span(index === 0 ? prefix : ' '.repeat(prefix.length), 'comment'), span(index === 0 ? `${sign} ` : '  ', tone, true), ...wrapped.spans)
    return changed ? onBackground(value, width, line.sign === '+' ? 'added' : 'removed') : value
  })
}

/**
 * Lay out recorded file changes as a header row per file followed by numbered, highlighted hunks. Added and removed lines
 * stand on their own background, and a line edited in place has the stronger background under the part that changed.
 * Public for exact layout and line-preservation regression tests.
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
    const parts = emphasis(lines)
    if (expanded && width >= 110) {
      const left = Math.floor((width - 3) / 2), widths = { left, right: width - left - 3, divider: left }
      result.push(...joinPanes([row(span('BEFORE', 'muted', true))], [row(span('AFTER', 'muted', true))], widths, 1))
      const pair = (a: ReviewLine | undefined, b: ReviewLine | undefined): void => {
        const before = a === undefined ? [row('')] : lineRows(a, a.oldLine, widths.left, language, parts.get(a), true)
        const after = b === undefined ? [row('')] : lineRows(b, b.newLine, widths.right, language, parts.get(b), true)
        result.push(...joinPanes(before, after, widths, Math.max(before.length, after.length)))
      }
      for (let i = 0; i < lines.length;) {
        const line = lines[i++]
        if (line === undefined) continue
        if (line.hunk !== undefined) { result.push(fitRow(row(span(line.hunk, 'muted')), width)); continue }
        if (line.sign === ' ') { pair(line, line); continue }
        const removed: ReviewLine[] = [], added: ReviewLine[] = []
        ;(line.sign === '-' ? removed : added).push(line)
        for (let next = lines[i]; next !== undefined && next.hunk === undefined && next.sign !== ' '; next = lines[i]) {
          i++; (next.sign === '-' ? removed : added).push(next)
        }
        for (let j = 0; j < Math.max(removed.length, added.length); j++) pair(removed[j], added[j])
      }
    } else for (const line of lines) {
      if (line.hunk !== undefined) { result.push(fitRow(row(span(line.hunk, 'muted')), width)); continue }
      // One number column: the old line of a removed line, the new line of every other.
      result.push(...lineRows(line, line.sign === '-' ? line.oldLine : line.newLine, width, language, parts.get(line), width >= 50))
    }
    if (!expanded && review.lines.length > lines.length) result.push(...wrapRow(row(span(`… ${review.lines.length - lines.length} diff lines · click tool to inspect`, 'muted')), width))
  }
  return result
}
