/** Complete, scrollable conversation document. All folding is view-local. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AssistantItem, Item, LayaItem, ToolItem } from './transcript.ts'
import { textOf } from './transcript.ts'
import { reviewDiff } from './diff.ts'
import { diffRows } from './diff-layout.ts'
import { codeBlocks } from './code-blocks.ts'
import { COPY_LABEL, createStreamingMarkdown, createStreamingProse, markdownRows, type StreamingLayout } from './markdown-layout.ts'
import { duration } from './metrics.ts'
import { fitRow, indentRows, row, span, textOfRow, widthOf, wrapProse, wrapRow, type Row, type Span } from './rich-text.ts'
import { highlight, languageOf } from './syntax.ts'
import { displayTree, jsonText, safeText } from './terminal.ts'
import { toolBadge } from './tool-format.ts'
import type { UiAction } from './actions.ts'
import type { Tone } from './theme.ts'
import { SEA_MIN_CELLS, thinkingSea } from './sea.ts'
import { thinkingWhale } from './screen.ts'

/** Layout inputs for the conversation document; `overrides` maps item ids (and `reasoning:<id>`) to per-item expansion. */
export interface DocumentOptions {
  width: number
  expanded: boolean
  overrides: Readonly<Record<string, boolean>>
  raw?: boolean
  changesOnly?: boolean
  tick?: number
  now?: number
  /** Only the latest reasoning segment carries the whale decoration. */
  thinkingDecoration?: boolean
  /** Reuses completed rows of a growing message; a full layout is used without it. */
  streaming?: { markdown: StreamingLayout; prose: StreamingLayout }
}

/** Keep the whale after the complete label, with its sea beneath it and no frame-dependent wrapping. */
function thinkingRows(active: boolean, tick: number, label: Row, width: number): Row[] {
  const whale = thinkingWhale(active ? tick : 0)
  const offset = widthOf(textOfRow(label)) + 1
  if (offset + Math.max(...whale.map(part => widthOf(textOfRow(part)))) > width) {
    return [...wrapRow(label, width), ...indentRows(whale, '  ', width)]
  }
  const middle = Math.floor(whale.length / 2)
  return whale.map((part, index) => row(
    ...index === middle ? [...label.spans, span(' ')] : [span(' '.repeat(offset))], ...part.spans,
  ))
}

// Border glyphs from the outward crest to the inward trough of the small wave along a live box's top and bottom.
const WAVE_TOP = ['⎻', '─', '⎼'] as const, WAVE_BOTTOM = [...WAVE_TOP].reverse()

/** How a disclosure draws its frame. */
interface FrameStyle {
  /** A small wave runs clockwise along the top and bottom edges at this tick; without it they are straight. */
  wave?: number
  /** Only the top and bottom edges: no sides, and the edges run across the corners. */
  open?: boolean
}

/** One bounded disclosure: the entire header and closing edge are click targets. */
function disclosure(
  title: Row, body: readonly Row[], width: number, tone: Tone, action: UiAction, expanded: boolean, style: FrameStyle = {},
): Row[] {
  const { wave, open = false } = style
  const clickable = (value: Row): Row => ({ ...value, spans: value.spans.map(part => ({ ...part, action })) })
  if (width < 8) return [clickable(fitRow(title, width)), ...body.flatMap(value => wrapRow(value, width))]
  const inner = width - 4
  const lines = body.flatMap(value => wrapRow(value, inner))
  // `at` is the cell's position along the perimeter, clockwise from the top-left corner.
  const glyph = (glyphs: readonly string[], at: number, straight: string): string => {
    if (wave === undefined) return straight
    const crest = Math.sin(at / 1.2 - wave * 0.3)
    return glyphs[Math.round((1 - crest) / 2 * (glyphs.length - 1))] ?? straight
  }
  const rule = (glyphs: readonly string[], from: number, count: number, at: (x: number) => number): string =>
    Array.from({ length: Math.max(0, count) }, (_, index) => glyph(glyphs, at(from + index), '─')).join('')
  const top = (x: number): number => x, bottom = (x: number): number => 2 * width + lines.length - x
  const edge = (caption: Row, glyphs: readonly string[], at: (x: number) => number, left: string, right: string): Row => {
    const fill = width - 5 - widthOf(textOfRow(caption))
    const corner = (straight: string, x: number): string => open ? glyph(glyphs, at(x), '─') : straight
    return clickable(row(span(`${corner(left, 0)}${rule(glyphs, 1, 1, at)} `, tone), ...caption.spans,
      span(` ${rule(glyphs, width - 1 - fill, fill, at)}${corner(right, width - 1)}`, tone)))
  }
  const heading = edge(fitRow(title, width - 5), WAVE_TOP, top, '╭', '╮')
  const content = lines.map(line => ({
    ...line,
    spans: [span(open ? '  ' : '│ ', tone), ...line.spans, span(`${' '.repeat(Math.max(0, inner - widthOf(textOfRow(line))))} ${open ? ' ' : '│'}`, tone)],
  }))
  const label = fitRow(row(span(expanded ? '▾ Hide details' : '› Show details', 'muted')), width - 5)
  return [heading, ...content, edge(label, WAVE_BOTTOM, bottom, '╰', '╯')]
}

function field(label: string, value: string, width: number): Row[] {
  return [row(span(label, 'muted', true)), ...wrapRow(row(value), width)]
}

const kTokens = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
/** A laya_context_pruner result: totals, then the biggest savings (all of them when expanded). */
function layaRows(item: LayaItem, width: number, expanded: boolean): Row[] {
  const out: Row[] = []
  const title = span('▞▚ laya_context_pruner', 'accent', true)
  if (item.outcome === 'pruned') {
    const pct = item.tokensBefore > 0 ? Math.round(100 * (1 - item.tokensAfter / item.tokensBefore)) : 0
    out.push(fitRow(row(span(`${expanded ? '▾' : '▸'} `, 'success'), title,
      span(`  ${kTokens(item.tokensBefore)} → ${kTokens(item.tokensAfter)} tokens (−${pct}%)`, 'text'),
      span(`  ${item.kept} kept · ${item.truncated} truncated · ${item.dropped} dropped · ${duration(item.ms)}`, 'muted')), width))
  } else {
    out.push(fitRow(row(span(`${expanded ? '▾' : '▸'} `, 'warning'), title,
      span(`  skipped · regular compaction decides${item.error === undefined ? '' : ` · ${item.error}`}`, 'warning')), width))
  }
  const sorted = [...item.entries].sort((a, b) => (b.tokensBefore - b.tokensAfter) - (a.tokensBefore - a.tokensAfter))
  const shown = expanded ? sorted : sorted.slice(0, 4)
  for (const entry of shown) {
    const icon = entry.action === 'KEEP' ? '■' : entry.action === 'TRUNCATE' ? '◧' : '□'
    const tone = entry.action === 'KEEP' ? 'success' : entry.action === 'TRUNCATE' ? 'warning' : 'muted'
    out.push(fitRow(row(span(`  ${icon} ${entry.action.padEnd(8)} `, tone),
      span(`${kTokens(entry.tokensBefore).padStart(5)} → ${kTokens(entry.tokensAfter).padEnd(5)} `, 'muted'), span(entry.label, 'text')), width))
  }
  if (!expanded && sorted.length > shown.length) out.push(row(span(`  … ${sorted.length - shown.length} more · click title to toggle inline`, 'muted')))
  return out
}
/**
 * Whether an item is a tool call whose result is a file diff.
 * @param item - transcript item.
 * @returns true for diff-card tool items.
 */
export function isChange(item: Item): item is ToolItem { return item.kind === 'tool' && item.result?.card === 'diff' }
function json(value: unknown): string {
  try { return typeof value === 'string' ? value : jsonText(value, 2) ?? '' }
  catch { return '[Arguments could not be serialized]' }
}
function resultRows(item: ToolItem, width: number, raw: boolean): Row[] {
  const view = item.result
  if (raw) return wrapRow(row(span(json({ arguments: item.args, result: view, output: item.resultText }), 'muted')), width)
  if (!item.settled) return []
  if (item.cancelled === true) return [row(span('Interrupted before a tool result was received.', 'warning'))]
  if (view?.card === 'diff' && !item.isError) return diffRows(view.diffs, width, true)
  let result: Row[] = []
  if (item.isError) result = wrapRow(row(span(item.resultText ?? 'Tool failed', 'error')), width)
  else if (view === undefined) result = wrapRow(row(span(item.resultText || 'Completed', 'text')), width)
  else switch (view.card) {
    case 'terminal':
      result = wrapRow(row(span(view.output || '(no output)', 'text')), width)
      if (view.signal !== undefined) result.push(row(span(`signal ${view.signal}`, 'warning')))
      if (view.exitCode !== undefined) result.push(row(span(`exit ${view.exitCode}`, view.exitCode === 0 ? 'muted' : 'error')))
      break
    case 'read':
      result = [row(span(`${view.path} · lines ${view.lines[0]?.number ?? view.offset}–${view.lines.at(-1)?.number ?? view.offset}/${view.totalLines}`, 'text'))]
      view.lines.forEach((line) => {
        const prefix = `${String(line.number).padStart(4)} │ `
        for (const [part, wrapped] of wrapRow(row(...highlight(line.text, view.lang ?? languageOf(view.path))), Math.max(1, width - prefix.length)).entries()) result.push(row(span(part === 0 ? prefix : '     │ ', 'muted'), ...wrapped.spans))
      })
      break
    case 'search':
      if (view.shape === 'paths') result = view.paths.flatMap(path => wrapRow(row(span(path, 'text')), width))
      else for (const file of view.files) {
        result.push(...wrapRow(row(span(file.path, 'text', true)), width))
        for (const match of file.matches) result.push(...wrapRow(row(span(` ${match.lineNumber} │ `, 'muted'), match.line), width))
      }
      result.push(row(span(`${view.total} ${view.shape === 'paths' ? 'paths' : 'matches'}${view.truncated ? ' · tool result was truncated upstream' : ''}`, 'muted')))
      break
    case 'web':
      if (view.kind === 'fetch') result = wrapRow(row(span(`${view.url} · HTTP ${view.statusCode}`, 'text')), width)
      else result = view.sources.flatMap(source => wrapRow(row(span(`${source.title === undefined ? '' : `${source.title}\n`}${source.url}`, 'text')), width))
      break
    case 'generic': result = wrapRow(row(span(view.content === undefined ? item.resultText ?? 'Completed' : textOf(view.content), 'text')), width); break
    default: result = wrapRow(row(span(item.resultText ?? json(view), 'text')), width)
  }
  return result
}

/** Cells a one-row tool call spans before its duration, however wide the terminal. */
const TOOL_LINE_MEASURE = 80
/** Most cells a one-row tool call gives its result summary. */
const TOOL_SUMMARY_CELLS = 40
/** Transcript items are indented by this margin; the `›` and `●` message markers sit inside it. */
const MARGIN = '  '
/** Below this width items drop the margin and the markers, so no row outgrows the pane. */
const MARGIN_MIN_WIDTH = 12

const FENCE = /^(?:`{3,}|~{3,})/u
/** The non-blank lines of a result text, trimmed, without Markdown fence lines. */
const resultLines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(line => line !== '' && !FENCE.test(line))

/** The muted note after a collapsed tool call: the result in a few words, or nothing when the title already says it. */
function toolNote(item: ToolItem): Span | undefined {
  if (!item.settled) return undefined
  if (item.cancelled === true) return span('· interrupted', 'warning')
  if (item.isError) return span(`· ${resultLines(item.resultText ?? '')[0] ?? 'failed'}`, 'error')
  const view = item.result, said = (text: string | undefined): Span | undefined => text === undefined ? undefined : span(`· ${text}`, 'muted')
  switch (view?.card) {
    case undefined: return said(resultLines(item.resultText ?? '')[0])
    case 'diff': {
      let added = 0, removed = 0
      for (const diff of view.diffs) {
        const review = reviewDiff(diff.oldText, diff.newText)
        added += review.added; removed += review.removed
      }
      return span(`+${added} −${removed}`, 'muted')
    }
    case 'terminal':
      if (view.signal !== undefined) return span(`· signal ${view.signal}`, 'warning')
      if (view.exitCode !== undefined && view.exitCode !== 0) return span(`· exit ${view.exitCode}`, 'error')
      return said(resultLines(view.output ?? '').at(-1))
    case 'read': return undefined
    case 'search': return said(`${view.total} ${view.shape === 'paths' ? 'paths' : 'matches'}`)
    case 'web': return said(view.kind === 'fetch' ? `HTTP ${view.statusCode}` : `${view.sources.length} sources`)
    case 'generic': return said(resultLines(view.content === undefined ? item.resultText ?? '' : textOf(view.content))[0])
    default: return assertNever(view, 'tool result card')
  }
}

/**
 * A collapsed tool call as one row: status glyph, muted verb, target, muted result note, and the duration right-aligned
 * within {@link TOOL_LINE_MEASURE} cells. A command runs (`Run <command>`); other titles that open with a capitalised word
 * use it as the verb (`Read src/auth.ts`).
 */
function toolLine(item: ToolItem, width: number): Row {
  const glyph = item.cancelled === true ? span('–', 'warning') : item.isError ? span('×', 'error') : item.settled ? span('✓', 'success') : span('◌', 'accent')
  const title = item.result?.title || item.call.title || item.name
  const command = item.call.card === 'terminal' || (item.call.card === 'generic' && item.call.kind === 'execute')
  const named = /^(\p{Lu}[\p{L}-]*)\s+(\S[\s\S]*)$/u.exec(title)
  const [verb, target] = command ? ['Run', item.call.title] : named !== null ? [named[1] ?? '', named[2] ?? ''] : [item.name, title === item.name ? '' : title]
  const time = item.settled && item.startedAt !== undefined && item.completedAt !== undefined ? duration(item.completedAt - item.startedAt) : ''
  const room = timedRoom(time, width)
  const head = row(glyph, span(` ${verb}`, 'muted'), span(target === '' ? '' : ' '))
  const used = widthOf(textOfRow(head)), summary = toolNote(item)
  const noteRoom = Math.min(TOOL_SUMMARY_CELLS, room - used - Math.min(widthOf(target), 24) - 2)
  const note = summary === undefined || noteRoom < 6 ? undefined : fitRow(row(summary), noteRoom)
  const shown = fitRow(row(span(target, 'text')), Math.max(0, room - used - (note === undefined ? 0 : widthOf(textOfRow(note)) + 2)))
  return timedRow([...head.spans, ...shown.spans, ...note === undefined ? [] : [span('  '), ...note.spans]], time, width)
}

/** Cells left of a one-row item's duration column. */
const timedRoom = (time: string, width: number): number => Math.max(1, Math.min(width, TOOL_LINE_MEASURE) - (time === '' ? 0 : widthOf(time) + 2))
/** One-row item content, cut to {@link timedRoom}, with `time` right-aligned at {@link TOOL_LINE_MEASURE} cells, muted. */
function timedRow(parts: readonly Span[], time: string, width: number): Row {
  const left = fitRow(row(...parts), timedRoom(time, width))
  if (time === '') return left
  const gap = Math.max(1, Math.min(width, TOOL_LINE_MEASURE) - widthOf(textOfRow(left)) - widthOf(time))
  return fitRow(row(...left.spans, span(' '.repeat(gap)), span(time, 'muted')), width)
}

/** Whether reasoning is still arriving: the live Thinking box, as opposed to a settled thought. */
const thinking = (item: AssistantItem): boolean => !item.settled && item.text === '' && item.reasoningEndedAt === undefined
/** A settled thought the reader has not opened; it renders as one row. */
const foldedThought = (item: AssistantItem, options: DocumentOptions): boolean =>
  item.reasoning !== '' && !thinking(item) && options.overrides[`reasoning:${item.id}`] !== true

/**
 * A folded, settled thought as one row in the tool-row columns: `◦ Thought` in the reasoning tone, the line count muted, and the
 * reasoning time right-aligned when both its timestamps are known. Every cell toggles the reasoning open.
 */
function thoughtLine(item: AssistantItem, width: number): Row {
  const count = item.reasoning.split('\n').length
  const time = item.reasoningStartedAt === undefined || item.reasoningEndedAt === undefined ? '' : duration(item.reasoningEndedAt - item.reasoningStartedAt)
  const value = timedRow([span('◦ Thought', 'reasoning'), span(` · ${count} line${count === 1 ? '' : 's'}`, 'muted')], time, width)
  return { ...value, spans: value.spans.map(part => ({ ...part, action: { kind: 'toggle-reasoning' as const, itemId: item.id } })) }
}

/** An item that renders as one row after its blank row: a collapsed tool call outside the raw inspector, or a lone folded thought. */
function isOneRow(item: Item, options: DocumentOptions): boolean {
  if (item.kind === 'tool') return !(options.overrides[item.id] ?? options.expanded) && options.raw !== true
  return item.kind === 'assistant' && item.text === '' && foldedThought(item, options)
}
/**
 * Render one transcript item: a blank row, then the item behind a two-cell margin. A user prompt marks its first row with `›`
 * and an assistant message with `●`. A collapsed tool call and a folded settled thought are one row each, and open into a
 * bordered card; live reasoning keeps its open Thinking box. Rows carry the item id, a heading flag on the row after the blank
 * one, and click actions.
 * @param unsafe - the item; terminal control text is neutralized before layout.
 * @param options - layout inputs.
 * @returns the item's rows.
 */
export function itemRows(unsafe: Item, options: DocumentOptions): Row[] {
  const item = displayTree(unsafe)
  const width = Math.max(1, options.width)
  const expanded = options.overrides[item.id] ?? options.expanded
  // Every item sits behind the margin; a message marks its first row inside it.
  const margin = width >= MARGIN_MIN_WIDTH ? MARGIN : ''
  const content = Math.max(1, width - margin.length)
  const indent = (value: readonly Row[], marker?: Span): Row[] => margin === '' ? [...value] : indentRows(value, margin, width, marker)
  const rows: Row[] = [row('')]
  if (item.kind === 'user') {
    rows.push(...indent(wrapProse(row(span(item.text, 'text', true)), content), span('› ', 'muted')))
  } else if (item.kind === 'assistant') {
    if (foldedThought(item, options)) rows.push(...indent([thoughtLine(item, content)]))
    else if (item.reasoning !== '') {
      const reasoningKey = `reasoning:${item.id}`
      const reasoningExpanded = options.overrides[reasoningKey] ?? false
      const activelyThinking = thinking(item)
      const seconds = item.reasoningStartedAt === undefined ? undefined
        : `${Math.floor(Math.max(0, (item.reasoningEndedAt ?? options.now ?? item.reasoningStartedAt) - item.reasoningStartedAt) / 1000)}s`
      const lineCount = item.reasoning.split('\n').length
      const toggleAction = { kind: 'toggle-reasoning' as const, itemId: item.id }
      const label = row(span(`${reasoningExpanded ? '▾' : '›'} `, 'reasoning'),
        span(`${activelyThinking ? 'Thinking…' : 'Thought'}${seconds === undefined ? '' : ` · ${seconds}`}`, 'reasoning', true),
        span(` · ${lineCount} line${lineCount === 1 ? '' : 's'}`, 'muted'))
      const inner = Math.max(1, content - 4)
      const body: Row[] = []
      const tick = options.tick ?? 0
      if (activelyThinking && options.thinkingDecoration !== false && inner >= 14) {
        // The whole box is the whale's sea; a box too narrow for it keeps the small side-view whale.
        body.push(...inner >= SEA_MIN_CELLS ? thinkingSea(tick, inner) : thinkingWhale(tick))
      }
      if (reasoningExpanded) body.push(...(options.streaming?.prose.rows(item.id, item.reasoning, inner)
        ?? wrapProse(row(span(item.reasoning, 'reasoning')), inner)))
      // While thinking the box is open water: only its waving top and bottom edges, no sides.
      const frame: FrameStyle = activelyThinking ? { open: true, ...tick > 0 ? { wave: tick } : {} } : {}
      rows.push(...indent(disclosure(label, body, content, 'reasoning', toggleAction, reasoningExpanded, frame)))
    }
    if (item.text !== '') {
      const original = unsafe.kind === 'assistant' ? unsafe.text : item.text
      rows.push(...indent(options.streaming?.markdown.rows(item.id, original, content) ?? markdownRows(original, content), span('● ', 'accent')))
    }
    if (item.reasoning === '' && item.text === '' && !item.settled) {
      const label = row(span('Waiting for model…', 'muted'))
      const waiting = options.thinkingDecoration === false ? wrapRow(label, content) : thinkingRows(true, options.tick ?? 0, label, content)
      rows.push(...indent(waiting))
    }
  } else if (item.kind === 'tool') {
    if (isOneRow(item, options)) rows.push(...indent([toolLine(item, content)]))
    else {
      const done = item.cancelled === true ? '–' : item.isError ? '×' : item.settled ? '✓' : '◌'
      const statusTone = item.cancelled === true ? 'warning' : item.isError ? 'error' : item.settled ? 'success' : 'accent'
      const badge = toolBadge(item.name, item.call, item.result)
      const timing = item.startedAt === undefined || item.completedAt === undefined ? '' : ` · ${duration(item.completedAt - item.startedAt)}`
      const title = item.result?.title || item.call.title || item.name
      const inner = Math.max(1, content - 4)
      const body: Row[] = []
      if (!options.raw) {
        const command = item.call.card === 'terminal' || (item.call.card === 'generic' && item.call.kind === 'execute')
        if (command) {
          const description = item.call.card === 'terminal' ? item.call.description
            : item.call.card === 'generic' && item.call.content !== undefined ? textOf(item.call.content) : undefined
          if (description !== undefined && description !== '') body.push(...field('Description', description, inner), row(''))
          body.push(...field('Command', item.call.title, inner), row(''))
        } else {
          body.push(...field('Description', title, inner), row(''))
          if (item.call.card === 'generic' && item.call.content !== undefined) body.push(...markdownRows(textOf(item.call.content), inner), row(''))
          body.push(...field('Arguments', json(item.args), inner), row(''))
        }
        body.push(row(span('Result', 'muted', true)))
      }
      body.push(...resultRows(item, inner, options.raw === true))
      if (!item.settled) body.push(row(span('Running…', 'accent')))
      rows.push(...indent(disclosure(row(span(`${expanded ? '▾' : '›'} ${done} `, statusTone),
        span(badge.tag, badge.tone, true), span(` ${title}`, 'text'), span(`  ${item.name}${timing}`, 'muted')),
      body, content, 'muted', { kind: 'inspect-item', itemId: item.id }, expanded)))
    }
  } else if (item.kind === 'command') {
    const inner = Math.max(1, content - 4)
    const body: Row[] = []
    if (expanded) body.push(...field('Arguments', item.args.trim() || '(none)', inner), row(''), row(span('Result', 'muted', true)))
    if (item.result?.text !== undefined) {
      const result = wrapRow(row(span(item.result.text, item.result.kind === 'error' ? 'error' : 'text')), inner)
      body.push(...(expanded ? result : result.slice(0, 3)))
      if (!expanded && result.length > 3) body.push(row(span(`… ${result.length - 3} more lines`, 'muted')))
    }
    rows.push(...indent(disclosure(row(span(`${expanded ? '▾' : '›'} /${item.name}`, 'command', true),
      span(item.settled ? ' · completed' : ' · running', 'muted')), body, content, 'muted',
    { kind: 'inspect-item', itemId: item.id }, expanded)))
  } else if (item.kind === 'laya') {
    rows.push(...indent(layaRows(item, content, expanded)))
  } else {
    const tone = item.level === 'error' ? 'error' : item.level === 'success' ? 'success' : 'muted'
    rows.push(...indent(wrapProse(row(span(`${item.level === 'error' ? '× ' : item.level === 'success' ? '✓ ' : '· '}${item.text}`, tone)), content)))
  }
  const blocks = unsafe.kind === 'assistant' ? codeBlocks(unsafe.text) : []
  let block = 0
  return rows.flatMap(value => wrapRow(value, width)).map((value, index) => {
    let spans = value.spans
    if (value.codeHeader === true) {
      const at = block++
      spans = spans.map(part => part.text === COPY_LABEL && blocks[at] !== undefined
        ? { ...part, action: { kind: 'copy-code' as const, itemId: item.id, block: at } } : part)
    }
    // Row 0 is the blank row above every item; row 1 is its heading.
    const heading = index === 1
    if (heading && (item.kind === 'tool' || item.kind === 'laya' || item.kind === 'command')) spans = spans.map(part => ({ ...part, action: { kind: 'inspect-item' as const, itemId: item.id } }))
    return { ...value, spans, itemId: item.id, heading }
  })
}
/**
 * Reuse settled row layouts; streaming a token must not re-highlight old files.
 * @returns a renderer whose `render` lays out items through a per-item cache, leaves out the blank row between consecutive
 *   one-row items (collapsed tool calls and folded thoughts) and drops entries for absent items, and whose `clear` empties every
 *   cache.
 */
export function createDocumentRenderer(): { render(items: readonly Item[], options: DocumentOptions): Row[]; clear(): void } {
  const cache = new Map<string, { item: Item; key: string; rows: Row[] }>()
  const streaming = { markdown: createStreamingMarkdown(), prose: createStreamingProse('reasoning') }
  return {
    clear() { cache.clear(); streaming.markdown.clear(); streaming.prose.clear() },
    render(items, options) {
      const latestThinking = items.findLast(item => item.kind === 'assistant' && (item.reasoning !== '' || (!item.settled && item.text === '')))?.id
      const ids = new Set<string>(); const result: Row[] = []
      let previousLine = false
      for (const item of items) {
        ids.add(item.id)
        if (options.changesOnly === true && !isChange(item)) continue
        // Consecutive one-row tool calls and folded thoughts form a list without blank rows between them.
        const line = isOneRow(item, options), joined = line && previousLine
        previousLine = line
        const reasoningOverride = options.overrides[`reasoning:${item.id}`] ?? false
        const activeThinking = item.kind === 'assistant' && !item.settled && item.text === '' && item.reasoningEndedAt === undefined
        const decorated = item.id === latestThinking
        const layout: DocumentOptions = { ...options, streaming, thinkingDecoration: decorated }
        const tickKey = activeThinking ? `${options.tick ?? 0}:${Math.floor((options.now ?? 0) / 1000)}` : 'settled'
        const key = `${options.width}:${options.overrides[item.id] ?? options.expanded}:${reasoningOverride}:${options.raw === true}:${decorated}:${tickKey}`
        let entry = cache.get(item.id)
        const keys = Object.keys(item) as (keyof Item)[]
        const drifted = keys.some(field => item[field] !== entry?.item[field])
        if (entry === undefined || entry.key !== key || drifted || Object.keys(entry.item).length !== keys.length) {
          entry = { item: { ...item }, key, rows: itemRows(item, layout) }; cache.set(item.id, entry)
        }
        for (const [index, value] of entry.rows.entries()) if (!joined || index > 0) result.push(value)
      }
      for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id)
      return result
    },
  }
}
/**
 * Search operates on full rendered content, not only the visible viewport.
 * @param rows - the rendered document.
 * @param query - case-insensitive text; control characters are neutralized first.
 * @returns indexes of matching rows; empty for an empty query.
 */
export function searchRows(rows: readonly Row[], query: string): number[] {
  const needle = safeText(query).toLocaleLowerCase()
  return needle === '' ? [] : rows.flatMap((value, index) => value.spans.map(part => part.text).join('').toLocaleLowerCase().includes(needle) ? [index] : [])
}
