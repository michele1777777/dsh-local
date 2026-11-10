/** Complete, scrollable conversation document. All folding is view-local. */
import type { LayaPhase } from '@deepseek-ai/dsh-compaction-laya-pruner'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AssistantItem, Item, LayaItem, NoticeItem, ToolItem } from './transcript.ts'
import { textOf } from './transcript.ts'
import { reviewDiff } from './diff.ts'
import { diffRows } from './diff-layout.ts'
import { codeBlocks } from './code-blocks.ts'
import { COPY_LABEL, createStreamingMarkdown, createStreamingProse, markdownRows, type StreamingLayout } from './markdown-layout.ts'
import { duration, layaCutting, layaPhaseLabel } from './metrics.ts'
import { fitRow, indentRows, onBackground, padText, row, span, STATUS_DOT, textOfRow, widthOf, wrapProse, wrapRow, type Row, type Span } from './rich-text.ts'
import { highlight, languageOf } from './syntax.ts'
import { displayTree, jsonText, safeText, tokens } from './terminal.ts'
import { toolBadge } from './tool-format.ts'
import type { UiAction } from './actions.ts'
import type { Tone } from './theme.ts'
import { widenSky } from './sky.ts'
import { ANIMATION_TICK_MS, CONSTELLATION_MS, CONSTELLATION_STILL_MS, PRUNING_SCENE, THINKING_MARK, THINKING_SCENE, type SceneAnimations } from './animation.ts'

/** Layout inputs for the conversation document; `overrides` maps item ids (and `reasoning:<id>`) to per-item expansion. */
export interface DocumentOptions {
  width: number
  expanded: boolean
  overrides: Readonly<Record<string, boolean>>
  raw?: boolean
  tick?: number
  now?: number
  /** Only the latest reasoning segment carries the Thinking mark. */
  thinkingDecoration?: boolean
  /** False holds every animation on a still frame. */
  motion?: boolean
  /**
   * Terminal height; the Thinking scene needs {@link THINKING_SCENE_MIN_TERMINAL_ROWS}, and shorter terminals get the small
   * mark. From {@link ROOMY_TERMINAL_ROWS} a blank row separates consecutive one-row items.
   */
  terminalRows?: number
  /** Source of the Thinking mark beside live reasoning and the Waiting for model label; without it neither shows a mark. */
  animations?: SceneAnimations
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

/**
 * Fewest terminal rows that get the roomy layout: a blank row between consecutive one-row items in the conversation, between
 * a thought and the answer that follows it, under the header, under the indicator row and above the composer. A shorter
 * terminal keeps every row for content.
 */
export const ROOMY_TERMINAL_ROWS = 28

/** Terminal rows the Thinking scene needs: the label, the scene and its caption, and the header, composer and status line. */
const THINKING_SCENE_MIN_TERMINAL_ROWS = THINKING_SCENE.rows + 14

/** The constellation a live item opens on: a hash of its id, so consecutive thoughts start on different figures. */
function firstFigure(id: string, figures: number): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193)
  return (hash >>> 0) % figures
}

/** Most rows of live reasoning shown under the Thinking scene. */
const THINKING_TAIL = 2

/**
 * The latest reasoning under the Thinking scene: its last {@link THINKING_TAIL} non-empty rows behind a dotted rail, muted
 * and italic, with a cursor after the last one.
 */
function thinkingTail(lines: readonly Row[]): Row[] {
  const kept = lines.filter(value => textOfRow(value).trim() !== '').slice(-THINKING_TAIL)
  return kept.map((line, index) => row(span('┊ ', 'comment'), ...line.spans.map((part): Span => ({ ...part, tone: 'muted', italic: true })),
    ...index === kept.length - 1 ? [span('▍', 'reasoning')] : []))
}

/**
 * Live Thinking or Waiting rows: the label, then the constellation scene under it across the whole width, the figure
 * centred and grey background stars on both sides, then the latest reasoning. The figure's name types itself out at the
 * right end of the label's row, before a star mark. A terminal shorter than {@link THINKING_SCENE_MIN_TERMINAL_ROWS} or
 * narrower than the scene gets the small mark beside the label instead; the open reasoning, a superseded segment and a
 * missing asset get the label alone.
 * @param label - the label row.
 * @param id - the item id, which picks the first constellation.
 * @param elapsedMs - time since the item started thinking.
 * @param content - cells inside the item margin.
 * @param options - the document options; `motion` false shows a still.
 * @param decorated - whether this label carries the decoration at all.
 * @param tail - the latest reasoning rows, shown under the decoration.
 * @returns the rows, before the margin.
 */
function thinkingRows(label: Row, id: string, elapsedMs: number, content: number, options: DocumentOptions, decorated: boolean,
  tail: readonly Row[] = []): Row[] {
  const animations = options.animations
  if (!decorated || options.thinkingDecoration === false || animations === undefined) return wrapRow(label, content)
  const sky = animations.animation(THINKING_SCENE)
  if (sky !== undefined && (options.terminalRows ?? 0) >= THINKING_SCENE_MIN_TERMINAL_ROWS && content >= THINKING_SCENE.columns) {
    const figures = Math.max(1, Math.floor(sky.durationMs / CONSTELLATION_MS))
    const at = firstFigure(id, figures) * CONSTELLATION_MS + (options.motion === false ? CONSTELLATION_STILL_MS : elapsedMs)
    const figure = Math.floor(at / CONSTELLATION_MS) % figures
    const frame = Math.floor(at % CONSTELLATION_MS / 100)
    const scene = widenSky(animations.frame(THINKING_SCENE, at) ?? [], figure, frame, content)
    // The name is placed by its full length, so it grows in place while it types itself out.
    const name = animations.caption(THINKING_SCENE, figure * CONSTELLATION_MS + CONSTELLATION_STILL_MS) ?? ''
    const caption = animations.caption(THINKING_SCENE, at) ?? ''
    const used = widthOf(textOfRow(label)), mark = ' ✧ '
    const start = content - widthOf(name) - widthOf(mark)
    const top = caption === '' || start < used + GAP ? label
      : row(...label.spans, span(' '.repeat(start - used)), span(padText(caption, widthOf(name)), 'reasoning'), span(mark, 'comment'))
    return [...wrapRow(top, content), ...scene, ...tail]
  }
  return [...besideLabel(label, animations.frame(THINKING_MARK, options.motion === false ? 0 : elapsedMs), content), ...tail]
}

/** Every cell of `value` runs `action`. */
const clickable = (value: Row, action: UiAction): Row => ({ ...value, spans: value.spans.map(part => ({ ...part, action })) })

/** Cells the rail of an open disclosure takes before its body. */
const RAIL = 2

/**
 * One open disclosure: the title row, which is the click target that folds it, then the body behind a rail in `tone`: dotted
 * for a thought and a command result, a heavier dashed one for a tool call. The
 * body has no closing edge and no right border, so wrapped output never has a border to keep aligned.
 */
function disclosure(title: Row, body: readonly Row[], width: number, tone: Tone, action: UiAction, rail = '┊ '): Row[] {
  if (width < 8) return [clickable(fitRow(title, width), action), ...body.flatMap(value => wrapRow(value, width))]
  return [clickable(fitRow(title, width), action),
    ...body.flatMap(value => wrapRow(value, width - RAIL)).map(line => ({ ...line, spans: [span(rail, tone), ...line.spans] }))]
}

function field(label: string, value: string, width: number): Row[] {
  return [row(span(label, 'muted', true)), ...wrapRow(row(value), width)]
}

const kTokens = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
/** Cells of the before and after meters of a pruning result, and of the meter beside each judged output. */
const LAYA_METER = 24, LAYA_ENTRY_METER = 10
/** Narrowest content that shows the meters; below it the result keeps its figures only. */
const LAYA_METER_MIN_WIDTH = 60

/** A meter `size` cells long with `filled` of them full, in the accent tone over a faint track. */
const meter = (filled: number, size: number, tone: Tone = 'accent'): Span[] =>
  [span('▰'.repeat(Math.max(0, Math.min(size, filled))), tone), span('▱'.repeat(Math.max(0, size - Math.max(0, filled))), 'comment')]

/**
 * A `laya_context_pruner` result. Its title says in words what happened and by how much the context shrank; two meters
 * compare the context before and after, with the counts of kept, truncated and dropped outputs; then the judged outputs with
 * the biggest savings first (all of them when expanded), each behind a full, half or empty circle for kept, truncated and
 * dropped, with what is left of it as a meter. One colour, the accent, carries what remains; the rest is grey.
 */
function layaRows(item: LayaItem, width: number, expanded: boolean): Row[] {
  const out: Row[] = []
  const fold = span(`${expanded ? '▾' : '▸'} `, 'muted'), mark = span('▞▚ ', 'accent')
  if (item.outcome !== 'pruned') {
    return [fitRow(row(fold, mark, span('Context pruning skipped', 'text', true),
      span(` · regular compaction decides${item.error === undefined ? '' : ` · ${item.error}`}`, 'warning')), width)]
  }
  const pct = item.tokensBefore > 0 ? Math.round(100 * (1 - item.tokensAfter / item.tokensBefore)) : 0
  const counts = `${item.kept} kept · ${item.truncated} truncated · ${item.dropped} dropped`
  const title = row(fold, mark, span('Context pruned', 'text', true), span(`  −${pct}%`, 'accent', true))
  const time = duration(item.ms)
  const metered = width >= LAYA_METER_MIN_WIDTH
  // Without room for the meters the title carries the figures.
  const left = metered ? title : row(...title.spans, span(`  ${kTokens(item.tokensBefore)} → ${kTokens(item.tokensAfter)}`, 'muted'))
  const gap = Math.max(1, width - widthOf(textOfRow(left)) - widthOf(time))
  out.push(fitRow(row(...left.spans, span(' '.repeat(gap)), span(time, 'muted')), width))
  if (metered) {
    const after = item.tokensBefore > 0 ? Math.round(LAYA_METER * item.tokensAfter / item.tokensBefore) : 0
    out.push(fitRow(row(span('  before ', 'comment'), ...meter(LAYA_METER, LAYA_METER, 'muted'), span(`  ${kTokens(item.tokensBefore)}`, 'muted')), width))
    out.push(fitRow(row(span('  after  ', 'comment'), ...meter(after, LAYA_METER), span(`  ${kTokens(item.tokensAfter)}`, 'text', true), span(`   ${counts}`, 'muted')), width))
  } else out.push(fitRow(row(span(`  ${counts}`, 'muted')), width))
  const sorted = [...item.entries].sort((a, b) => (b.tokensBefore - b.tokensAfter) - (a.tokensBefore - a.tokensAfter))
  const shown = expanded ? sorted : sorted.slice(0, 4)
  const label = Math.max(8, Math.min(40, Math.max(0, ...shown.map(entry => widthOf(entry.label)))))
  for (const entry of shown) {
    const kept = entry.action === 'KEEP', dropped = entry.action === 'DROP'
    const tone = kept ? 'text' : dropped ? 'comment' : 'muted'
    const left = entry.tokensBefore > 0 ? Math.round(LAYA_ENTRY_METER * entry.tokensAfter / entry.tokensBefore) : 0
    out.push(fitRow(row(span(`  ${kept ? '●' : dropped ? '○' : '◐'} `, dropped ? 'comment' : 'accent'),
      span((kept ? 'kept' : dropped ? 'dropped' : 'truncated').padEnd(10), tone), span(fitRow(row(span(entry.label)), label).spans.map(part => part.text).join('').padEnd(label), tone),
      span(`  ${kTokens(entry.tokensBefore).padStart(5)} → ${kTokens(entry.tokensAfter).padEnd(5)}`, 'muted'),
      ...metered ? [span(' '), ...meter(left, LAYA_ENTRY_METER)] : []), width))
  }
  if (!expanded && sorted.length > shown.length) out.push(row(span(`  … ${sorted.length - shown.length} more · click title to toggle inline`, 'muted')))
  return out
}
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
      // The exit code and the signal stand in the card's title row.
      result = wrapRow(row(span(view.output || '(no output)', 'text')), width)
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

/** The note in an open tool card's title row: a command's exit code or signal, otherwise the collapsed row's result note. */
function openNote(item: ToolItem): Span[] | undefined {
  const view = item.result
  if (item.settled && item.cancelled !== true && !item.isError && view?.card === 'terminal') {
    if (view.signal !== undefined) return [span(`signal ${view.signal}`, 'warning')]
    return view.exitCode === undefined ? undefined : [span(`exit ${view.exitCode}`, view.exitCode === 0 ? 'success' : 'error')]
  }
  return toolNote(item)
}

/** A turn or command error as the transcript records it: an internal code, a colon and the message. */
const CODED = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+): ([\s\S]+)$/u

/**
 * A chat-owned line. An error stands behind a rail in the error tone: its code in words as a bold title when the text opens
 * with one, then the message. A success is one row in the success tone, and any other line one muted row.
 */
function noticeRows(item: NoticeItem, width: number): Row[] {
  if (item.level !== 'error') {
    const tone = item.level === 'success' ? 'success' : 'muted'
    return wrapProse(row(span(`${item.level === 'success' ? STATUS_DOT : '■'} ${item.text}`, tone)), width)
  }
  const coded = CODED.exec(item.text)
  const words = coded?.[1]?.replace(/_/gu, ' ') ?? ''
  const title = coded === null ? [] : [span(`${words.charAt(0).toUpperCase()}${words.slice(1)}`, 'error', true), span('  ')]
  return wrapProse(row(span(`${STATUS_DOT} `, 'error', true), ...title, span(coded?.[2] ?? item.text, coded === null ? 'error' : 'text')), Math.max(1, width - RAIL))
    .map(line => ({ ...line, spans: [span('┃ ', 'error'), ...line.spans] }))
}

/** Transcript items are indented by this margin; the `›` and `●` message markers sit inside it. */
const MARGIN = '  '
/** Below this width items drop the margin and the markers, so no row outgrows the pane. */
const MARGIN_MIN_WIDTH = 12
/** Cells inside the margin of a document `width` cells wide. */
const contentWidth = (width: number): number => Math.max(1, width - (width >= MARGIN_MIN_WIDTH ? MARGIN.length : 0))
/** The connector that hangs a description under the verb of its command. */
const BRANCH = '└─ '

const FENCE = /^(?:`{3,}|~{3,})/u
/** The non-blank lines of a result text, trimmed, without Markdown fence lines. */
const resultLines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(line => line !== '' && !FENCE.test(line))

/** A call that failed: the tool reported an error, or its command exited non-zero or was ended by a signal. */
const failed = (item: ToolItem): boolean => item.isError
  || (item.result?.card === 'terminal' && ((item.result.exitCode !== undefined && item.result.exitCode !== 0) || item.result.signal !== undefined))

/** The description the model gave a call (a command's `description` argument), on one line, or undefined. */
function callDescription(item: ToolItem): string | undefined {
  const given = item.call.card === 'terminal' ? item.call.description : undefined
  const value = given ?? (typeof item.args === 'object' && item.args !== null && 'description' in item.args ? item.args.description : undefined)
  if (typeof value !== 'string') return undefined
  const line = safeText(value).replace(/\s+/gu, ' ').trim()
  return line === '' ? undefined : line
}

/**
 * The description of a collapsed tool call: what the model said the call does, while it runs and after it succeeds,
 * followed by the failure in its colour when it fails; a call without such a description shows its result in a few words.
 */
function toolDescription(item: ToolItem): Span[] | undefined {
  const described = callDescription(item)
  const note = toolNote(item)
  if (described === undefined) return note
  const failure = note !== undefined && (item.cancelled === true || failed(item))
  return failure ? [span(described, 'description'), span(' · ', 'muted'), ...note] : [span(described, 'description')]
}

/**
 * The result of a collapsed tool call in a few words, or nothing when the command already says it. A file change counts its
 * added lines in the success tone and its removed lines in the error tone.
 */
function toolNote(item: ToolItem): Span[] | undefined {
  if (!item.settled) return undefined
  if (item.cancelled === true) return [span('interrupted', 'warning')]
  if (item.isError) return [span(resultLines(item.resultText ?? '')[0] ?? 'failed', 'error')]
  const view = item.result, said = (text: string | undefined): Span[] | undefined => text === undefined ? undefined : [span(text, 'description')]
  switch (view?.card) {
    case undefined: return said(resultLines(item.resultText ?? '')[0])
    case 'diff': {
      let added = 0, removed = 0
      for (const diff of view.diffs) {
        const review = reviewDiff(diff.oldText, diff.newText)
        added += review.added; removed += review.removed
      }
      return [span(`+${added}`, 'success'), span(' '), span(`−${removed}`, 'error')]
    }
    case 'terminal':
      if (view.signal !== undefined) return [span(`signal ${view.signal}`, 'warning')]
      if (view.exitCode !== undefined && view.exitCode !== 0) return [span(`exit ${view.exitCode}`, 'error')]
      return said(resultLines(view.output ?? '').at(-1))
    case 'read': return undefined
    case 'search': return said(`${view.total} ${view.shape === 'paths' ? 'paths' : 'matches'}`)
    case 'web': return said(view.kind === 'fetch' ? `HTTP ${view.statusCode}` : `${view.sources.length} sources`)
    case 'generic': return said(resultLines(view.content === undefined ? item.resultText ?? '' : textOf(view.content))[0])
    default: return assertNever(view, 'tool result card')
  }
}

/** Cells a collapsed tool call's verb is padded to, so the targets of consecutive calls start in one column. */
const VERB_CELLS = 6

/**
 * The command of a collapsed tool call: the status dot (green when it succeeded, red when it failed, yellow when it was
 * interrupted, a ring while it runs), the verb in its tool category's tone, padded to
 * {@link VERB_CELLS}, and the target. A command runs (`Run <command>`); other titles that open with a capitalised word use
 * it as the verb (`Read src/auth.ts`). Control text is neutralized, so the renderer can measure the column before laying the
 * item out.
 */
function toolCommand(item: ToolItem): Span[] {
  const glyph = item.cancelled === true ? span(STATUS_DOT, 'warning') : failed(item) ? span(STATUS_DOT, 'error')
    : item.settled ? span(STATUS_DOT, 'success') : span('◌', 'accent')
  const title = safeText(item.result?.title || item.call.title || item.name)
  const command = item.call.card === 'terminal' || (item.call.card === 'generic' && item.call.kind === 'execute')
  const named = /^(\p{Lu}[\p{L}-]*)\s+(\S[\s\S]*)$/u.exec(title)
  const name = safeText(item.name)
  const [verb, target] = command ? ['Run', safeText(item.call.title)] : named !== null ? [named[1] ?? '', named[2] ?? ''] : [name, title === name ? '' : title]
  const tone = toolBadge(item.name, item.call, item.result).tone
  return [glyph, span(` ${target === '' ? verb : verb.padEnd(VERB_CELLS)}`, tone, true), ...target === '' ? [] : [span(' '), span(target, 'text')]]
}

/** The command column of a folded thought. */
const THOUGHT_COMMAND: readonly Span[] = [span('✦ Thought', 'reasoning')]

/**
 * A command row cut to `width` cells. Its last span, the target, keeps its start and its last whole words around ` … `, so
 * the program and the final arguments both show; a target whose end has no word break in reach is cut at its end instead.
 * The glyph and verb before the target are never cut.
 */
function cutMiddle(command: readonly Span[], width: number): Row {
  const whole = row(...command)
  if (widthOf(textOfRow(whole)) <= width) return whole
  const target = command.at(-1), lead = command.slice(0, -1)
  const room = width - widthOf(textOfRow(row(...lead))) - 3
  if (target === undefined || command.length < 2 || room < 8 || widthOf(target.text) !== target.text.length) return fitRow(whole, width)
  const headCells = Math.ceil(room * 2 / 3)
  const end = target.text.slice(target.text.length - (room - headCells)), word = end.indexOf(' ')
  if (word < 0 || word === end.length - 1) return fitRow(whole, width)
  let head = target.text.slice(0, headCells)
  if (head.lastIndexOf(' ') > headCells / 2) head = head.slice(0, head.lastIndexOf(' '))
  return row(...lead, { ...target, text: head }, span(' … ', 'muted'), { ...target, text: end.slice(word + 1) })
}

/**
 * A collapsed tool call: the command, cut in its middle when it is too long, with an optional note and the duration right
 * after it behind a middle dot; then the description on its own rows under the verb, hung on a thin connector and wrapped,
 * never cut.
 * @param command - glyph, verb and target.
 * @param description - what the model said the call does, else its result in a few words; a failure keeps its colour.
 * @param time - the duration, empty when unknown.
 * @param width - cells available.
 * @param note - spans that follow the command before the duration, such as an exit code.
 */
function commandRows(command: readonly Span[], description: readonly Span[] | undefined, time: string, width: number,
  note: readonly Span[] = []): Row[] {
  const after = [...note.length === 0 ? [] : [span(' · ', 'comment'), ...note], ...time === '' ? [] : [span(' · ', 'comment'), span(time, 'muted')]]
  const first = fitRow(row(...cutMiddle(command, Math.max(1, width - widthOf(textOfRow(row(...after))))).spans, ...after), width)
  if (description === undefined) return [first]
  // The connector starts under the verb: after the status dot and its space, and after the fold mark of an open call.
  const verb = command.findIndex(part => part.bold === true)
  const lead = Math.min(Math.max(0, width - 8), widthOf(textOfRow(row(...command.slice(0, Math.max(0, verb))))) + 1)
  return [first, ...wrapProse(row(...description), Math.max(1, width - lead - BRANCH.length))
    .map((line, index) => ({ ...line, spans: [span(' '.repeat(lead)), span(index === 0 ? BRANCH : ' '.repeat(BRANCH.length), 'comment'), ...line.spans] }))]
}

/** A collapsed tool call as {@link commandRows} lays it out. */
function toolLines(item: ToolItem, width: number): Row[] {
  const time = item.settled && item.startedAt !== undefined && item.completedAt !== undefined ? duration(item.completedAt - item.startedAt) : ''
  return commandRows(toolCommand(item), toolDescription(item), time, width)
}

/** Whether reasoning is still arriving: live Thinking, as opposed to a settled thought. */
const thinking = (item: AssistantItem): boolean => !item.settled && item.text === '' && item.reasoningEndedAt === undefined
/** A settled thought the reader has not opened; it renders as one row. */
const foldedThought = (item: AssistantItem, options: DocumentOptions): boolean =>
  item.reasoning !== '' && !thinking(item) && options.overrides[`reasoning:${item.id}`] !== true

/**
 * A folded, settled thought as one row: `✦ Thought` in the reasoning tone, then, muted, the reasoning time when both its
 * timestamps are known and the line count otherwise. Every cell toggles the reasoning open.
 */
function thoughtLine(item: AssistantItem, width: number): Row {
  const count = item.reasoning.split('\n').length
  const said = item.reasoningStartedAt === undefined || item.reasoningEndedAt === undefined
    ? `${count} line${count === 1 ? '' : 's'}` : duration(item.reasoningEndedAt - item.reasoningStartedAt)
  return clickable(fitRow(row(...THOUGHT_COMMAND, span(` · ${said}`, 'muted')), width), { kind: 'toggle-reasoning', itemId: item.id })
}

/**
 * An item that renders as a list row after its blank row: a collapsed tool call outside the raw inspector, which takes a
 * row under its command for its description, or a lone folded thought.
 */
function isOneRow(item: Item, options: DocumentOptions): boolean {
  if (item.kind === 'tool') return !(options.overrides[item.id] ?? options.expanded) && options.raw !== true
  return item.kind === 'assistant' && item.text === '' && foldedThought(item, options)
}
/**
 * Render one transcript item: a blank row, then the item behind a two-cell margin. A user prompt is bold on a band across the
 * width behind an accent bar, and an assistant answer marks its first visible row with a dot. A collapsed tool call and a folded
 * settled thought are a list row each, a tool call with its description on a connector row below, and open into a title row
 * with the body behind a rail. Live reasoning is its label with the Thinking scene or mark and its latest rows, or the
 * reasoning text when opened. Rows carry the item id, a heading flag on the row after the blank one, and click actions.
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
    // A prompt stands on a band across the whole width, behind an accent bar in the margin, so the reader's own turns
    // are easy to find while scrolling.
    const lines = wrapProse(row(span(item.text, 'text', true)), content)
    rows.push(...lines.map(line => onBackground(margin === '' ? line : { ...line, spans: [span('▌ ', 'accent'), ...line.spans] }, width, 'band')))
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
      const reasoningRows = (cells: number): Row[] => options.streaming?.prose.rows(item.id, item.reasoning, cells)
        ?? wrapProse(row(span(item.reasoning, 'reasoning')), cells)
      if (activelyThinking) {
        // Live, the label carries the Thinking scene; opening the reasoning replaces the scene with the text.
        const elapsed = item.reasoningStartedAt === undefined || options.now === undefined
          ? (options.tick ?? 0) * ANIMATION_TICK_MS : Math.max(0, options.now - item.reasoningStartedAt)
        const tail = reasoningExpanded ? [] : thinkingTail(reasoningRows(Math.max(1, content - RAIL - 1)))
        const decorated = thinkingRows(label, item.id, elapsed, content, options, !reasoningExpanded, tail)
        rows.push(...indent(decorated.map(value => clickable(value, toggleAction))))
        if (reasoningExpanded) rows.push(...indent(indentRows(reasoningRows(Math.max(1, content - GAP)), ' '.repeat(GAP), content)))
      } else {
        const body = reasoningExpanded ? reasoningRows(Math.max(1, content - RAIL)) : []
        rows.push(...indent(disclosure(label, body, content, 'reasoning', toggleAction)))
      }
    }
    if (item.text !== '') {
      const original = unsafe.kind === 'assistant' ? unsafe.text : item.text
      const answer = options.streaming?.markdown.rows(item.id, original, content) ?? markdownRows(original, content)
      const firstVisible = answer.findIndex(line => textOfRow(line).trim() !== '')
      if (firstVisible >= 0) {
        if (rows.length > 1 && (options.terminalRows ?? 0) >= ROOMY_TERMINAL_ROWS) rows.push(row(''))
        rows.push(...indent(answer.slice(firstVisible), span(`${STATUS_DOT} `, 'accent')))
      }
    }
    if (item.reasoning === '' && item.text === '' && !item.settled) {
      const label = row(span('Waiting for model…', 'muted'))
      rows.push(...indent(thinkingRows(label, item.id, (options.tick ?? 0) * ANIMATION_TICK_MS, content, options, true)))
    }
  } else if (item.kind === 'tool') {
    if (isOneRow(item, options)) rows.push(...indent(toolLines(item, content)))
    else {
      const inner = Math.max(1, content - RAIL)
      const body: Row[] = []
      if (!options.raw) {
        const command = item.call.card === 'terminal' || (item.call.card === 'generic' && item.call.kind === 'execute')
        const described = command ? callDescription(item)
          ?? (item.call.card === 'generic' && item.call.content !== undefined ? textOf(item.call.content) : undefined) : undefined
        // What the model said the command does, under the command in the title row.
        if (described !== undefined && described !== '') body.push(...wrapProse(row(span(described, 'description')), inner), row(''))
        if (!command && item.call.card === 'generic' && item.call.content !== undefined) body.push(...markdownRows(textOf(item.call.content), inner), row(''))
        // A call whose result has no view of its own shows the arguments it was given.
        if (!command && (item.result === undefined || item.result.card === 'generic')) body.push(...field('Arguments', json(item.args), inner), row(''))
      }
      body.push(...resultRows(item, inner, options.raw === true))
      if (!item.settled) body.push(row(span('Running…', 'accent')))
      const time = item.settled && item.startedAt !== undefined && item.completedAt !== undefined ? duration(item.completedAt - item.startedAt) : ''
      const [title] = commandRows([span('▾ ', 'muted'), ...toolCommand(item)], undefined, time, content, openNote(item))
      rows.push(...indent(disclosure(title ?? row(''), body, content, toolBadge(item.name, item.call, item.result).tone,
        { kind: 'inspect-item', itemId: item.id }, '┇ ')))
    }
  } else if (item.kind === 'command') {
    // Folded, a command is one row: its name, its state and the first line of what it answered.
    const failure = item.result?.kind === 'error'
    const state = item.settled ? failure ? 'failed' : 'completed' : 'running'
    const said = resultLines(item.result?.text ?? '')
    const title = row(span(`${expanded ? '▾' : '›'} `, 'muted'), span(`/${item.name}`, 'command', true), span(` · ${state}`, failure ? 'error' : 'muted'),
      ...expanded || said[0] === undefined ? [] : [span(` · ${said[0]}`, failure ? 'error' : 'muted'), ...said.length > 1 ? [span(` · ${said.length - 1} more line${said.length === 2 ? '' : 's'}`, 'muted')] : []])
    const inner = Math.max(1, content - RAIL)
    const body: Row[] = []
    if (expanded) {
      body.push(...field('Arguments', item.args.trim() || '(none)', inner))
      if (item.result?.text !== undefined) body.push(row(''), ...wrapRow(row(span(item.result.text, failure ? 'error' : 'text')), inner))
    }
    rows.push(...indent(disclosure(title, body, content, 'muted', { kind: 'inspect-item', itemId: item.id })))
  } else if (item.kind === 'laya') {
    rows.push(...indent(layaRows(item, content, expanded)))
  } else {
    rows.push(...indent(noticeRows(item, content)))
  }
  const blocks = unsafe.kind === 'assistant' ? codeBlocks(unsafe.text) : []
  const collapsedTool = item.kind === 'tool' && isOneRow(item, options)
  let block = 0
  return rows.flatMap(value => wrapRow(value, width)).map((value, index) => {
    let spans = value.spans
    if (value.codeHeader === true) {
      const at = block++
      spans = spans.map(part => part.text === COPY_LABEL && blocks[at] !== undefined
        ? { ...part, action: { kind: 'copy-code' as const, itemId: item.id, block: at } } : part)
    }
    // Row 0 is the blank row above every item; row 1 is its heading. Every row of a collapsed tool call opens it.
    const heading = index === 1
    const opens = heading ? item.kind === 'tool' || item.kind === 'laya' || item.kind === 'command' : index > 1 && collapsedTool
    if (opens) spans = spans.map(part => ({ ...part, action: { kind: 'inspect-item' as const, itemId: item.id } }))
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

/** A context compaction in progress, as its live row shows it. */
export interface CompactionPass {
  /** One-cell activity mark. */
  readonly mark: string
  /** Time since the compaction began. */
  readonly elapsedMs: number
  /** Input tokens of the latest model request, the context being compacted; omitted before any request. */
  readonly tokens?: number
}

/**
 * The live row of a running context compaction, directly under the last conversation item with no blank row between: an
 * activity mark, `Compacting context`, the context size, and the elapsed time at the row's end.
 * @param pass - the running compaction.
 * @param width - width of the conversation.
 * @returns the one row, behind the conversation margin.
 */
export function compactingRows(pass: CompactionPass, width: number): Row[] {
  const margin = width >= MARGIN_MIN_WIDTH ? MARGIN : ''
  const left = row(span(margin), span(`${pass.mark} `, 'accent', true), span('Compacting context', 'text', true),
    ...pass.tokens === undefined ? [] : [span(`   ${tokens(pass.tokens)} tokens`, 'muted')])
  const time = pass.elapsedMs < 60_000 ? `${Math.floor(Math.max(0, pass.elapsedMs) / 1000)}s` : duration(pass.elapsedMs)
  const fitted = fitRow(left, Math.max(0, width - widthOf(time) - 2))
  return [row(...fitted.spans, span(' '.repeat(Math.max(1, width - widthOf(textOfRow(fitted)) - widthOf(time) - 1))), span(time, 'comment'))]
}

/**
 * Reuse settled row layouts; streaming a token must not re-highlight old files.
 * @returns a renderer whose `render` lays out items through a per-item cache, leaves out the blank row between consecutive
 *   one-row items (collapsed tool calls and folded thoughts) below {@link ROOMY_TERMINAL_ROWS} terminal rows and, from that
 *   height, the blank row above the first item, and drops entries for absent items, and whose `clear` empties every cache.
 */
export function createDocumentRenderer(): { render(items: readonly Item[], options: DocumentOptions): Row[]; clear(): void } {
  const cache = new Map<string, { item: Item; key: string; rows: Row[] }>()
  const streaming = { markdown: createStreamingMarkdown(), prose: createStreamingProse('reasoning') }
  return {
    clear() { cache.clear(); streaming.markdown.clear(); streaming.prose.clear() },
    render(items, options) {
      const latestThinking = items.findLast(item => item.kind === 'assistant' && (item.reasoning !== '' || (!item.settled && item.text === '')))?.id
      const ids = new Set<string>(); const result: Row[] = []
      for (const item of items) ids.add(item.id)
      let previousLine = false
      const roomy = (options.terminalRows ?? 0) >= ROOMY_TERMINAL_ROWS
      for (const item of items) {
        // On a short terminal consecutive one-row tool calls and folded thoughts form a list without blank rows between them.
        const line = isOneRow(item, options), joined = line && previousLine && !roomy
        previousLine = line
        const reasoningOverride = options.overrides[`reasoning:${item.id}`] ?? false
        const activeThinking = item.kind === 'assistant' && thinking(item)
        const decorated = item.id === latestThinking
        const layout: DocumentOptions = { ...options, streaming, thinkingDecoration: decorated }
        const tickKey = activeThinking ? `${options.tick ?? 0}:${Math.floor((options.now ?? 0) / 1000)}` : 'settled'
        const key = `${options.width}:${options.overrides[item.id] ?? options.expanded}:${reasoningOverride}:${options.raw === true}:${decorated}:${roomy}:${tickKey}`
        let entry = cache.get(item.id)
        const keys = Object.keys(item) as (keyof Item)[]
        const drifted = keys.some(field => item[field] !== entry?.item[field])
        if (entry === undefined || entry.key !== key || drifted || Object.keys(entry.item).length !== keys.length) {
          entry = { item: { ...item }, key, rows: itemRows(item, layout) }; cache.set(item.id, entry)
        }
        // The first item starts under the blank row the screen keeps below its header.
        const headless = joined || (roomy && result.length === 0)
        for (const [index, value] of entry.rows.entries()) if (!headless || index > 0) result.push(value)
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
