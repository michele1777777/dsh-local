/** Complete, scrollable conversation document. All folding is view-local. */
import type { LayaPhase } from '@deepseek-ai/dsh-compaction-laya-pruner'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AssistantItem, Item, LayaItem, ToolItem } from './transcript.ts'
import { textOf } from './transcript.ts'
import { reviewDiff } from './diff.ts'
import { diffRows } from './diff-layout.ts'
import { codeBlocks } from './code-blocks.ts'
import { COPY_LABEL, createStreamingMarkdown, createStreamingProse, markdownRows, type StreamingLayout } from './markdown-layout.ts'
import { duration, layaCutting, layaPhaseLabel } from './metrics.ts'
import { fitRow, indentRows, row, span, textOfRow, widthOf, wrapProse, wrapRow, type Row, type Span } from './rich-text.ts'
import { highlight, languageOf } from './syntax.ts'
import { displayTree, jsonText, safeText } from './terminal.ts'
import { toolBadge } from './tool-format.ts'
import type { UiAction } from './actions.ts'
import type { Tone } from './theme.ts'
import { ANIMATION_TICK_MS, CONSTELLATION_MS, CONSTELLATION_STILL_MS, PRUNING_SCENE, THINKING_MARK, THINKING_SCENE, type SceneAnimations } from './animation.ts'

/** Layout inputs for the conversation document; `overrides` maps item ids (and `reasoning:<id>`) to per-item expansion. */
export interface DocumentOptions {
  width: number
  expanded: boolean
  overrides: Readonly<Record<string, boolean>>
  raw?: boolean
  changesOnly?: boolean
  tick?: number
  now?: number
  /** Only the latest reasoning segment carries the Thinking mark. */
  thinkingDecoration?: boolean
  /** False holds every animation on a still frame. */
  motion?: boolean
  /** Terminal height; the Thinking scene needs {@link THINKING_SCENE_MIN_TERMINAL_ROWS}, and shorter terminals get the small mark. */
  terminalRows?: number
  /** Source of the Thinking mark beside live reasoning and the Waiting for model label; without it neither shows a mark. */
  animations?: SceneAnimations
  /**
   * Cell, counted from the item margin, where a one-row item's description column starts; the document renderer shares one
   * value across consecutive one-row items. Without it the description starts two cells after the row's own command.
   */
  column?: number
  /** Reuses completed rows of a growing message; a full layout is used without it. */
  streaming?: { markdown: StreamingLayout; prose: StreamingLayout }
}

/** Cells between a live label and the small animation after it, and between the columns of a one-row item. */
const GAP = 2

/**
 * A label on the middle row of a small animation, which follows it after {@link GAP} cells; the rows above and below hold
 * only the animation. Without a frame, or when label and frame do not fit on one row, the label wraps alone.
 */
function besideLabel(label: Row, frame: readonly Row[] | undefined, width: number): Row[] {
  const offset = widthOf(textOfRow(label)) + GAP
  const first = frame?.[0]
  if (frame === undefined || first === undefined || offset + widthOf(textOfRow(first)) > width) return wrapRow(label, width)
  const middle = Math.floor(frame.length / 2)
  return frame.map((part, index) => row(
    ...index === middle ? [...label.spans, span(' '.repeat(GAP))] : [span(' '.repeat(offset))], ...part.spans,
  ))
}

/** Terminal rows the Thinking scene needs: the label, the scene and its caption, and the header, composer and status line. */
const THINKING_SCENE_MIN_TERMINAL_ROWS = THINKING_SCENE.rows + 14

/** The constellation a live item opens on: a hash of its id, so consecutive thoughts start on different figures. */
function firstFigure(id: string, figures: number): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193)
  return (hash >>> 0) % figures
}

/**
 * Live Thinking or Waiting rows: the label, then the constellation scene under it, indented {@link GAP} cells, with the
 * figure's name beside the scene's last row (or on a row of its own when that does not fit). A terminal shorter than
 * {@link THINKING_SCENE_MIN_TERMINAL_ROWS} or narrower than the scene gets the small mark beside the label instead; the open
 * reasoning, a superseded segment and a missing asset get the label alone.
 * @param label - the label row.
 * @param id - the item id, which picks the first constellation.
 * @param elapsedMs - time since the item started thinking.
 * @param content - cells inside the item margin.
 * @param options - the document options; `motion` false shows a still.
 * @param decorated - whether this label carries the decoration at all.
 * @returns the rows, before the margin.
 */
function thinkingRows(label: Row, id: string, elapsedMs: number, content: number, options: DocumentOptions, decorated: boolean): Row[] {
  const animations = options.animations
  if (!decorated || options.thinkingDecoration === false || animations === undefined) return wrapRow(label, content)
  const sky = animations.animation(THINKING_SCENE)
  if (sky !== undefined && (options.terminalRows ?? 0) >= THINKING_SCENE_MIN_TERMINAL_ROWS && content >= GAP + THINKING_SCENE.columns) {
    const figures = Math.max(1, Math.floor(sky.durationMs / CONSTELLATION_MS))
    const at = firstFigure(id, figures) * CONSTELLATION_MS + (options.motion === false ? CONSTELLATION_STILL_MS : elapsedMs)
    const frame = animations.frame(THINKING_SCENE, at) ?? []
    const caption = span(animations.caption(THINKING_SCENE, at) ?? '', 'text')
    const indent = span(' '.repeat(GAP))
    const beside = GAP + THINKING_SCENE.columns + GAP + sky.captionColumns <= content
    const scene = frame.map((part, index) => row(indent, ...part.spans, ...beside && index === frame.length - 1 ? [indent, caption] : []))
    return [...wrapRow(label, content), ...scene, ...beside || sky.captionColumns === 0 ? [] : [row(indent, caption)]]
  }
  return besideLabel(label, animations.frame(THINKING_MARK, options.motion === false ? 0 : elapsedMs), content)
}

/** Every cell of `value` runs `action`. */
const clickable = (value: Row, action: UiAction): Row => ({ ...value, spans: value.spans.map(part => ({ ...part, action })) })

/** One bounded disclosure: the entire header and closing edge are click targets. */
function disclosure(title: Row, body: readonly Row[], width: number, tone: Tone, action: UiAction, expanded: boolean): Row[] {
  if (width < 8) return [clickable(fitRow(title, width), action), ...body.flatMap(value => wrapRow(value, width))]
  const inner = width - 4
  const lines = body.flatMap(value => wrapRow(value, inner))
  const edge = (caption: Row, left: string, right: string): Row => clickable(row(span(`${left}─ `, tone), ...caption.spans,
    span(` ${'─'.repeat(Math.max(0, width - 5 - widthOf(textOfRow(caption))))}${right}`, tone)), action)
  const content = lines.map(line => ({
    ...line,
    spans: [span('│ ', tone), ...line.spans, span(`${' '.repeat(Math.max(0, inner - widthOf(textOfRow(line))))} │`, tone)],
  }))
  const label = fitRow(row(span(expanded ? '▾ Hide details' : '› Show details', 'muted')), width - 5)
  return [edge(fitRow(title, width - 5), '╭', '╮'), ...content, edge(label, '╰', '╯')]
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

/** Transcript items are indented by this margin; the `›` and `●` message markers sit inside it. */
const MARGIN = '  '
/** Below this width items drop the margin and the markers, so no row outgrows the pane. */
const MARGIN_MIN_WIDTH = 12
/** Cells inside the margin of a document `width` cells wide. */
const contentWidth = (width: number): number => Math.max(1, width - (width >= MARGIN_MIN_WIDTH ? MARGIN.length : 0))
/** The command keeps at least this many cells (glyph, verb and the start of the target) before the description is cut. */
const COMMAND_MIN_CELLS = 16
/** Share of the content width the shared description column may start at, so long commands leave descriptions room. */
const COLUMN_SHARE = 0.6

const FENCE = /^(?:`{3,}|~{3,})/u
/** The non-blank lines of a result text, trimmed, without Markdown fence lines. */
const resultLines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(line => line !== '' && !FENCE.test(line))

/** The description the model gave a call (a command's `description` argument), on one line, or undefined. */
function callDescription(item: ToolItem): string | undefined {
  const given = item.call.card === 'terminal' ? item.call.description : undefined
  const value = given ?? (typeof item.args === 'object' && item.args !== null && 'description' in item.args ? item.args.description : undefined)
  if (typeof value !== 'string') return undefined
  const line = safeText(value).replace(/\s+/gu, ' ').trim()
  return line === '' ? undefined : line
}

/**
 * The description column of a collapsed tool call: what the model said the call does, while it runs and after it succeeds,
 * followed by the failure in its colour when it fails; a call without such a description shows its result in a few words.
 */
function toolDescription(item: ToolItem): Span[] | undefined {
  const described = callDescription(item)
  const note = toolNote(item)
  if (described === undefined) return note === undefined ? undefined : [note]
  const failure = note !== undefined && note.tone !== 'muted'
  return failure ? [span(described, 'muted'), span(' · ', 'muted'), note] : [span(described, 'muted')]
}

/** The result of a collapsed tool call in a few words, or nothing when the command already says it. */
function toolNote(item: ToolItem): Span | undefined {
  if (!item.settled) return undefined
  if (item.cancelled === true) return span('interrupted', 'warning')
  if (item.isError) return span(resultLines(item.resultText ?? '')[0] ?? 'failed', 'error')
  const view = item.result, said = (text: string | undefined): Span | undefined => text === undefined ? undefined : span(text, 'muted')
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
      if (view.signal !== undefined) return span(`signal ${view.signal}`, 'warning')
      if (view.exitCode !== undefined && view.exitCode !== 0) return span(`exit ${view.exitCode}`, 'error')
      return said(resultLines(view.output ?? '').at(-1))
    case 'read': return undefined
    case 'search': return said(`${view.total} ${view.shape === 'paths' ? 'paths' : 'matches'}`)
    case 'web': return said(view.kind === 'fetch' ? `HTTP ${view.statusCode}` : `${view.sources.length} sources`)
    case 'generic': return said(resultLines(view.content === undefined ? item.resultText ?? '' : textOf(view.content))[0])
    default: return assertNever(view, 'tool result card')
  }
}

/**
 * The command column of a collapsed tool call: status glyph, muted verb and target. A command runs (`Run <command>`); other
 * titles that open with a capitalised word use it as the verb (`Read src/auth.ts`). Control text is neutralized, so the
 * renderer can measure the column before laying the item out.
 */
function toolCommand(item: ToolItem): Span[] {
  const glyph = item.cancelled === true ? span('–', 'warning') : item.isError ? span('×', 'error') : item.settled ? span('✓', 'success') : span('◌', 'accent')
  const title = safeText(item.result?.title || item.call.title || item.name)
  const command = item.call.card === 'terminal' || (item.call.card === 'generic' && item.call.kind === 'execute')
  const named = /^(\p{Lu}[\p{L}-]*)\s+(\S[\s\S]*)$/u.exec(title)
  const name = safeText(item.name)
  const [verb, target] = command ? ['Run', safeText(item.call.title)] : named !== null ? [named[1] ?? '', named[2] ?? ''] : [name, title === name ? '' : title]
  return [glyph, span(` ${verb}`, 'muted'), ...target === '' ? [] : [span(' '), span(target, 'text')]]
}

/** The command column of a folded thought. */
const THOUGHT_COMMAND: readonly Span[] = [span('◦ Thought', 'reasoning')]

/** The command column of a one-row item, or undefined for an item that is not one row. */
function oneRowCommand(item: Item, options: DocumentOptions): readonly Span[] | undefined {
  if (!isOneRow(item, options)) return undefined
  return item.kind === 'tool' ? toolCommand(item) : THOUGHT_COMMAND
}

/** The three columns of a one-row item. */
interface OneRowColumns {
  /** Glyph, verb and target, or the thought label. */
  readonly command: readonly Span[]
  /** What the model said the call does, else its result in a few words; a failure keeps its colour. */
  readonly description: readonly Span[] | undefined
  /** The duration, empty when unknown. */
  readonly time: string
}

/**
 * One row in three columns: the command, the description starting at `column` (or {@link GAP} cells after a command that
 * reaches it), and the duration right-aligned at `width`, muted. The description says what the call did, so narrowing the
 * row cuts the command first, down to {@link COMMAND_MIN_CELLS}, and moves the description left of `column` when needed;
 * only then is the description cut. The duration stays.
 */
function columnsRow(columns: OneRowColumns, column: number | undefined, width: number): Row {
  const { time } = columns
  const room = Math.max(1, width - (time === '' ? 0 : widthOf(time) + GAP))
  const wanted = columns.description === undefined ? 0 : widthOf(textOfRow(row(...columns.description))) + GAP
  const command = fitRow(row(...columns.command), Math.max(Math.min(COMMAND_MIN_CELLS, room), room - wanted))
  const used = widthOf(textOfRow(command))
  const at = Math.max(used + GAP, Math.min(column ?? 0, room - wanted + GAP))
  const description = columns.description === undefined || room - at < 1 ? undefined : fitRow(row(...columns.description), room - at)
  const left = description === undefined ? command : row(...command.spans, span(' '.repeat(at - used)), ...description.spans)
  if (time === '') return left
  const gap = Math.max(1, width - widthOf(textOfRow(left)) - widthOf(time))
  return fitRow(row(...left.spans, span(' '.repeat(gap)), span(time, 'muted')), width)
}

/** A collapsed tool call as one row in the {@link columnsRow} columns. */
function toolLine(item: ToolItem, width: number, column: number | undefined): Row {
  const time = item.settled && item.startedAt !== undefined && item.completedAt !== undefined ? duration(item.completedAt - item.startedAt) : ''
  return columnsRow({ command: toolCommand(item), description: toolDescription(item), time }, column, width)
}

/** Whether reasoning is still arriving: live Thinking, as opposed to a settled thought. */
const thinking = (item: AssistantItem): boolean => !item.settled && item.text === '' && item.reasoningEndedAt === undefined
/** A settled thought the reader has not opened; it renders as one row. */
const foldedThought = (item: AssistantItem, options: DocumentOptions): boolean =>
  item.reasoning !== '' && !thinking(item) && options.overrides[`reasoning:${item.id}`] !== true

/**
 * A folded, settled thought as one row in the {@link columnsRow} columns: `◦ Thought` in the reasoning tone, the line count
 * muted, and the reasoning time when both its timestamps are known. Every cell toggles the reasoning open.
 */
function thoughtLine(item: AssistantItem, width: number, column: number | undefined): Row {
  const count = item.reasoning.split('\n').length
  const time = item.reasoningStartedAt === undefined || item.reasoningEndedAt === undefined ? '' : duration(item.reasoningEndedAt - item.reasoningStartedAt)
  const value = columnsRow({ command: THOUGHT_COMMAND, description: [span(`${count} line${count === 1 ? '' : 's'}`, 'muted')], time }, column, width)
  return clickable(value, { kind: 'toggle-reasoning', itemId: item.id })
}

/** An item that renders as one row after its blank row: a collapsed tool call outside the raw inspector, or a lone folded thought. */
function isOneRow(item: Item, options: DocumentOptions): boolean {
  if (item.kind === 'tool') return !(options.overrides[item.id] ?? options.expanded) && options.raw !== true
  return item.kind === 'assistant' && item.text === '' && foldedThought(item, options)
}
/**
 * Render one transcript item: a blank row, then the item behind a two-cell margin. A user prompt marks its first row with `›`
 * and an assistant message with `●`. A collapsed tool call and a folded settled thought are one row each in command,
 * description and duration columns, and open into a bordered card. Live reasoning is its label with the Thinking mark on the
 * label's middle row, followed by the reasoning text when opened. Rows carry the item id, a heading flag on the row after the
 * blank one, and click actions.
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
    if (foldedThought(item, options)) rows.push(...indent([thoughtLine(item, content, options.column)]))
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
      const reasoningRows = (cells: number): Row[] => options.streaming?.prose.rows(item.id, item.reasoning, cells)
        ?? wrapProse(row(span(item.reasoning, 'reasoning')), cells)
      if (activelyThinking) {
        // Live, the label carries the Thinking scene; opening the reasoning replaces the scene with the text.
        const elapsed = item.reasoningStartedAt === undefined || options.now === undefined
          ? (options.tick ?? 0) * ANIMATION_TICK_MS : Math.max(0, options.now - item.reasoningStartedAt)
        const decorated = thinkingRows(label, item.id, elapsed, content, options, !reasoningExpanded)
        rows.push(...indent(decorated.map(value => clickable(value, toggleAction))))
        if (reasoningExpanded) rows.push(...indent(indentRows(reasoningRows(Math.max(1, content - GAP)), ' '.repeat(GAP), content)))
      } else {
        const body = reasoningExpanded ? reasoningRows(Math.max(1, content - 4)) : []
        rows.push(...indent(disclosure(label, body, content, 'reasoning', toggleAction, reasoningExpanded)))
      }
    }
    if (item.text !== '') {
      const original = unsafe.kind === 'assistant' ? unsafe.text : item.text
      rows.push(...indent(options.streaming?.markdown.rows(item.id, original, content) ?? markdownRows(original, content), span('● ', 'accent')))
    }
    if (item.reasoning === '' && item.text === '' && !item.settled) {
      const label = row(span('Waiting for model…', 'muted'))
      rows.push(...indent(thinkingRows(label, item.id, (options.tick ?? 0) * ANIMATION_TICK_MS, content, options, true)))
    }
  } else if (item.kind === 'tool') {
    if (isOneRow(item, options)) rows.push(...indent([toolLine(item, content, options.column)]))
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
/** A running `laya_context_pruner` pass, as the live pruning row shows it. */
export interface LayaPass {
  /** The pass's latest reported phase; a pass without phase is pruning. */
  readonly phase: LayaPhase | undefined
  /** Local pruning time in milliseconds, counted from when the pass began pruning; zero holds the first frame. */
  readonly elapsedMs: number
}

/** Layout inputs for the live pruning row. */
export interface LayaPassOptions {
  /** Width of the conversation. */
  readonly width: number
  /** Source of the pruning mark; without it the label stands alone. */
  readonly animations?: SceneAnimations
}

/**
 * The live row of a running Laya pass, drawn after the conversation where live Thinking sits: the real phase label on the
 * middle row of the pruning mark, which follows it after two cells. The mark moves in the prune phase and for a pass without
 * phase, and holds its first frame in the phases that manage the model. It shows no counts; the result row follows the pass.
 * @param pass - the running pass.
 * @param options - layout inputs.
 * @returns a blank row, then the label and mark behind the conversation margin.
 */
export function layaPassRows(pass: LayaPass, options: LayaPassOptions): Row[] {
  const margin = options.width >= MARGIN_MIN_WIDTH ? MARGIN : ''
  const content = contentWidth(options.width)
  const frame = options.animations?.frame(PRUNING_SCENE, layaCutting(pass.phase) ? pass.elapsedMs : 0)
  const rows = besideLabel(row(span(layaPhaseLabel(pass.phase), 'accent', true)), frame, content)
  return [row(''), ...margin === '' ? rows : indentRows(rows, margin, options.width)].flatMap(value => wrapRow(value, options.width))
}

/**
 * The description column of every run of consecutive one-row items: two cells after the run's widest command, at most
 * {@link COLUMN_SHARE} of the content width.
 */
function sharedColumns(items: readonly Item[], options: DocumentOptions): Map<string, number> {
  const columns = new Map<string, number>()
  const limit = Math.floor(contentWidth(options.width) * COLUMN_SHARE)
  let run: string[] = [], widest = 0
  const close = (): void => {
    for (const id of run) columns.set(id, Math.min(widest + GAP, limit))
    run = []; widest = 0
  }
  for (const item of items) {
    const command = oneRowCommand(item, options)
    if (command === undefined) { close(); continue }
    run.push(item.id)
    widest = Math.max(widest, widthOf(textOfRow(row(...command))))
  }
  close()
  return columns
}

/**
 * Reuse settled row layouts; streaming a token must not re-highlight old files.
 * @returns a renderer whose `render` lays out items through a per-item cache, leaves out the blank row between consecutive
 *   one-row items (collapsed tool calls and folded thoughts), aligns their description columns, and drops entries for absent
 *   items, and whose `clear` empties every cache.
 */
export function createDocumentRenderer(): { render(items: readonly Item[], options: DocumentOptions): Row[]; clear(): void } {
  const cache = new Map<string, { item: Item; key: string; rows: Row[] }>()
  const streaming = { markdown: createStreamingMarkdown(), prose: createStreamingProse('reasoning') }
  return {
    clear() { cache.clear(); streaming.markdown.clear(); streaming.prose.clear() },
    render(items, options) {
      const latestThinking = items.findLast(item => item.kind === 'assistant' && (item.reasoning !== '' || (!item.settled && item.text === '')))?.id
      const shown = options.changesOnly === true ? items.filter(isChange) : items
      const columns = sharedColumns(shown, options)
      const ids = new Set<string>(); const result: Row[] = []
      for (const item of items) ids.add(item.id)
      let previousLine = false
      for (const item of shown) {
        // Consecutive one-row tool calls and folded thoughts form a list without blank rows between them.
        const line = isOneRow(item, options), joined = line && previousLine
        previousLine = line
        const reasoningOverride = options.overrides[`reasoning:${item.id}`] ?? false
        const activeThinking = item.kind === 'assistant' && thinking(item)
        const decorated = item.id === latestThinking
        const column = columns.get(item.id)
        const layout: DocumentOptions = { ...options, streaming, thinkingDecoration: decorated, ...column === undefined ? {} : { column } }
        const tickKey = activeThinking ? `${options.tick ?? 0}:${Math.floor((options.now ?? 0) / 1000)}` : 'settled'
        const key = `${options.width}:${options.overrides[item.id] ?? options.expanded}:${reasoningOverride}:${options.raw === true}:${decorated}:${column ?? ''}:${tickKey}`
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
