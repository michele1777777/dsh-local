/**
 * A small line diff for the terminal's diff cards. Exact (LCS) for files the
 * terminal can show, summarized beyond that: a chat card is a glance at what
 * changed, not a review surface.
 * @module @deepseek-ai/dsh-tui-app/diff
 */

export interface DiffLine {
  sign: ' ' | '+' | '-'
  text: string
}

/** Largest old×new product the exact algorithm runs on. */
const EXACT_LIMIT = 250_000

/** Lines of unchanged context kept around each change. */
const CONTEXT = 1

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Exact LCS-based line operations, oldest to newest. */
function exact(before: string[], after: string[]): DiffLine[] {
  const n = before.length
  const m = after.length
  // table[i][j] = LCS length of before[i..] and after[j..]
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i]
    const next = table[i + 1]
    if (row === undefined || next === undefined) continue
    for (let j = m - 1; j >= 0; j--) {
      row[j] = before[i] === after[j]
        ? (next[j + 1] ?? 0) + 1
        : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ sign: ' ', text: before[i] ?? '' })
      i++
      j++
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      out.push({ sign: '-', text: before[i] ?? '' })
      i++
    } else {
      out.push({ sign: '+', text: after[j] ?? '' })
      j++
    }
  }
  while (i < n) out.push({ sign: '-', text: before[i++] ?? '' })
  while (j < m) out.push({ sign: '+', text: after[j++] ?? '' })
  return out
}

/** Keep changed lines and a little context; mark elisions with `…`. */
function trimContext(lines: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.sign === ' ') return
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k++) keep[k] = true
  })
  const out: DiffLine[] = []
  let skipping = false
  lines.forEach((line, index) => {
    if (keep[index] === true) {
      out.push(line)
      skipping = false
    } else if (!skipping) {
      out.push({ sign: ' ', text: '…' })
      skipping = true
    }
  })
  return out
}

/**
 * Diff two texts as lines.
 * @param oldText - the previous content, or `null` for a created file.
 * @param newText - the new content.
 * @param cap - maximum lines returned; a longer diff ends with a summary line.
 * @returns signed lines with surrounding context; inputs too large for an exact diff yield a coarse removed/added listing.
 */
export function lineDiff(oldText: string | null, newText: string, cap = 60): DiffLine[] {
  const after = splitLines(newText)
  if (oldText === null) {
    const lines = after.map((text): DiffLine => ({ sign: '+', text }))
    return lines.length > cap ? [...lines.slice(0, cap), { sign: ' ', text: `… +${String(lines.length - cap)} more lines` }] : lines
  }
  const before = splitLines(oldText)
  let lines: DiffLine[]
  if (before.length * after.length <= EXACT_LIMIT) {
    lines = trimContext(exact(before, after))
  } else {
    lines = [
      ...before.slice(0, cap / 2).map((text): DiffLine => ({ sign: '-', text })),
      ...after.slice(0, cap / 2).map((text): DiffLine => ({ sign: '+', text })),
    ]
    return [...lines, { sign: ' ', text: `Large diff: coarse comparison of ${before.length} old / ${after.length} new lines; use /export for the retained file texts.` }]
  }
  if (lines.length <= cap) return lines
  const added = lines.filter(line => line.sign === '+').length
  const removed = lines.filter(line => line.sign === '-').length
  return [...lines.slice(0, cap), { sign: ' ', text: `… ${String(lines.length - cap)} more (+${String(added)} −${String(removed)} in total)` }]
}

/** Numbered, reviewable hunks. Large replacements are valid, non-minimal diffs. */
export interface ReviewLine extends DiffLine { oldLine?: number; newLine?: number; hunk?: string }
/** Hunks with line numbers and change counts; `coarse` marks a replacement too large for an exact diff. */
export interface ReviewDiff { lines: ReviewLine[]; added: number; removed: number; coarse: boolean }
/**
 * Diff two texts into numbered hunks with `@@` headers.
 * @param oldText - previous content, or `null` for a created file.
 * @param newText - new content.
 * @param context - unchanged lines kept around each change.
 * @returns the hunks and the added and removed line counts.
 */
export function reviewDiff(oldText: string | null, newText: string, context = 3): ReviewDiff {
  const before = oldText === null ? [] : splitLines(oldText)
  const after = splitLines(newText)
  let prefix = 0; let suffix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  const shared = Math.min(before.length, after.length) - prefix
  while (suffix < shared && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  const oldMiddle = before.slice(prefix, before.length - suffix)
  const newMiddle = after.slice(prefix, after.length - suffix)
  const coarse = oldMiddle.length * newMiddle.length > EXACT_LIMIT
  const operations: DiffLine[] = [
    ...before.slice(0, prefix).map(text => ({ sign: ' ' as const, text })),
    ...(coarse ? [...oldMiddle.map(text => ({ sign: '-' as const, text })), ...newMiddle.map(text => ({ sign: '+' as const, text }))] : exact(oldMiddle, newMiddle)),
    ...before.slice(before.length - suffix).map(text => ({ sign: ' ' as const, text })),
  ]
  let oldLine = 1; let newLine = 1
  const numbered: ReviewLine[] = operations.map(line => ({ ...line,
    ...(line.sign === '+' ? {} : { oldLine: oldLine++ }),
    ...(line.sign === '-' ? {} : { newLine: newLine++ }),
  }))
  const intervals: [number, number][] = []
  numbered.forEach((line, index) => {
    if (line.sign === ' ') return
    const from = Math.max(0, index - context), to = Math.min(numbered.length, index + context + 1)
    const previous = intervals.at(-1)
    if (previous !== undefined && from <= previous[1]) previous[1] = Math.max(previous[1], to)
    else intervals.push([from, to])
  })
  const lines: ReviewLine[] = []
  for (const [from, to] of intervals) {
    const segment = numbered.slice(from, to)
    const oldCount = segment.filter(line => line.sign !== '+').length
    const newCount = segment.filter(line => line.sign !== '-').length
    const oldStart = segment.find(line => line.oldLine !== undefined)?.oldLine ?? Math.max(0, (numbered[from - 1]?.oldLine ?? 0))
    const newStart = segment.find(line => line.newLine !== undefined)?.newLine ?? Math.max(0, (numbered[from - 1]?.newLine ?? 0))
    lines.push({ sign: ' ', text: '', hunk: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` })
    for (const line of segment) lines.push(line)
  }
  return { lines, added: newMiddle.length - operations.slice(prefix, operations.length - suffix).filter(line => line.sign === ' ').length,
    removed: oldMiddle.length - operations.slice(prefix, operations.length - suffix).filter(line => line.sign === ' ').length, coarse }
}
