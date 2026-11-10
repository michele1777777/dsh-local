/** Markdown-to-terminal document. No HTML evaluation or model mutation; hyperlinks are encoded only when painting. */
import { fitRow, indentRows, onBackground, row, span, textOfRow, widthOf, wrapProse, wrapRow, type Row, type Span } from './rich-text.ts'
import { safeText } from './terminal.ts'
import type { Tone } from './theme.ts'
import { closesFence, fenceMarker, type Fence } from './code-blocks.ts'
import { safeHref } from './links.ts'
import { highlight } from './syntax.ts'
/**
 * Parse inline Markdown: code, bold, italic, strikethrough (muted) and links. A link keeps its URL as visible text and becomes
 * clickable only when `safeHref` accepts it.
 * @param text - one line of Markdown.
 * @returns at least one span.
 */
export function inline(text: string): Span[] {
  const parts: Span[] = []; let cursor = 0
  const pattern = /(`+)(.+?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|~~([^~]+)~~|\[([^\]]+)\]\(([^)]+)\)/gu
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parts.push(span(text.slice(cursor, match.index)))
    if (match[2] !== undefined) parts.push(span(match[2], 'accent'))
    else if (match[3] !== undefined || match[4] !== undefined) parts.push(span(match[3] ?? match[4] ?? '', 'text', true))
    else if (match[5] !== undefined) parts.push({ text: match[5], italic: true })
    else if (match[6] !== undefined) parts.push(span(match[6], 'muted'))
    else {
      const href = safeHref(match[8] ?? '')
      parts.push({ ...span(match[7] ?? '', 'accent'), ...(href === undefined ? {} : { href }) }, span(` (${match[8] ?? ''})`, 'muted'))
    }
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push(span(text.slice(cursor)))
  return parts.length === 0 ? [span('')] : parts
}
const cells = (line: string): string[] => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(value => value.trim().replace(/\\\|/gu, '|'))
function table(lines: string[], width: number): Row[] {
  const grid = lines.map(cells)
  const headings = [...(grid[0] ?? [])]
  const count = Math.max(headings.length, ...grid.map(values => values.length))
  while (headings.length < count) headings.push(`Column ${headings.length + 1}`)
  const gap = 3 * Math.max(0, count - 1)
  const minimum = Math.max(6, Math.floor((width - gap) / Math.max(1, count)))
  if (count > 6 || minimum * count + gap > width || width < 48) {
    const result: Row[] = []
    for (const values of grid.slice(1)) {
      for (let i = 0; i < Math.max(values.length, count); i++) result.push(...wrapRow(row(span(`${headings[i] ?? `Column ${i + 1}`}: `, 'muted'), ...inline(values[i] ?? '')), width))
      result.push(row(''))
    }
    return result
  }
  const widths = Array.from({ length: count }, (_, index) => Math.max(3, Math.min(minimum, Math.max(...grid.map(values => widthOf(values[index] ?? ''))))))
  const spare = width - gap - widths.reduce((sum, value) => sum + value, 0)
  if (count > 0) widths[count - 1] = (widths[count - 1] ?? 3) + spare
  const output: Row[] = []
  grid.forEach((values, rowIndex) => {
    const wrapped = headings.map((_, index) => wrapRow(row(...inline(values[index] ?? '')), widths[index] ?? minimum))
    const height = Math.max(1, ...wrapped.map(value => value.length))
    for (let line = 0; line < height; line++) {
      const parts: Span[] = []
      wrapped.forEach((column, index) => {
        if (index > 0) parts.push(span(' │ ', 'muted'))
        const cell = column[line] ?? row('')
        parts.push(...cell.spans.map(part => rowIndex === 0 ? { ...part, bold: true } : part), span(' '.repeat(Math.max(0, (widths[index] ?? 0) - widthOf(textOfRow(cell))))))
      })
      output.push(row(...parts))
    }
    if (rowIndex === 0) output.push(row(span(widths.map(value => '─'.repeat(value)).join('─┼─'), 'muted')))
  })
  return output
}
/** Text of the copy control in a code-block header; the document attaches the copy action to the span with exactly this text. */
export const COPY_LABEL = 'Copy'
/**
 * The header row of a code block, exactly `width` cells: the language, a faint rule and the {@link COPY_LABEL} control, on
 * the band. The language gives way before the control does.
 */
function codeHeader(language: string, width: number): Row {
  // The control keeps a style no neighbour shares: spans of one style are merged, and the control is found by its exact text.
  const copy = span(COPY_LABEL, 'comment')
  const room = width - COPY_LABEL.length - 2
  const name = room >= language.length + 2 ? [span(`${language} `, 'muted')] : []
  const used = widthOf(textOfRow(row(...name))) + COPY_LABEL.length + 1
  return { ...onBackground(width < COPY_LABEL.length ? fitRow(row(copy), width) : row(...name, span(`${'─'.repeat(Math.max(0, width - used))} `, 'muted'), copy), width, 'band'), codeHeader: true }
}
/**
 * Lay out Markdown for the terminal. Every body line survives wrapping, including code and table cells. A fenced code block
 * stands on the band background without side borders, so a terminal's own selection takes the code and nothing else; its
 * header row names the language and carries the {@link COPY_LABEL} control.
 * @param input - Markdown source; CR and CRLF are treated as LF.
 * @param width - row width in cells.
 * @returns the rendered rows; each code-block header row has `codeHeader` set.
 */
export function markdownRows(input: string, width: number): Row[] {
  const lines = input.replace(/\r\n?/gu, '\n').split('\n')
  const result: Row[] = []
  let fence: Fence | undefined
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] ?? ''
    const line = safeText(rawLine)
    const marker = fenceMarker(rawLine)
    if (marker !== undefined) {
      if (fence === undefined) {
        fence = marker
        result.push(codeHeader(fence.language || 'code', width))
        continue
      }
      if (closesFence(fence, marker)) { fence = undefined; continue }
    }
    if (fence !== undefined) {
      for (const value of wrapRow(row(...highlight(line, fence.language)), Math.max(1, width))) result.push(onBackground(value, width, 'band'))
      continue
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(lines[index + 1] ?? '')) {
      const block = [line]; index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') block.push(lines[index++] ?? '')
      index--; result.push(...table(block, width)); continue
    }
    const heading = /^#{1,6}\s+(.+)$/u.exec(line)
    if (heading !== null) { result.push(...wrapProse(row(...inline(heading[1] ?? '').map(part => ({ ...part, bold: true }))), width)); continue }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/u.test(line)) { result.push(row(span('─'.repeat(Math.max(0, width)), 'muted'))); continue }
    const quote = /^\s*>\s?(.*)$/u.exec(line)
    if (quote !== null) { result.push(...indentRows([row(...inline(quote[1] ?? ''))], '│ ', width)); continue }
    const list = /^(\s*)(?:([-*+])\s+(?:\[([ xX])\]\s+)?|(\d+[.)])\s+)(.*)$/u.exec(line)
    if (list !== null) {
      const prefix = `${(list[1] ?? '').slice(0, Math.max(0, width - 10))}${list[4] ?? (list[3] === undefined ? '•' : list[3] === ' ' ? '□' : '✓')} `
      const wrapped = wrapProse(row(...inline(list[5] ?? '')), Math.max(1, width - widthOf(prefix)))
      wrapped.forEach((value, part) => result.push(row(span(part === 0 ? prefix : ' '.repeat(widthOf(prefix)), list[3]?.toLowerCase() === 'x' ? 'success' : 'muted'), ...value.spans)))
      continue
    }
    result.push(...wrapProse(row(...inline(line)), width))
  }
  return result.flatMap(value => wrapRow(value, width))
}

/**
 * A blank line outside a fence closes every block this layout understands:
 * fences, tables, lists, quotes and paragraphs. Laying out the lines before
 * such a line and the lines after it separately produces the same rows as
 * laying out all of them at once.
 * @param lines - the complete text, already split on newlines.
 * @returns how many leading lines are final, never counting the last line.
 */
export function stableLines(lines: readonly string[]): number {
  let fence: Fence | undefined
  let stable = 0
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index] ?? ''
    const marker = fenceMarker(line)
    if (marker !== undefined) {
      if (fence === undefined) fence = marker
      else if (closesFence(fence, marker)) fence = undefined
      continue
    }
    if (fence === undefined && line.trim() === '') stable = index + 1
  }
  return stable
}

/** Lays out one item's growing text, reusing the lines a stream already completed. */
export interface StreamingLayout {
  rows(id: string, text: string, width: number): Row[]
  clear(): void
}

/**
 * Layout for text that grows by append.
 *
 * Re-wrapping a whole message on every streamed token costs time proportional
 * to its length, which starves terminal input on long answers. One item at a
 * time keeps the rows of its completed lines; any other item, width or rewrite
 * falls back to a complete layout, so rows never depend on how the text
 * arrived. Layout sanitizes presentation without modifying raw fenced-code boundaries.
 * @param layout - the complete layout this accelerates.
 * @param stable - how many leading lines that layout treats as final.
 * @returns the accelerated layout.
 */
export function createStreamingLayout(layout: (text: string, width: number) => Row[],
  stable: (lines: readonly string[]) => number): StreamingLayout {
  let entry: { id: string; width: number; text: string; rows: Row[] } | undefined
  return {
    clear() { entry = undefined },
    rows(id, text, width) {
      if (entry === undefined || entry.id !== id || entry.width !== width || !text.startsWith(entry.text)) {
        entry = { id, width, text: '', rows: [] }
      }
      const lines = text.slice(entry.text.length).split('\n')
      const count = Math.max(0, Math.min(lines.length - 1, stable(lines)))
      if (count > 0) {
        const completed = lines.slice(0, count).join('\n')
        entry = { id, width, text: entry.text + completed + '\n', rows: [...entry.rows, ...layout(completed, width)] }
      }
      return [...entry.rows, ...layout(text.slice(entry.text.length), width)]
    },
  }
}

/**
 * Markdown layout that reuses the blocks a streamed message already closed.
 * @returns the accelerated layout.
 */
export function createStreamingMarkdown(): StreamingLayout {
  const cache = createStreamingLayout(markdownRows, stableLines)
  return { clear: () => { cache.clear() }, rows: (id, text, width) => cache.rows(id, text.replace(/\r\n?/gu, '\n'), width) }
}

/**
 * Prose layout that reuses the lines a streamed message already ended.
 * Wrapping restarts at every newline, so only the last line is rewrapped.
 * @param tone - the colour every wrapped span carries.
 * @returns the accelerated layout.
 */
export function createStreamingProse(tone: Tone): StreamingLayout {
  return createStreamingLayout((text, width) => wrapProse(row(span(text, tone)), width), lines => lines.length - 1)
}
