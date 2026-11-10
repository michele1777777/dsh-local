/** Terminal-native screen primitives. These consume state, never execute it. */
import type { UiAction } from './actions.ts'
import { commandKind, matchScore, PALETTE_TABS, type CommandEntry, type PaletteTab, type PaletteView } from './commands.ts'
import type { EditorState } from './editor.ts'
import { selectionOf, windowAround } from './editor.ts'
import { activeLine, cellWidth, wrapEditor, type VisualLine } from './layout.ts'
import type { PendingApproval, PendingQuestion } from './interaction.ts'
import type { ChatState, Picker, PickerRow } from './store.ts'
import type { Tone } from './theme.ts'
import { activity, contextReading, duration, goalPhase, nonnegative, recentSpeed, record, sessionIndicators, speedReading, workElapsed } from './metrics.ts'
import { SPEED_SAMPLES } from './transcript.ts'
import { permissionAuditLabel } from './permission-audit.ts'
import { codeBlocks } from './code-blocks.ts'
import { COPY_LABEL, markdownRows } from './markdown-layout.ts'
import { BOX_MIN_WIDTH, boxBottom, boxLine, boxTop, fitRow, indentRows, onBackground, padText, row, rule, span, textOfRow, twoSides, widthOf, wrapProse, wrapRow, type Row, type Span } from './rich-text.ts'
import { contentSummary, jsonText, safeText, tokens } from './terminal.ts'

/**
 * The sticky prompt header: one clickable line naming the request of the
 * section being read. Every cell, the gap included, jumps to that prompt.
 * @param text - the user message, shown on one line.
 * @param itemId - the prompt's transcript item.
 * @param position - 1-based position among the conversation's prompts.
 * @param total - number of prompts in the document.
 * @param width - cells available.
 * @returns the header row.
 */
export function promptHeader(text: string, itemId: string, position: number, total: number, width: number): Row {
  const action = { kind: 'jump-prompt' as const, itemId }
  const joined = twoSides(row(span('↑ › ', 'muted'), span(safeText(text).replace(/\s+/gu, ' ').trim(), 'text')),
    row(span(`prompt ${position}/${total}`, 'muted')), width)
  return { ...joined, spans: joined.spans.map(part => ({ ...part, action })) }
}

/**
 * Centered jump-to-latest button shown while the conversation is scrolled up,
 * followed by one blank row that lifts it off the composer. Only the button
 * cells are clickable.
 * @param linesAboveBottom - document rows below the viewport, shown on the button.
 * @param width - cells available.
 * @returns the button row and the blank row under it.
 */
export function scrollToBottomBar(linesAboveBottom: number, width: number): Row[] {
  const label = `[ ↓ Back to bottom · ${linesAboveBottom} ${linesAboveBottom === 1 ? 'line' : 'lines'} ]`
  const gap = Math.max(0, Math.floor((width - widthOf(label)) / 2))
  const button = fitRow(row(' '.repeat(gap), { ...span(label, 'accent', true), action: { kind: 'live-tail' as const } }), width)
  return [button, row('')]
}

/** The reader's progress through a pending question: current question, highlighted option, chosen labels and custom answer. */
export interface QuestionDraft { index: number; optionIndex: number; selected: string[]; custom: EditorState; customMode: boolean }
/**
 * A fresh question draft.
 * @returns a draft at the first question with nothing chosen.
 */
export const questionDraft = (): QuestionDraft => ({ index: 0, optionIndex: 0, selected: [], custom: { text: '', cursor: 0 }, customMode: false })
/** Braille spinner frames, one cell each. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
/** The welcome text under the whale on an empty conversation. */
const WELCOME_TEXT: readonly Row[] = [
  row(span('What are we building?', 'accent', true)),
  row(''),
  row(span('/resume  continue a session    /model  choose a model', 'muted')),
  row(span('/plan and /goal are provided by your session preset.', 'muted')),
  row(''),
  row(span('Your conversation stays in the shared session log.', 'muted')),
]
/** Cells kept clear on each side of the welcome whale and the welcome text. */
const WELCOME_SIDE = 2

/**
 * The empty conversation: the welcome whale above a blank row and the welcome text, the whole group centred vertically and
 * the whale and each text row centred horizontally. The whale appears only when its columns plus
 * {@link WELCOME_SIDE} cells on each side and the whole group fit; otherwise the text is centred alone. Text too wide for the
 * area wraps behind a two-cell margin.
 * @param whale - the whale frame to show, or undefined when none is available.
 * @param width - cells across the conversation area.
 * @param height - rows of the conversation area.
 * @param place - the working directory and model, shown muted under the title; empty shows none.
 * @returns exactly `height` rows.
 */
export function welcomeRows(whale: readonly Row[] | undefined, width: number, height: number, place = ''): Row[] {
  // The place takes the blank row under the title, so the text keeps its height.
  const text = place === '' ? WELCOME_TEXT : WELCOME_TEXT.map((value, index) => index === 1 ? fitRow(row(span(place, 'muted')), Math.max(0, width - 2 * WELCOME_SIDE)) : value)
  const textWidth = Math.max(...WELCOME_TEXT.map(value => widthOf(textOfRow(value))))
  const pad = (rows: readonly Row[], cells: number): Row[] => rows.map(value => row(span(' '.repeat(Math.max(0, Math.floor((width - cells) / 2)))), ...value.spans))
  let group: Row[]
  if (textWidth + 2 * WELCOME_SIDE > width) group = indentRows(text.flatMap(value => wrapProse(value, Math.max(1, width - 2))), '  ', width)
  else {
    const columns = whale?.[0] === undefined ? 0 : widthOf(textOfRow(whale[0]))
    const fits = whale !== undefined && columns + 2 * WELCOME_SIDE <= width && whale.length + 1 + text.length <= height
    group = [...fits ? [...pad(whale, columns), row('')] : [], ...text.flatMap(value => pad([value], widthOf(textOfRow(value))))]
  }
  const top = Math.max(0, Math.floor((height - group.length) / 2))
  const rows = [...Array.from({ length: top }, () => row('')), ...group].slice(0, height)
  while (rows.length < height) rows.push(row(''))
  return rows
}

/**
 * The header: `DSH` as a filled label, the session title and, on the right, the working directory's own name and the agent
 * preset, both muted.
 * @param state - the chat state.
 * @param width - cells available.
 * @returns the header row.
 */
export function headerRow(state: ChatState, width: number): Row {
  // A narrow terminal keeps the title: the directory name leaves first.
  const folder = width < HEADER_FOLDER_MIN_WIDTH ? '' : state.cwd.split(/[\\/]/u).findLast(part => part !== '') ?? ''
  const place = [folder, state.preset ?? ''].filter(part => part !== '').join(' · ')
  return twoSides(row({ text: ' DSH ', tone: 'accent', bold: true, inverse: true }, span('  '), span(state.title || 'New session', 'text', true)), row(span(place, 'muted')), width)
}

/** Narrowest terminal whose header names the working directory beside the preset. */
const HEADER_FOLDER_MIN_WIDTH = 60

/** Space between entries of the indicator and status rows. */
const GAP = '   '

/** Most cells of the task meter in the indicator row; a longer checklist is scaled to it. */
const TASK_METER = 8

/**
 * The row under the header. Left: the goal, its title bold behind an accent mark, then the plan and an imported
 * conversation, muted. Right: the task checklist as a meter in one colour, the done part filled in the accent tone over a
 * faint track, the count, and the task in progress by name. Each entry keeps its click action. When the row is too narrow
 * the task's name leaves first, then the goal's title is shortened.
 * @param state - the chat state.
 * @param width - cells available.
 * @returns the row, or undefined when there is nothing to show.
 */
export function indicatorRow(state: ChatState, width: number): Row | undefined {
  const cells = (parts: readonly Span[]): number => widthOf(textOfRow(row(...parts)))
  const indicators = sessionIndicators(state).filter(value => value.glyph !== '☐')
  const entries: Span[][] = indicators.map((value) => {
    const own = (part: Span): Span => value.action === undefined ? part : { ...part, action: value.action }
    const goal = value.glyph === '◎'
    return [own(span(`${value.glyph} `, goal ? 'accent' : 'brand')), own(span(value.label, goal ? 'text' : 'muted', goal)),
      ...value.detail === undefined ? [] : [own(span(`${GAP}${value.detail}`, value.tone))]]
  })
  const prechat = state.projections.prechat
  if (typeof prechat === 'number' && prechat > 0) entries.push([span('▤ ', 'brand'), span(`${prechat} imported ${prechat === 1 ? 'message' : 'messages'}`, 'muted')])
  const todos = Array.isArray(state.projections.todos) ? state.projections.todos.map(record) : []
  const opens = (part: Span): Span => ({ ...part, action: { kind: 'open-tasks' } })
  let tasks: Span[] = [], current: Span[] = []
  if (todos.length > 0) {
    const done = todos.filter(task => task.status === 'completed').length
    const size = Math.min(TASK_METER, todos.length), filled = Math.min(size, Math.round(done / todos.length * size))
    tasks = [opens(span('tasks ', 'comment')), opens(span('▰'.repeat(filled), 'accent')), opens(span('▱'.repeat(size - filled), 'comment')), opens(span(` ${done}/${todos.length}`, 'muted'))]
    const active = todos.find(task => task.status === 'in_progress')?.content
    const name = typeof active === 'string' ? safeText(active).split('\n').map(line => line.trim()).find(line => line !== '') : undefined
    if (name !== undefined) current = [opens(span(' · ', 'comment')), opens(span(name, 'text'))]
  }
  if (entries.length === 0 && tasks.length === 0) return undefined
  const leftCells = (): number => entries.reduce((sum, parts) => sum + cells(parts), 0) + GAP.length * Math.max(0, entries.length - 1)
  const room = (): number => width - leftCells() - (entries.length > 0 && tasks.length > 0 ? GAP.length : 0) - cells(tasks)
  // The name of the task in progress takes what is left, and leaves when less than a few cells are.
  if (cells(current) > room()) current = room() >= 12 ? fitRow(row(...current), room()).spans.map(opens) : []
  const [glyph, title, ...rest] = entries[0] ?? []
  if (room() < 0 && indicators[0]?.glyph === '◎' && glyph !== undefined && title !== undefined) {
    // Shorten the goal title, never the shorter plan and task entries after it.
    const shortened = fitRow(row(title), Math.max(8, cells([title]) + room())).spans
    entries[0] = [glyph, ...shortened.map(part => title.action === undefined ? part : { ...part, action: title.action }), ...rest]
  }
  const left = entries.flatMap((parts, index) => index === 0 ? parts : [span(GAP), ...parts])
  const right = [...tasks, ...current]
  const gap = right.length === 0 ? 0 : Math.max(left.length === 0 ? 0 : GAP.length, width - cells(left) - cells(right))
  return fitRow(row(...left, ...gap === 0 ? [] : [span(' '.repeat(gap))], ...right), width)
}

/**
 * One status-line entry; while the line is too wide, entries leave in ascending `keep` order. `join` replaces the separator
 * before the entry, binding it to the entry it follows on the same side.
 */
/** A throughput figure: one decimal below 100 tokens per second, whole numbers above. */
const rate = (value: number): string => value < 100 ? value.toFixed(1) : String(Math.round(value))

interface StatusEntry { spans: Span[]; keep: number; side: 'left' | 'right'; join?: Span }

/**
 * The status line under the composer. Left: the activity with its status glyph (a running Laya pass shows only its phase
 * label, in the accent tone), the model and effort, the permission preset
 * when it is not the default, background jobs, the work timer while a turn runs, and prefill and decode speed over the latest
 * {@link SPEED_SAMPLES} model responses, all muted. Right: the context meter bar,
 * usage percentage and token counts, and the `? keys` control. On narrow terminals the separators tighten, then entries leave
 * in this order: the keys control, the model, the speeds, jobs, the timer, the meter bar, the token counts, the percentage and the
 * preset.
 * @param state - chat state supplying status, model selection, permissions and projections.
 * @param width - cells available.
 * @param tick - spinner frame counter.
 * @param now - current time in milliseconds, for the work timer.
 * @param keys - offer the `? keys` control; panels and pickers carry their own keys instead.
 * @returns the status row.
 */
export function statusRow(state: ChatState, width: number, tick: number, now: number, keys = true): Row {
  const working = state.status === 'running' || state.busy !== undefined || state.transcript.compacting || state.transcript.layaPruning === true || (state.reviewingApprovals ?? 0) > 0
  const attention = state.pending.length > 0
  const tone = attention ? 'warning' : working ? 'accent' : 'footer'
  const label = activity(state)
  const entries: StatusEntry[] = [{ side: 'left', keep: Infinity, spans: state.transcript.layaPruning === true
    ? [span(label, 'accent', true)]
    : [span(`${working ? SPINNER[tick % SPINNER.length] : attention ? '!' : '●'} `, tone, true), span(label, 'text', attention)] }]
  const effort = state.selection.reasoningEffort
  entries.push({ side: 'left', keep: 20, spans: [span(`${state.selection.provider}/${state.selection.model}${effort === undefined ? '' : ` ${effort}`}`, 'muted')] })
  const permission = record(state.projections.permissions).currentValue
  if (typeof permission === 'string' && permission !== state.defaultPermission) {
    // Full access is the one preset that keeps a warning colour.
    entries.push({ side: 'left', keep: 95, spans: [{ ...span(permission, permission === 'danger-full-access' ? 'warning' : 'muted'), action: { kind: 'open-permissions' } }] })
  }
  // Only running jobs are counted; settled records stay listed in the jobs and tasks panels.
  const live = state.jobs.filter(liveJob).length
  if (live > 0) entries.push({ side: 'left', keep: 30, spans: [{ ...span(`${live} job${live === 1 ? '' : 's'}`, 'muted'), action: { kind: 'open-jobs' } }] })
  const elapsed = workElapsed(state, now)
  if (elapsed !== undefined) entries.push({ side: 'left', keep: 40, spans: [span(duration(elapsed), 'muted')] })
  const speed = recentSpeed(state.transcript)
  const rates = [speed.prefill === undefined ? '' : `prefill ${rate(speed.prefill)}`, speed.decode === undefined ? '' : `decode ${rate(speed.decode)}`].filter(Boolean)
  if (rates.length > 0) entries.push({ side: 'left', keep: 25, spans: [span(`${rates.join(' · ')} tok/s`, 'muted')] })
  const pressure = contextReading(state.projections)
  const context = pressure.ratio !== undefined && pressure.ratio >= 0.8 ? 'warning' : 'footer'
  if (pressure.ratio === undefined) entries.push({ side: 'right', keep: 90, spans: [span(pressure.label, context)] })
  else {
    const filled = Math.min(8, Math.floor(pressure.ratio * 8))
    entries.push({ side: 'right', keep: 50, spans: [span(`${'▰'.repeat(filled)}${'▱'.repeat(8 - filled)}`, context)] },
      { side: 'right', keep: 90, join: span(' ', context), spans: [span(`ctx ${Math.round(pressure.ratio * 100)}%`, context)] })
    if (pressure.used !== undefined && pressure.maximum !== undefined) {
      entries.push({ side: 'right', keep: 55, join: span(' · ', context), spans: [span(`${tokens(pressure.used)}/${tokens(pressure.maximum)}`, context)] })
    }
  }
  if (keys) entries.push({ side: 'right', keep: 10, spans: [{ ...span('? keys', 'comment'), action: { kind: 'toggle-keys' } }] })
  const join = (side: StatusEntry['side'], separator: Span): Span[] => entries.filter(entry => entry.side === side)
    .flatMap((entry, index) => index === 0 ? entry.spans : [entry.join ?? separator, ...entry.spans])
  for (;;) {
    for (const [left, right] of [[span('  ·  ', 'muted'), span(GAP)], [span(' · ', 'muted'), span(' ')]] as const) {
      const start = row(...join('left', left)), end = row(...join('right', right))
      const used = widthOf(textOfRow(start)) + widthOf(textOfRow(end))
      if (used + 2 <= width) return row(...start.spans, span(' '.repeat(width - used)), ...end.spans)
    }
    const drop = entries.reduce<StatusEntry | undefined>((lowest, entry) => entry.keep < (lowest?.keep ?? Infinity) ? entry : lowest,
      undefined)
    if (drop === undefined) return fitRow(row(...join('left', span(' · ', 'muted'))), width)
    entries.splice(entries.indexOf(drop), 1)
  }
}

/**
 * The draft as the composer wraps it, and the window it shows while following
 * the cursor. A scroll offset is clamped against these, so a reader can move
 * away from the cursor without the draft scrolling out of reach.
 * @param editor - the current draft.
 * @param width - composer width in cells.
 * @param maxLines - visible composer lines.
 * @returns the wrapped line count and the offset the cursor would show.
 */
export function composerView(editor: EditorState, width: number, maxLines: number): { lines: number; offset: number } {
  const lines = wrapEditor(editor.text, Math.max(1, width - 3))
  const visible = windowAround(lines, activeLine(lines, editor.cursor), Math.max(1, maxLines))
  return { lines: lines.length, offset: visible.offset }
}

function composerTop(lines: readonly VisualLine[], editor: EditorState, size: number, offset: number | undefined): number {
  return offset === undefined
    ? windowAround(lines, activeLine(lines, editor.cursor), size).offset
    : Math.max(0, Math.min(Math.max(0, lines.length - size), offset))
}

const composerGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The draft offset under one composer cell, for placing the cursor or a selection end by mouse.
 * @param editor - the draft as painted.
 * @param width - composer width in cells.
 * @param maxLines - visible composer lines.
 * @param offset - the reader's scroll offset, as passed to {@link composerRows}.
 * @param row - composer row, where 0 is the rule above the text.
 * @param column - frame column.
 * @returns the offset before the grapheme in that cell; rows above or below the text clamp to its ends.
 */
export function composerOffsetAt(editor: EditorState, width: number, maxLines: number, offset: number | undefined,
  row: number, column: number): number {
  const lines = wrapEditor(editor.text, Math.max(1, width - 3)), size = Math.max(1, maxLines)
  const top = composerTop(lines, editor, size, offset)
  if (row < 1) return lines[top]?.start ?? 0
  const index = top + row - 1
  if (index >= Math.min(lines.length, top + size)) return lines[Math.min(lines.length, top + size) - 1]?.end ?? editor.text.length
  const line = lines[index]
  if (line === undefined) return editor.text.length
  let used = 2
  for (const part of composerGraphemes.segment(line.text)) {
    const size = cellWidth(part.segment)
    if (column < used + size) return line.start + part.index
    used += size
  }
  return line.end
}

function draftLine(line: VisualLine, cursor: number | undefined, range: { start: number; end: number } | undefined): Span[] {
  const output: Span[] = []
  const push = (text: string, inverse: boolean): void => {
    const last = output.at(-1)
    if (last !== undefined && (last.inverse === true) === inverse) last.text += text
    else output.push(inverse ? { text, inverse: true } : span(text))
  }
  for (const part of composerGraphemes.segment(line.text)) {
    const at = line.start + part.index
    const selected = range !== undefined && at >= range.start && at < range.end
    push(safeText(part.segment), selected !== (at === cursor))
  }
  if (cursor === line.end) push(' ', true)
  return output.length === 0 ? [span('')] : output
}

/**
 * The rule above the draft. Staged files sit on it as chips, each with a `×` that removes it; chips that do not fit are
 * counted, and the first one is shortened rather than left out. The draft position label follows the chips.
 */
function composerRule(width: number, label: string, files: readonly { readonly name: string }[]): Row {
  if (files.length === 0) return rule(width, label)
  const cells = (parts: readonly Span[]): number => widthOf(textOfRow(row(...parts)))
  const tail = label === '' ? '' : `── ${label} `
  const parts: Span[] = []
  let shown = 0
  for (const [index, file] of files.entries()) {
    const rest = files.length - index - 1
    const room = width - cells(parts) - widthOf(tail) - (rest > 0 ? widthOf(`── +${rest} more `) : 0) - 2
    const name = `⊕ ${safeText(file.name)}`
    if (widthOf(name) + 6 > room && (index > 0 || room < 12)) break
    parts.push(span('── ', 'muted'), ...fitRow(row(span(name, 'text')), room - 6).spans,
      { ...span(' × ', 'comment'), action: { kind: 'detach', index, name: file.name } })
    shown += 1
  }
  if (shown < files.length) parts.push(span(`── +${files.length - shown} more `, 'muted'))
  if (tail !== '') parts.push(span(tail, 'muted'))
  return fitRow(row(...parts, span('─'.repeat(Math.max(0, width - cells(parts))), 'muted')), width)
}

/**
 * Visible composer lines keep UTF-16 cursor offsets; only display is escaped.
 * @param editor - the draft.
 * @param width - composer width in cells.
 * @param maxLines - visible draft lines, at least 1.
 * @param placeholder - muted text shown for an empty draft.
 * @param disabled - paints no cursor or selection.
 * @param offset - the first visible line; omitted, the window follows the cursor.
 * @param files - files staged for the next prompt, shown as removable chips on the rule.
 * @returns a rule row followed by the visible draft rows.
 */
export function composerRows(editor: EditorState, width: number, maxLines: number, placeholder: string,
  disabled = false, offset?: number, files: readonly { readonly name: string }[] = []): Row[] {
  const available = Math.max(1, width - 3)
  const lines = wrapEditor(editor.text, available), active = activeLine(lines, editor.cursor)
  const size = Math.max(1, maxLines)
  const first = composerTop(lines, editor, size, offset)
  const visible = { items: lines.slice(first, first + size), offset: first }
  const range = selectionOf(editor)
  const output = [composerRule(width, lines.length > 1 ? `prompt · ${active + 1}/${lines.length}` : '', files)]
  if (editor.text === '') {
    output.push(fitRow(row(span('› ', 'muted'), ...(disabled ? [] : [{ text: ' ', inverse: true }]), span(placeholder, 'muted')), width))
    return output
  }
  for (let index = 0; index < visible.items.length; index++) {
    const line = visible.items[index]
    if (line === undefined) continue
    const here = active === visible.offset + index
    const prefix = span(visible.offset + index === 0 ? '› ' : '  ', 'muted')
    const parts = disabled ? [span(safeText(line.text))] : draftLine(line, here ? editor.cursor : undefined, range)
    const rendered = wrapRow(row(prefix, ...parts), width)
    output.push(rendered[0] ?? row(''))
  }
  return output
}

/** Most rows the command palette takes, tabs and footer included. */
export const PALETTE_MAX_ROWS = 12
/** Most cells the palette name column grows to for argument hints; longer hints are cut. */
const NAME_CELLS = 24
/** Width of the kind column beside ranked matches. */
const KIND_CELLS = 10

/**
 * The command palette under the composer: a tab row with per-tab counts, the active tab filled; the commands, under
 * headings that run into a faint rule for an empty query, the chosen one on the selection background across the row; and a
 * footer with the selection position on the left and the keys on the right. The name column is sized from every listed
 * command, so it stays put while the selection scrolls; an argument hint follows the name, muted. A typed query adds a kind
 * column from 60 cells.
 * @param view - the palette layout from `paletteView`.
 * @param index - the selected entry, an index into `view.entries`.
 * @param tab - the active tab.
 * @param width - cells available.
 * @param height - rows available, at most {@link PALETTE_MAX_ROWS} used; below 2 yields nothing.
 * @returns the tab row, the visible commands, each clickable to complete, and the footer.
 */
export function paletteRows(view: PaletteView, index: number, tab: PaletteTab, width: number, height: number): Row[] {
  if (height < 2) return []
  const tabs = fitRow(row(span('  '), ...PALETTE_TABS.flatMap(({ id, label }, at) => {
    const action = { kind: 'palette-tab' as const, tab: id }
    return [...at === 0 ? [] : [span(width < 50 ? '  ' : GAP)], ...id === tab
      ? [{ text: ` ${label} `, tone: 'accent' as const, bold: true, inverse: true, action }, { ...span(` ${view.counts[id]}`, 'accent'), action }]
      : [{ ...span(`${label} ${view.counts[id]}`, 'muted'), action }]]
  })), width)
  const count = view.entries.length
  const keys = count === 0 ? 'No matching command · ←→ category · Esc dismiss' : '↑↓ choose · ←→ category · Tab complete · Enter run · Esc dismiss'
  const position = count === 0 ? '' : `  ${index + 1} of ${count}`
  const footer = widthOf(position) + widthOf(keys) + 3 <= width
    ? row(span(position, 'comment'), span(' '.repeat(width - widthOf(position) - widthOf(keys) - 1)), span(keys, 'muted'))
    : fitRow(row(span(`${position.trimStart()}${position === '' ? '' : ' · '}${keys}`, 'muted')), width)
  const selected = Math.max(0, view.rows.findIndex(value => value.kind === 'entry' && value.index === index))
  const visible = windowAround(view.rows, selected, Math.max(1, Math.min(PALETTE_MAX_ROWS, height) - 2))
  const kinds = !view.grouped && width >= 60
  const named = (entry: CommandEntry): number => widthOf(`/${entry.name}`)
  const full = (entry: CommandEntry): number => named(entry) + (entry.hint === undefined ? 0 : widthOf(entry.hint) + 1)
  const longestName = Math.max(0, ...view.entries.map(named)), hintRoom = Math.min(NAME_CELLS, Math.floor((width - 4) * 0.3))
  const nameWidth = Math.min(Math.max(0, ...view.entries.map(full)), Math.max(longestName, hintRoom))
  const list = Math.min(PALETTE_MAX_ROWS, height) >= 3 ? visible.items.map((value): Row => {
    if (value.kind === 'header') {
      // A group's heading runs into a faint rule to the edge, which separates it from the group before.
      const heading = fitRow(row(span(`  ${value.label}`, 'muted', true), ...value.detail === undefined ? [] : [span(`  ${value.detail}`, 'muted')]), Math.max(0, width - 2))
      return fitRow(row(...heading.spans, span(` ${'─'.repeat(Math.max(0, width - widthOf(textOfRow(heading)) - 2))}`, 'comment')), width)
    }
    const { entry } = value, chosen = value.index === index
    // The name is never cut; its argument hint takes what the column leaves.
    const room = nameWidth - named(entry) - 1
    const hint = entry.hint === undefined || room < 2 ? [] : [span(' '), ...fitRow(row(span(entry.hint, 'muted')), room).spans]
    const name = row(span(`/${entry.name}`, 'command', chosen), ...hint)
    const kind = kinds ? [span(padText(commandKind(entry), KIND_CELLS), 'muted')] : []
    const line = fitRow(row(span(chosen ? '❯ ' : '  ', 'accent', chosen), ...name.spans, span(' '.repeat(Math.max(0, nameWidth - widthOf(textOfRow(name))) + 2)),
      ...kind, span(entry.description, chosen ? 'text' : 'muted')), width)
    // The chosen command stands on the selection background across the whole row.
    const painted = chosen ? onBackground(line, width, 'select') : line
    return { ...painted, spans: painted.spans.map(part => ({ ...part, action: { kind: 'command-complete' as const, name: entry.name } })) }
  }) : []
  return [tabs, ...list, footer]
}

/** Most queued messages listed above the composer before a summary row. */
const NOTE_ITEMS = 3

/** Cells of the column that says which turn a queued message is for. */
const QUEUE_TAG_CELLS = 11

/**
 * What waits above the composer's top rule: queued messages, numbered, each with the turn it is for and a `×` at the row's
 * end that removes it, then the current error (with the command's correct form) and the current transient hint. Staged
 * files are on the composer's rule instead.
 * @param state - the chat state.
 * @param width - cells available.
 * @returns the rows, empty when nothing waits.
 */
export function composerNotes(state: ChatState, width: number): Row[] {
  const output: Row[] = []
  const removable = (parts: readonly Span[], action: UiAction): Row => {
    const text = fitRow(row(...parts), Math.max(0, width - 5))
    return fitRow(row(...text.spans, span(' '.repeat(Math.max(1, width - 3 - widthOf(textOfRow(text))))), { ...span('×', 'comment'), action }), width)
  }
  const queue = state.queue.filter(item => item.placement !== 'context')
  queue.slice(0, NOTE_ITEMS).forEach((item, index) => {
    const summary = safeText(contentSummary(item.message.content)).replace(/\s+/gu, ' ')
    output.push(removable([span(`  ${index + 1} `, 'comment'), span(padText(item.placement === 'steering' ? 'this turn' : 'next turn', QUEUE_TAG_CELLS), 'muted'), span(summary, 'text')],
      { kind: 'queue-remove', index }))
  })
  if (queue.length > NOTE_ITEMS) output.push(fitRow(row(span(`    +${queue.length - NOTE_ITEMS} more queued · /tasks lists them`, 'muted')), width))
  const error = state.composerError
  if (error !== undefined) {
    output.push(...indentRows(wrapProse(row(span(error.message, 'error'), ...error.usage === undefined ? [] : [span(` · usage: ${error.usage}`, 'muted')]),
      Math.max(1, width - 4)), '    ', width, span('  × ', 'error')).slice(0, 3))
  }
  if (state.hint !== undefined) output.push(...indentRows(wrapProse(row(span(state.hint, 'muted')), Math.max(1, width - 2)), '  ', width).slice(0, 2))
  return output
}

/** Keyboard shortcuts in the keys box, as the composer and conversation handle them. */
const KEYS: readonly (readonly [string, string])[] = [
  ['Enter', 'send'], ['Alt+Enter', 'new line'], ['/', 'commands'], ['Esc', 'stop turn'], ['Tab', 'queue while running'],
  ['Ctrl+G', 'editor'], ['PgUp/PgDn', 'scroll'], ['End', 'bottom'], ['Ctrl+F', 'find'], ['Ctrl+R', 'history'], ['Ctrl+C', 'twice to exit'],
]

/**
 * The Keys box `?` opens above the composer: a closed box listing the main shortcuts in as many columns as fit, then how to expand
 * conversation details. `/help` holds the complete reference.
 * @param width - cells available; the box sits behind the transcript margin.
 * @param height - most rows the box may take; a box that cannot show its borders and one line is omitted.
 * @returns the box rows.
 */
export function keysRows(width: number, height: number): Row[] {
  const boxWidth = width - 2, inner = boxWidth - 4
  if (height < 3 || boxWidth < BOX_MIN_WIDTH) return []
  const entry = ([key, text]: readonly [string, string]): Span[] => [span(key, 'text', true), span(` ${text}`, 'muted')]
  const cells = KEYS.map(value => widthOf(`${value[0]} ${value[1]}`))
  let columns = 1
  for (let count = 4; count > 1; count--) {
    const widths = Array.from({ length: count }, (_, column) => Math.max(0, ...cells.filter((_, at) => at % count === column)))
    if (widths.reduce((sum, value) => sum + value, 0) + GAP.length * (count - 1) <= inner) { columns = count; break }
  }
  const widths = Array.from({ length: columns }, (_, column) => Math.max(0, ...cells.filter((_, at) => at % columns === column)))
  const body: Row[] = []
  for (let at = 0; at < KEYS.length; at += columns) {
    body.push(row(...KEYS.slice(at, at + columns).flatMap((value, column) => [...column === 0 ? [] : [span(GAP)],
      ...entry(value), span(' '.repeat(column === columns - 1 ? 0 : Math.max(0, (widths[column] ?? 0) - (cells[at + column] ?? 0))))])))
  }
  body.push(...wrapProse(row(...entry(['click', 'a tool or thinking line to expand it'])), Math.max(1, inner)))
  const lines = body.slice(0, height - 2)
  return indentRows([boxTop([span('Keys', 'muted')], boxWidth, 'muted'), ...lines.map(value => boxLine(value, boxWidth, 'muted')), boxBottom(boxWidth, 'muted')], '  ', width)
}

/**
 * Picker rows matching a query, best match first.
 * @param picker - the open picker, if any.
 * @param query - the search text; label matches outrank id and detail matches.
 * @returns the matching rows; empty without a picker.
 */
export function filterPicker(picker: Picker | undefined, query: string): PickerRow[] {
  return (picker?.rows ?? []).map(entry => ({ entry, score: Math.max(matchScore(entry.label, query), matchScore(`${entry.id} ${entry.detail}`, query) / 2) }))
    .filter(value => value.score >= 0).sort((a, b) => b.score - a.score).map(value => value.entry)
}

/**
 * A full picker screen: title rule, search line, entries and controls.
 * @param picker - the open picker.
 * @param rows - the filtered rows.
 * @param search - the search draft.
 * @param index - the selected row.
 * @param width - cells available.
 * @param height - rows available; entries take two rows each when space allows.
 * @param status - an optional muted line under the search.
 * @returns exactly `height` rows or fewer.
 */
export function pickerLayout(picker: Picker, rows: readonly PickerRow[], search: EditorState,
  index: number, width: number, height: number, status?: string): Row[] {
  const output = [panelTitle(width, picker.title), ...composerRows(search, width, 1, 'Type to search…').slice(1)]
  if (status !== undefined) output.push(fitRow(row(span(status, 'muted')), width))
  const footer = picker.kind === 'sessions' ? 2 : 1
  const itemHeight = width >= 55 && height >= 10 ? 2 : 1
  const visible = windowAround(rows, index, Math.max(1, Math.floor((height - output.length - footer) / itemHeight)))
  for (let position = 0; position < visible.items.length; position++) {
    const entry = visible.items[position]
    if (entry === undefined) continue
    const selected = position + visible.offset === index
    const action = { kind: 'picker-select' as const, id: entry.id }
    const value = fitRow(row(span(`${selected ? '❯' : ' '} ${entry.current ? '● ' : '  '}`, 'accent'), span(entry.label, 'text', selected), span(entry.current ? '  current' : '', 'muted')), width)
    // The row in focus stands on the selection background, its detail row included.
    const painted = (line: Row): Row => selected ? onBackground(line, width, 'select') : line
    output.push({ ...painted(value), spans: painted(value).spans.map(part => ({ ...part, action })) })
    if (itemHeight === 2) {
      const detail = painted(fitRow(row(span(`    ${entry.detail}`, 'muted')), width))
      output.push({ ...detail, spans: detail.spans.map(part => ({ ...part, action })) })
    }
  }
  if (rows.length === 0) output.push(fitRow(row(span('No matches. Change the search or press Esc.', 'muted')), width))
  while (output.length < height - footer) output.push(row(''))
  const controls = [fitRow(row(...(rows[index] === undefined ? [] : [{ ...span(picker.kind === 'sessions' ? '[ Resume ] ' : picker.kind === 'skills' ? '[ Use ] ' : '[ Choose ] ', 'accent', true), action: { kind: 'picker-confirm' as const, id: rows[index].id } }]), span(`${rows.length === 0 ? 0 : index + 1}/${rows.length} · ↑↓ · ${picker.kind === 'skills' ? 'Enter use' : 'Enter choose'} · Esc close`, 'footer')), width)]
  if (picker.kind === 'sessions') controls.push(fitRow(row(span(`Tab · ${picker.all ? 'all directories' : 'current directory'} — toggle scope`, 'footer')), width))
  return [...output.slice(0, Math.max(0, height - footer)), ...controls].slice(0, height)
}

/**
 * A panel's title rule: the title in bold between muted rule segments.
 * @param width - cells available.
 * @param title - the panel title, in sentence case.
 * @returns the title row.
 */
export function panelTitle(width: number, title: string): Row {
  return fitRow(row(span('── ', 'muted'), span(title, 'text', true), span(` ${'─'.repeat(Math.max(0, width - widthOf(title) - 4))}`, 'muted')), width)
}

/**
 * Scrollable details plus bounded controls. The controls follow the details after one blank row; only when the details do
 * not fit do they scroll, with a position row, above controls pinned to the bottom. Nothing in details is cut.
 * @param title - the panel title rule.
 * @param details - the scrollable rows.
 * @param controls - rows under the details.
 * @param width - cells available.
 * @param height - rows available.
 * @param requested - the desired scroll offset, clamped to the valid range.
 * @returns the painted rows, the details page size, the maximum offset and the clamped offset.
 */
export function panelLayout(title: string, details: readonly Row[], controls: readonly Row[], width: number,
  height: number, requested: number): { rows: Row[]; page: number; maximum: number; offset: number } {
  const page = Math.max(1, height - controls.length - 2)
  if (details.length + controls.length + 2 <= height) {
    const rows = [panelTitle(width, title), ...details, row(''), ...controls]
    while (rows.length < height) rows.push(row(''))
    return { rows, page, maximum: 0, offset: 0 }
  }
  const maximum = Math.max(0, details.length - page)
  const offset = Math.max(0, Math.min(maximum, requested)), lines = details.slice(offset, offset + page)
  const rows = [panelTitle(width, title), ...lines]
  while (rows.length < page + 1) rows.push(row(''))
  rows.push(fitRow(row(span(`${offset + 1}–${Math.min(details.length, offset + page)}/${details.length} · PgUp/PgDn scroll`, 'footer')), width), ...controls)
  return { rows, page, maximum, offset }
}

/** One key a card or panel lists, with what it does; a third entry makes both words a click target. */
type KeyHint = readonly [key: string, does: string, click?: UiAction]

/** Key hints in greys: each key in the text tone before its action, muted, with faint separators. */
function keyHints(hints: readonly KeyHint[]): Span[] {
  return hints.flatMap(([key, does, click], index) => {
    const own = (part: Span): Span => click === undefined ? part : { ...part, action: click }
    return [...index === 0 ? [] : [span(' · ', 'comment')], own(span(key, 'text')), own(span(` ${does}`, 'muted'))]
  })
}

/** Cells a card's borders and inner padding take from its width. */
const CARD_INSET = 6

/**
 * Cells a card leaves for its content.
 * @param width - the card's total width.
 * @returns the content width, at least 1.
 */
export function cardInner(width: number): number { return Math.max(1, width - CARD_INSET) }

/**
 * A closed card in one tone, which takes the composer's place while the session waits for a choice: the title and an
 * optional tag in its top border, the details, one blank row, then the controls. The card is as tall as its content; when
 * that exceeds `height` only the details scroll, above a position row and the pinned controls, so nothing in them is cut.
 * @param title - the title in the top border.
 * @param tag - muted text at the right of the top border; empty shows none.
 * @param details - the scrollable rows, laid out for {@link cardInner} cells.
 * @param controls - rows pinned under the details, laid out for {@link cardInner} cells.
 * @param tone - the tone of the border and the title.
 * @param width - cells available.
 * @param height - most rows the card may take.
 * @param requested - the desired scroll offset, clamped to the valid range.
 * @returns the card rows, the details page size, the maximum offset and the clamped offset.
 */
export function cardLayout(title: string, tag: string, details: readonly Row[], controls: readonly Row[], tone: Tone,
  width: number, height: number, requested: number): { rows: Row[]; page: number; maximum: number; offset: number } {
  const line = (value: Row): Row => boxLine({ ...value, spans: [span(' '), ...value.spans] }, width, tone)
  const top = boxTop([span(title, tone, true)], width, tone, tag === '' ? [] : [span(tag, 'muted')])
  const lead = details.length > 0 ? [row('')] : [], between = details.length > 0 && controls.length > 0 ? [row('')] : []
  const room = Math.max(1, height - 2)
  if (lead.length + details.length + between.length + controls.length <= room) {
    const rows = [top, ...[...lead, ...details, ...between, ...controls].map(line), boxBottom(width, tone)]
    return { rows, page: Math.max(1, details.length), maximum: 0, offset: 0 }
  }
  const page = Math.max(1, room - controls.length - 1)
  const maximum = Math.max(0, details.length - page), offset = Math.max(0, Math.min(maximum, requested))
  const position = row(span(`${offset + 1}–${Math.min(details.length, offset + page)} of ${details.length} · PgUp/PgDn scroll`, 'comment'))
  const shown = [...details.slice(offset, offset + page), position, ...controls]
  return { rows: [top, ...shown.map(line), boxBottom(width, tone)], page, maximum, offset }
}

/** The command and the number of fields of an approval whose arguments are a JSON object; both absent otherwise. */
function approvalRequest(pending: PendingApproval): { command?: string; fields?: number } {
  let args: unknown
  try { args = JSON.parse(pending.detail ?? '') } catch { /* SyntaxError: not every tool describes its arguments as JSON. */ return {} }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {}
  return { fields: Object.keys(args).length, ...'command' in args && typeof args.command === 'string' ? { command: args.command } : {} }
}

/**
 * Whether an approval's complete arguments show before the reader opens or folds them.
 * @param pending - the pending approval.
 * @returns true without a command, whose arguments are then the whole request.
 */
export function approvalArgumentsOpen(pending: PendingApproval): boolean { return approvalRequest(pending).command === undefined }

/**
 * What an approval asks for: the command on a neutral band when the arguments are JSON with a `command` string, the
 * directory and the owner, the reason, then the complete arguments under a fold. The command is never cut. The arguments
 * are folded only beside a command; without one they are the request, and open.
 * @param pending - the pending approval.
 * @param width - cells available.
 * @param open - whether the complete arguments show; omitted, they show when there is no command.
 * @returns the wrapped detail rows.
 */
export function approvalDetails(pending: PendingApproval, width: number, open?: boolean): Row[] {
  const { command, fields } = approvalRequest(pending)
  const shown = open ?? command === undefined
  const band = command === undefined ? [] : wrapRow(row(span(command, 'text', true)), Math.max(1, width - 4))
    .map((line, index) => onBackground(row(span(index === 0 ? ' $ ' : '   ', 'muted'), ...line.spans), width, 'plate'))
  const place = row(...pending.cwd === undefined ? [] : [span('in ', 'comment'), span(pending.cwd, 'muted'), span(' · ', 'comment')],
    span('owner ', 'comment'), span(pending.owner, 'muted'))
  const copy = command === undefined ? [] : [{ ...span('Copy', 'accent'), action: { kind: 'copy-text' as const, text: command, label: 'requested command' } }]
  const placed = copy.length > 0 && widthOf(textOfRow(place)) + 6 <= width
    ? [row(...place.spans, span(' '.repeat(width - widthOf(textOfRow(place)) - 4)), ...copy)] : [...wrapRow(place, width), ...copy.length > 0 ? [row(...copy)] : []]
  const fold = row(span(shown ? '▾ ' : '▸ ', 'muted'), span('Arguments', 'muted'),
    ...fields === undefined ? [] : [span(` · ${fields} ${fields === 1 ? 'field' : 'fields'}`, 'comment')])
  return [...band, ...placed, row(''),
    ...wrapRow(row(span(pending.reason ?? 'The tool requests authorization for this invocation.', 'text')), width),
    { ...fold, spans: fold.spans.map(part => ({ ...part, action: { kind: 'approval-arguments' as const } })) },
    ...shown ? indentRows(wrapRow(row(span(pending.detail ?? '(No arguments supplied by the tool)', 'muted')), Math.max(1, width - 2)), '  ', width) : []]
}

/**
 * The goal panel's controls: edit the objective in the composer, pause or resume, clear.
 * @param phase - the goal's phase as the reader sees it, from {@link goalPhase}.
 * @param width - cells available.
 * @returns the control rows; empty without a goal.
 */
export function goalControls(phase: string | undefined, width: number): Row[] {
  if (phase === undefined) return []
  const button = (label: string, action: UiAction): Span => ({ ...span(`[ ${label} ] `, 'accent', true), action })
  const toggle = phase === 'active' ? button('Pause', { kind: 'goal-command', command: '/goal pause' })
    : phase === 'complete' ? undefined : button('Resume', { kind: 'goal-command', command: '/goal resume' })
  return [fitRow(row(button('Edit', { kind: 'goal-edit' }), ...toggle === undefined ? [] : [toggle], button('Clear', { kind: 'goal-command', command: '/goal clear' }),
    span('Alt+G toggles · Esc close', 'footer')), width)]
}

/**
 * The approval card's controls: Allow once and Reject, the current one filled in the warning tone, and the keys in greys,
 * whose `Enter confirm` is also the mouse confirm target. One row when it fits, without the arrow hint when only that
 * fits, otherwise the choice above the keys.
 * @param width - cells available.
 * @param allowed - whether Allow once is the current choice.
 * @param count - pending approvals; above 1 the keys row shows it.
 * @returns the control rows.
 */
export function approvalControls(width: number, allowed: boolean, count: number): Row[] {
  const choice = (label: string, value: boolean): Span => {
    const action = { kind: 'approval-select' as const, allowed: value }
    return value === allowed ? { text: `  ${label}  `, tone: 'warning', bold: true, inverse: true, action } : { ...span(`  ${label}  `, 'text'), action }
  }
  const choices = row(choice('Allow once', true), span('  '), choice('Reject', false))
  const hints: KeyHint[] = [['←→', 'choose'], ['Enter', 'confirm', { kind: 'approval-confirm' }], ['y', 'select allow'], ['n/Esc', 'reject'],
    ['a', 'arguments', { kind: 'approval-arguments' }]]
  const waiting = count > 1 ? [span(` · ${count} pending`, 'comment')] : []
  const keys = row(...keyHints(hints), ...waiting)
  for (const shown of [hints, hints.slice(1)]) {
    const together = row(...choices.spans, span('    '), ...keyHints(shown), ...waiting)
    if (widthOf(textOfRow(together)) <= width) return [together]
  }
  return [fitRow(choices, width), fitRow(keys, width)]
}

/**
 * The current question and its Markdown detail, with code-block Copy buttons wired.
 * @param pending - the pending question set.
 * @param draft - the reader's progress.
 * @param width - cells available.
 * @returns the detail rows; empty when the draft index has no question.
 */
export function questionDetails(pending: PendingQuestion, draft: QuestionDraft, width: number): Row[] {
  const question = pending.questions[draft.index]
  if (question === undefined) return []
  const blocks = codeBlocks(question.detail ?? ''); let index = 0
  const detail = markdownRows(question.detail ?? '', width).map((value) => {
    if (value.codeHeader !== true) return value
    const block = blocks[index++]
    return { ...value, spans: value.spans.map(part => part.text === COPY_LABEL && block !== undefined ? { ...part, action: { kind: 'copy-text' as const, text: block.text, label: 'plan code' } } : part) }
  })
  return [...wrapRow(row(span(question.question, 'text', true)), width), row(''), ...detail]
}

/** Most cells of the label column in a question's options and in a short picker; longer labels are cut. */
const OPTION_LABEL_CELLS = 28

/**
 * The current question's options, the custom answer and the keys. Each option has its number, which picks it, its label
 * and its description; the one in focus stands on the selection background across the row. The custom answer is a hint
 * row until Tab or typed text opens its composer. `Enter confirm` in the keys is also the mouse confirm target.
 * @param pending - the pending question set.
 * @param draft - the reader's progress.
 * @param width - cells available.
 * @param height - screen height, which bounds the visible options and composer lines.
 * @returns the control rows.
 */
export function questionControls(pending: PendingQuestion, draft: QuestionDraft, width: number, height: number): Row[] {
  const question = pending.questions[draft.index], options = question?.options ?? []
  const visible = windowAround(options, draft.optionIndex, Math.max(1, Math.min(5, Math.floor(height / 4))))
  const labelCells = Math.min(OPTION_LABEL_CELLS, Math.max(0, ...options.map(option => widthOf(safeText(option.label)))))
  const output: Row[] = []
  for (let position = 0; position < visible.items.length; position++) {
    const option = visible.items[position]
    if (option === undefined) continue
    const at = position + visible.offset
    const focused = !draft.customMode && at === draft.optionIndex
    // Enter answers a single-select question with the option in focus when none is picked, so that one shows as picked.
    const picked = draft.selected.includes(option.label) || (focused && question?.multiSelect !== true && draft.selected.length === 0)
    const label = fitRow(row(span(safeText(option.label), 'text', focused)), labelCells)
    const line = fitRow(row(span(' '), span(picked ? '●' : '○', picked || focused ? 'accent' : 'comment'), span(` ${at + 1}  `, 'comment'),
      ...label.spans, span(' '.repeat(labelCells - widthOf(textOfRow(label)) + 2)),
      span(safeText(option.description ?? '').replace(/\s+/gu, ' '), 'muted')), width)
    const painted = focused ? onBackground(line, width, 'select') : line
    output.push({ ...painted, spans: painted.spans.map(part => ({ ...part, action: { kind: 'question-option' as const, index: at } })) })
  }
  if (draft.customMode || draft.custom.text !== '') {
    output.push(...composerRows(draft.custom, width, Math.max(1, Math.min(3, Math.floor(height / 6))), 'Type your answer…', !draft.customMode).slice(1))
  } else output.push(fitRow(row(span(' ✎  ', 'comment'), span('Tab', 'text'), span('  Write your own answer', 'muted')), width))
  const keys: KeyHint[] = [...options.length === 0 ? [] : [['↑↓', 'choose'], [options.length === 1 ? '1' : `1–${Math.min(9, options.length)}`, 'pick'],
    ['Space', question?.multiSelect === true ? 'toggle' : 'select']] satisfies KeyHint[],
  ['Enter', 'confirm', { kind: 'question-confirm' }], ['Tab', draft.customMode ? 'options' : 'custom'], ['Esc', 'cancel']]
  output.push(row(''), fitRow(row(...keyHints(keys)), width))
  return output
}

/** Most rows a short picker lists in its card before it scrolls. */
const PICKER_CARD_ROWS = 8

/**
 * Whether a picker is short enough for a card in the composer's place; sessions and skills keep the whole screen.
 * @param picker - the open picker.
 * @returns whether {@link pickerCard} lays it out.
 */
export function shortPicker(picker: Picker): boolean { return picker.kind !== 'sessions' && picker.kind !== 'skills' }

/**
 * A short picker as a card in the composer's place: the filter once text is typed, then the rows, the current one marked
 * and the one in focus on the selection background, and the keys. `Enter select` is also the mouse confirm target.
 * @param picker - the open picker.
 * @param rows - its rows after filtering.
 * @param search - the filter as typed.
 * @param index - the row in focus.
 * @param width - cells available.
 * @param height - most rows the card may take.
 * @returns the card rows.
 */
export function pickerCard(picker: Picker, rows: readonly PickerRow[], search: EditorState, index: number, width: number,
  height: number): Row[] {
  const inner = cardInner(width), body: Row[] = []
  const filter = wrapEditor(search.text, Number.MAX_SAFE_INTEGER)[0]
  if (filter !== undefined && search.text !== '') body.push(fitRow(row(span('⌕ ', 'accent', true), ...draftLine(filter, search.cursor, undefined)), inner))
  const visible = windowAround(rows, index, Math.max(1, Math.min(PICKER_CARD_ROWS, height - body.length - 4)))
  const labelCells = Math.min(OPTION_LABEL_CELLS, Math.max(0, ...rows.map(entry => widthOf(safeText(entry.label)))))
  for (let position = 0; position < visible.items.length; position++) {
    const entry = visible.items[position]
    if (entry === undefined) continue
    const focused = position + visible.offset === index, end = entry.current === true ? 'current ' : ''
    const label = fitRow(row(span(safeText(entry.label), 'text', focused)), labelCells)
    const line = fitRow(row(span(focused ? '❯ ' : '  ', 'accent', true), span(entry.current === true ? '● ' : '  ', 'accent'), ...label.spans,
      span(' '.repeat(labelCells - widthOf(textOfRow(label)) + 2)), span(safeText(entry.detail).replace(/\s+/gu, ' '), 'muted')), Math.max(0, inner - widthOf(end) - 1))
    const whole = row(...line.spans, span(' '.repeat(inner - widthOf(textOfRow(line)) - widthOf(end))), span(end, 'comment'))
    const painted = focused ? onBackground(whole, inner, 'select') : whole
    body.push({ ...painted, spans: painted.spans.map(part => ({ ...part, action: { kind: 'picker-select' as const, id: entry.id } })) })
  }
  if (rows.length === 0) body.push(fitRow(row(span('No matches. Change the filter or press Esc.', 'muted')), inner))
  const chosen = rows[index]
  body.push(row(''), fitRow(row(...keyHints([['↑↓', 'choose'], chosen === undefined ? ['Enter', 'select'] : ['Enter', 'select', { kind: 'picker-confirm', id: chosen.id }],
    ['type', 'to filter'], ['Esc', 'close']])), inner))
  return cardLayout(picker.title, rows.length === 0 ? '' : `${index + 1} of ${rows.length}`, [], body, 'accent', width, height, 0).rows
}

/** Projection values arrive untyped; scalars print as themselves, structures as JSON, and absence as a dash. */
function shown(value: unknown, absent = '—'): string {
  if (value === undefined || value === null) return absent
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString()
  return jsonText(value) ?? absent
}
function keyValue(key: string, value: unknown, width: number): Row[] { return wrapRow(row(span(`${key}  `, 'muted'), shown(value)), width) }

type Job = ChatState['jobs'][number]
const liveJob = (job: Job): boolean => job.status === 'running' || job.status === 'stopping'
const JOB_GLYPHS = {
  running: span('◌', 'accent'), stopping: span('◌', 'warning'), completed: span('✓', 'success'), failed: span('×', 'error'), killed: span('–', 'warning'),
} satisfies Record<Job['status'], Span>

/** The description the model gave the tool call that started each job, keyed by job id; jobs without one are absent. */
function jobDescriptions(state: ChatState): Map<Job['id'], string> {
  const found = new Map<Job['id'], string>()
  if (state.jobs.length === 0) return found
  for (const item of state.transcript.items) {
    if (item.kind !== 'tool') continue
    const description = record(item.args).description
    if (typeof description !== 'string' || description.trim() === '') continue
    const result = `${item.resultText ?? ''}\n${jsonText(item.result) ?? ''}`
    for (const job of state.jobs) if (result.includes(job.id)) found.set(job.id, description.trim())
  }
  return found
}

/** Live jobs first, oldest first; then settled jobs, most recently finished first. */
function orderedJobs(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((left, right) => {
    if (liveJob(left) !== liveJob(right)) return liveJob(left) ? -1 : 1
    if (liveJob(left)) return left.startedAt - right.startedAt
    return (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt) || left.startedAt - right.startedAt
  })
}

/**
 * Two rows per job: the status glyph and what the job does (the starting call's description, else its command) with the
 * duration on the right, then the command and the progress or end reason, muted. Every cell opens the job's output.
 */
function jobRows(state: ChatState, width: number, now: number): Row[] {
  if (state.jobs.length === 0) return [row(span('No background jobs.', 'muted'))]
  const descriptions = jobDescriptions(state)
  return orderedJobs(state.jobs).flatMap((job) => {
    const live = liveJob(job)
    const description = descriptions.get(job.id)
    const label = safeText(job.label).replace(/\s+/gu, ' ')
    const title = row(JOB_GLYPHS[job.status], span(' '), span(description ?? label, live ? 'text' : 'muted', live))
    const time = span(duration((live ? now : job.finishedAt ?? job.startedAt) - job.startedAt), 'muted')
    const note = safeText(job.progress ?? job.detail ?? (live ? '' : job.status)).replace(/\s+/gu, ' ')
    const second = [description === undefined ? '' : label, note].filter(part => part !== '').join(' · ')
    const rows = [fitRow(twoSides(title, row(time), width), width), ...second === '' ? [] : [fitRow(row(span(`  ${second}`, 'muted')), width)]]
    return rows.map(value => ({ ...value, spans: value.spans.map(part => ({ ...part, action: { kind: 'inspect-job' as const, jobId: job.id } })) }))
  })
}

/** A section heading of an inspector panel, with an optional faint note after it. */
const heading = (title: string, note = ''): Row => row(span(title, 'accent', true), ...note === '' ? [] : [span(`   ${note}`, 'comment')])

/** `left`, cut when needed, with `note` at the row's end. */
function ended(left: Row, note: string, width: number, tone: Tone = 'comment'): Row {
  const fitted = fitRow(left, Math.max(0, width - widthOf(note) - 2))
  return row(...fitted.spans, span(' '.repeat(Math.max(1, width - widthOf(textOfRow(fitted)) - widthOf(note)))), span(note, tone))
}

/** Cells of the meters that compare token counts in the context panel. */
const BAR_CELLS = 16

/**
 * One row per count: the label, a meter scaled to the largest count, and the count. A missing count shows a dash and an
 * empty meter; a narrow panel leaves the meters out.
 */
function barRows(entries: readonly (readonly [string, number | undefined])[], width: number): Row[] {
  const most = Math.max(1, ...entries.map(([, value]) => value ?? 0))
  const labelCells = Math.max(0, ...entries.map(([label]) => widthOf(label))) + 2
  return entries.map(([label, value]) => {
    const filled = value === undefined || value === 0 ? 0 : Math.max(1, Math.round(value / most * BAR_CELLS))
    return row(span(padText(label, labelCells), 'muted'), ...labelCells + BAR_CELLS + 10 > width ? []
      : [span('▰'.repeat(filled), 'accent'), span('▱'.repeat(BAR_CELLS - filled), 'comment'), span('  ')],
    span(value === undefined ? '—' : tokens(value), value === undefined || value === 0 ? 'comment' : 'text', true))
  })
}

/** The keys of the help panel by section: each key with what it does. */
const KEY_SECTIONS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  ['Write', [['Enter', 'send'], ['Alt+Enter · Ctrl+J', 'new line'], ['/', 'command palette'], ['?', 'main keys (empty prompt)'],
    ['Ctrl+R', 'search prompt history'], ['Ctrl+S', 'stash or restore a draft'], ['Ctrl+G', 'edit the prompt in $EDITOR'], ['Alt+V', 'stage a clipboard image']]],
  ['While a turn runs', [['Enter', 'steer this turn'], ['Tab', 'queue for the next turn'], ['Enter, empty prompt', 'send pending messages now'], ['Esc', 'close a panel or interrupt']]],
  ['Read', [['PgUp · PgDn', 'scroll the conversation'], ['Shift+↑ · ↓', 'one line'], ['Ctrl+Home · End', 'start · end'], ['End', 'back to the latest'],
    ['Ctrl+F', 'search the transcript'], ['n · N', 'next · previous match'], ['Ctrl+O', 'transcript focus'], ['Alt+G', 'goal']]],
  ['Mouse', [['click Thinking', 'show or hide the reasoning'], ['click a tool row', 'open or fold its details'], ['click Copy', 'copy that code block'],
    ['click the goal', 'open the goal'], ['click ×', 'remove a queued item or file'], ['click the preset', 'choose the permission preset']]],
]

/** Narrowest help panel that sets the key table in two columns. */
const KEY_TABLE_TWO_COLUMNS = 96

/** The help panel's key table: sections of keys and actions, in two columns when the panel is wide enough. */
function keyTable(width: number): Row[] {
  const output: Row[] = []
  const keyCells = Math.max(...KEY_SECTIONS.flatMap(([, keys]) => keys.map(([key]) => widthOf(key)))) + 2
  const columns = width >= KEY_TABLE_TWO_COLUMNS ? 2 : 1, column = Math.floor(width / columns)
  const entry = ([key, does]: readonly [string, string], last: boolean): Span[] => {
    const fitted = fitRow(row(span(padText(key, keyCells), 'footer'), span(does, 'text')), column - (last ? 0 : 2))
    return [...fitted.spans, ...last ? [] : [span(' '.repeat(column - widthOf(textOfRow(fitted))))]]
  }
  for (const [title, keys] of KEY_SECTIONS) {
    output.push(heading(title))
    const half = Math.ceil(keys.length / columns)
    for (let at = 0; at < half; at++) {
      const second = columns === 2 ? keys[at + half] : undefined, first = keys[at]
      if (first !== undefined) output.push(row(...entry(first, second === undefined), ...second === undefined ? [] : entry(second, true)))
    }
    output.push(row(''))
  }
  return output
}

/**
 * The body of an inspector panel (help, permissions, goal, jobs, tasks or the default status view).
 * @param state - the chat state.
 * @param panel - the panel to render.
 * @param commands - the commands listed by help.
 * @param width - cells available.
 * @param now - current time in milliseconds, for the running time of live jobs.
 * @returns the wrapped panel rows.
 */
export function inspectorRows(state: ChatState, panel: ChatState['panel'], commands: readonly CommandEntry[], width: number, now = Date.now()): Row[] {
  const output: Row[] = []
  if (panel === 'help') {
    output.push(...keyTable(width), heading('Details'), ...markdownRows([
      'Enter: send · Alt/Shift+Enter or Ctrl+J: newline (terminal support varies) · ? on an empty prompt: the main keys above the composer, until Esc or the next key.',
      '/ opens the command palette: ↑↓ choose, Tab completes, Enter runs; ←→ at the end of the query switch between All, Agent, Skills and Terminal.',
      'While a turn runs, Enter steers it: the agent reads the message at its next step. Tab (or /queue add text) holds it for the next turn instead.',
      'Enter on an empty prompt sends pending messages now: a running command moves to the background and the agent is told when it finishes; any other work is interrupted. Ctrl+Enter sends a draft immediately when the terminal distinguishes it.',
      'Interrupting a turn starts your queued messages next; interrupting them as well keeps the rest queued.',
      'PgUp/PgDn: scroll conversation · Shift+↑/↓: scroll one line · End or click [↓ Back to bottom]: jump to latest.',
      'Click on Thinking: reveal or mask the model reasoning inline.',
      'Click a tool row: open its details inline in the chat, behind a rail; click its title row to fold it back into one row.',
      'Ctrl+Home/End: start/end · Ctrl+O: transcript focus.',
      'Ctrl+F: search the full transcript, including folded details · n/N: next/previous.',
      'Alt+G or a click on the goal under the header: the full objective, with Edit (into the composer), Pause/Resume and Clear.',
      'Ctrl+R: search prompt history · Ctrl+S: stash/restore a draft.',
      'Click Copy on a code block: copy exact code · /copy: last answer · /copy code: last code block.',
      'Click × at the end of a queued message or on a staged file in the composer rule to remove it.',
      'Ctrl+G or /editor: edit the prompt in VISUAL/EDITOR · never auto-sends.',
      'Alt+V or /paste-image: stage a clipboard image for the next prompt.',
      '/resume searches saved content in-page; previewing never activates a session.',
      'Click the permission preset in the status line, shown when it is not the default, or use /permission to choose the current session preset.',
      'Esc: close a panel first, otherwise interrupt a running turn.',
    ].join('\n\n'), width), row(''), row(span('Commands · preset entries use the shared command registry', 'accent', true)))
    for (const entry of commands) output.push(...wrapRow(row(span(`/${entry.name}${entry.hint === undefined ? '' : ` <${entry.hint}>` }  `, 'command'), entry.description), width))
  } else if (panel === 'permissions') {
    const permission = record(state.projections.permissions).currentValue
    // The preset in force is a filled label; the policy it resolves to follows, muted.
    output.push(row(span('Preset   ', 'muted'), { text: ` ${typeof permission === 'string' ? permission : '—'} `, tone: 'accent', bold: true, inverse: true },
      span('   policy ', 'comment'), span(shown(state.approvalPolicy), 'text')), ...markdownRows(state.approvalPolicy === 'never'
      ? 'The core rejects requests that need approval. “Never” does not mean automatic approval.'
      : permission === 'smart' ? 'Smart uses a separate same-model request for eligible sandbox escalations. Only low-risk decisions can grant this invocation. High-risk, ambiguous, invalid or timed-out reviews fall back to the existing human dialog. Extra tokens are not included in the agent context or its decode metrics.'
        : state.approvalPolicy === 'ask' ? 'When the core asks, choose **Allow once** or **Reject**. Grants do not persist to the session. The pending dialog defaults to Reject.'
          : 'The approval service is not available in this session preset.', width), row(''))
    const audit = state.permissionAudit ?? []
    output.push(audit.length === 0 ? ended(heading('Recent requests', 'latest 50'), 'none', width) : heading('Recent requests', 'latest 50'))
    const toolCells = Math.min(20, Math.max(0, ...audit.map(item => widthOf(safeText(item.toolName)))))
    for (const item of audit) {
      const at = new Date(item.time), clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      // The label names the tool first; the table gives the tool its own column.
      const decision = permissionAuditLabel(item).slice(item.toolName.length + 3).replace('allowed-once', 'allowed once')
      output.push(...wrapRow(row(span(`${clock}   `, 'comment'), span(padText(safeText(item.toolName), toolCells + 3), 'text'),
        span(decision, item.outcome === 'allowed-once' ? 'text' : 'muted'), ...item.owner === state.sessionId ? [] : [span(`   subagent ${item.owner}`, 'comment')]), width))
      if (item.review !== undefined) output.push(...wrapRow(row(span(`        ${item.review.reason} · ${duration(item.review.durationMs)}`, 'muted')), width))
    }
    output.push(row(''), ...markdownRows('Use /auto-approve smart, /auto-approve manual, or /auto-approve history. Smart is not a security guarantee. Full access is separate and requires explicit confirmation.', width))
    output.push(row(''), ...markdownRows('This is a read-only inspector. Policy, tool availability, sandboxing and admission remain owned by the same services as Web. This panel is not a sandbox guarantee.', width))
    for (const pending of state.pending) {
      if (pending.kind === 'approval') output.push(row(''), row(span('Waiting for a decision · ', 'warning', true), span(pending.toolName, 'text', true)), ...approvalDetails(pending, width, true))
    }
  } else if (panel === 'goal') {
    const projected = record(state.projections.goal), goal = record(projected.goal)
    if (typeof goal.objective !== 'string') output.push(row(span('No goal in this session. Start one with /goal <objective>.', 'muted')))
    else {
      output.push(...keyValue('Status', goalPhase(state), width))
      if (typeof goal.blockedReason === 'string') output.push(...keyValue('Blocked reason', goal.blockedReason, width))
      output.push(row(''), row(span('Objective', 'accent', true)), ...markdownRows(goal.objective, width))
    }
  } else if (panel === 'jobs') {
    const counts = (['running', 'stopping', 'failed', 'killed', 'completed'] as const)
      .map(status => [status, state.jobs.filter(item => item.status === status).length] as const).filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status === 'completed' ? 'done' : status}`).join(' · ')
    output.push(row({ ...span('[ All jobs ]', 'accent', true), action: { kind: 'open-jobs' } }, ...counts === '' ? [] : [span(`   ${counts}`, 'muted')]), row(''))
    const job = state.jobs.find(item => item.id === state.selectedJob)
    if (state.selectedJob === undefined) output.push(...jobRows(state, width, now))
    else if (job === undefined) output.push(row(span('This job is no longer available.', 'muted')))
    else {
      const description = jobDescriptions(state).get(job.id)
      if (description !== undefined) output.push(...keyValue('Description', safeText(description), width))
      output.push(...keyValue('Command', safeText(job.label), width), ...keyValue('Job', job.id, width), ...keyValue('Status', job.status, width))
      if (job.progress ?? job.detail) output.push(...keyValue('Detail', safeText(job.progress ?? job.detail ?? ''), width))
      const view = state.jobDetail?.jobId === job.id ? state.jobDetail : undefined
      output.push(row(''))
      if (view?.gapBefore) output.push(...wrapRow(row(span('Some earlier output is no longer retained.', 'warning')), width))
      if (view?.error) output.push(...wrapRow(row(span(safeText(view.error), 'error')), width))
      output.push(...wrapRow(row(safeText(view?.text || (view === undefined ? 'Loading output…' : view.streaming ? 'Waiting for output…' : 'No output.'))), width))
    }
  } else if (panel === 'tasks') {
    for (const value of sessionIndicators(state).filter(item => item.glyph !== '☐')) {
      const goal = value.glyph === '◎'
      const left = row(span(`${value.glyph} `, goal ? 'accent' : 'muted'), span(value.label, 'text', goal))
      const note = value.detail ?? (goal ? `goal · ${goalPhase(state) ?? 'saved'}` : '')
      output.push(note === '' ? fitRow(left, width) : ended(left, note, width, value.tone))
    }
    const goal = record(record(state.projections.goal).goal)
    if (typeof goal.blockedReason === 'string') output.push(...keyValue('Blocked reason', goal.blockedReason, width))
    if (output.length > 0) output.push(row(''))
    const todos = Array.isArray(state.projections.todos) ? state.projections.todos.map(record) : []
    if (todos.length === 0) output.push(ended(heading('Checklist'), 'none', width))
    else {
      const done = todos.filter(task => task.status === 'completed').length, size = Math.min(TASK_METER, todos.length)
      const filled = Math.min(size, Math.round(done / todos.length * size))
      output.push(row(...heading('Checklist').spans, span('   '), span('▰'.repeat(filled), 'accent'), span('▱'.repeat(size - filled), 'comment'), span(`  ${done} of ${todos.length}`, 'muted')))
      for (const task of todos) {
        const finished = task.status === 'completed', active = task.status === 'in_progress'
        const note = finished ? 'done' : active ? 'in progress' : task.status === 'pending' ? '' : shown(task.status, 'unknown')
        const lines = wrapProse(row(span(shown(task.content, ''), finished ? 'muted' : 'text', active)), Math.max(1, width - 7 - widthOf(note)))
        lines.forEach((line, index) => {
          const left = row(span(index === 0 ? `  ${finished ? '✓' : active ? '◐' : '○'}  ` : '     ', finished ? 'success' : active ? 'accent' : 'muted'), ...line.spans)
          output.push(index === 0 && note !== '' ? ended(left, note, width) : left)
        })
      }
    }
    output.push(row(''))
    if (state.jobs.length === 0) output.push(ended(heading('Background jobs'), 'none', width))
    else output.push(heading('Background jobs'), ...jobRows(state, width, now))
    if (state.queue.length === 0) output.push(ended(heading('Queued messages'), 'none', width))
    else {
      output.push(heading('Queued messages'))
      state.queue.forEach((item, index) => output.push(...wrapRow(row(span(`  ${index + 1} `, 'comment'),
        span(padText(item.placement === 'steering' ? 'this turn' : item.placement === 'context' ? 'context' : 'next turn', QUEUE_TAG_CELLS), 'muted'),
        span(safeText(contentSummary(item.message.content)).replace(/\s+/gu, ' '), 'text')), width)))
    }
    output.push(row(''), ...markdownRows('Use the existing /goal, /plan and /queue commands to act. /queue remove N, /queue steer N and /queue edit N text use the shared controller. The checklist is the same current todos projection shown by Web; historical lists remain in the transcript.', width))
  } else {
    const pressure = contextReading(state.projections), speed = speedReading(state.projections)
    const usage = record(state.projections.tokenUsage), stats = record(state.projections.sessionStats)
    output.push(...wrapRow(row(span(state.title || 'New session', 'text', true),
      span(`   ${state.cwd} · ${state.preset ?? 'no preset'} · ${state.selection.provider}/${state.selection.model} · effort ${state.selection.reasoningEffort ?? 'provider default'}`, 'muted')), width),
    row(span(state.sessionId, 'comment')), row(''), heading('Context', 'latest host projection'))
    if (pressure.ratio === undefined || pressure.used === undefined || pressure.maximum === undefined) output.push(...keyValue('Pressure', pressure.label, width))
    else {
      const size = Math.max(8, Math.min(50, width - 24))
      const filled = Math.min(size, Math.max(pressure.used > 0 ? 1 : 0, Math.round(pressure.ratio * size)))
      const tone = pressure.ratio >= 0.8 ? 'warning' : 'accent'
      output.push(row(span('▰'.repeat(filled), tone), span('▱'.repeat(size - filled), 'comment'), span(`  ${Math.round(pressure.ratio * 100)}%`, tone, true),
        span(`  ${tokens(pressure.used)} of ${tokens(pressure.maximum)}`, 'muted')))
    }
    output.push(row(''), heading('Tokens used', 'provider accounting, accumulated'))
    const fields = [['Cache read', 'cacheReadTokens'], ['Uncached input', 'uncachedInputTokens'], ['Output (includes reasoning)', 'outputTokens'], ['Cache write', 'cacheWriteTokens']] as const
    output.push(...barRows(fields.map(([label, field]) => [label, nonnegative(usage[field])] as const), width))
    const recent = recentSpeed(state.transcript)
    output.push(row(''), heading(`Speed · latest ${String(SPEED_SAMPLES)} responses`, 'shown in the status line'),
      ...keyValue('Prefill', recent.prefill === undefined ? '—' : `${rate(recent.prefill)} tok/s`, width),
      ...keyValue('Decode', recent.decode === undefined ? '—' : `${rate(recent.decode)} tok/s`, width),
      row(''), heading('Session averages', 'not live GPU speed'),
      ...keyValue('Decode', speed.decode === undefined ? '—' : `${speed.decode.toFixed(2)} tok/s (timed streamed steps)`, width),
      ...keyValue('Time to first token', speed.ttftMs === undefined ? '—' : duration(speed.ttftMs), width),
      ...keyValue('Completed steps / turns', `${shown(stats.steps)} / ${shown(stats.turns)}`, width))
    const breakdown = record(state.projections.contextBreakdown)
    const composed = Object.keys(breakdown).length > 0
    if (composed) {
      output.push(row(''), heading('Context composition', 'heuristic estimate'),
        ...barRows(([['System', 'systemTokens'], ['Tool schemas', 'toolsTokens'], ['Messages', 'messageTokens']] as const).map(([label, field]) => [label, nonnegative(breakdown[field])] as const), width))
    }
    // The explanations follow the figures, so the figures fit one screen.
    output.push(row(''), heading('How these numbers are measured'),
      ...markdownRows('Context pressure is approximate and may lag a model or session change. It is not the accumulated usage total. Compaction policy and thresholds come from the preset, not this interface.', width), row(''),
      ...markdownRows(`Summed tokens over summed wall time of the latest ${String(SPEED_SAMPLES)} model responses, so long responses weigh more. Prefill = uncached input tokens / time from step start to the first token; that time also includes request preparation, queueing, transport and any pruning before the request. Decode = output tokens, reasoning included / time from the first token to the committed message.`, width), row(''),
      ...markdownRows('Decode = timed output tokens / streaming wall time over the whole session. TTFT is an observed latency and includes transport or scheduling overhead. Missing measurements remain “—”.', width),
      ...composed ? [row(''), ...markdownRows('The composition estimates are a separate breakdown; do not add them to provider usage.', width)] : [])
  }
  return output.flatMap(value => wrapRow(value, width))
}

/**
 * Rectangular final safety boundary. Content layout happens before this stage.
 * @param rows - the laid-out rows.
 * @param width - cells per row.
 * @param height - row count.
 * @returns exactly `height` rows, each fitted to `width`.
 */
export function fitScreen(rows: readonly Row[], width: number, height: number): Row[] {
  const output = rows.slice(0, Math.max(0, height)).map(value => fitRow(value, Math.max(0, width)))
  while (output.length < height) output.push(row(''))
  return output
}

/**
 * Marks each search match in a row, case-insensitively: the matched text alone stands on the match background, and in the
 * row the search is on, the first match is filled in the accent tone instead. A row whose lower-case form has another
 * length than its text cannot be split at the match, and is underlined whole.
 * @param value - the row.
 * @param query - the search text; empty leaves the row unchanged.
 * @param current - whether this is the row of the current match.
 * @returns the marked row, or `value` without a match.
 */
export function highlightRow(value: Row, query: string, current = false): Row {
  if (query === '') return value
  const text = textOfRow(value), needle = safeText(query).toLocaleLowerCase(), full = text.toLocaleLowerCase()
  if (needle === '' || !full.includes(needle)) return value
  if (full.length !== text.length) return { ...value, spans: value.spans.map(part => ({ ...part, underline: true })) }
  const starts: number[] = []
  for (let at = full.indexOf(needle); at >= 0; at = full.indexOf(needle, at + needle.length)) starts.push(at)
  const spans: Span[] = []
  let offset = 0
  for (const part of value.spans) {
    const end = offset + part.text.length
    let from = offset
    for (const [index, start] of starts.entries()) {
      const first = Math.max(from, start), last = Math.min(end, start + needle.length)
      if (first >= last) continue
      if (first > from) spans.push({ ...part, text: text.slice(from, first) })
      const { background: _own, ...plain } = part
      spans.push(current && index === 0
        ? { ...plain, text: text.slice(first, last), tone: 'accent', bold: true, inverse: true }
        : { ...part, text: text.slice(first, last), background: 'hit' })
      from = last
    }
    if (from < end) spans.push({ ...part, text: text.slice(from, end) })
    offset = end
  }
  return { ...value, spans }
}

/**
 * The search field that takes the composer's line while a search is open: a mark, the query with its cursor, an optional
 * note after it, and on the right the match position and the keys that apply, in greys.
 * @param query - the search text as edited.
 * @param editing - whether keys still edit the query, which paints its cursor.
 * @param note - muted text after the query, such as the history entry found.
 * @param position - the match position, such as `1 of 3`; empty shows none.
 * @param keys - the keys that apply now, each with its action.
 * @param width - cells available.
 * @returns the field row.
 */
export function searchFieldRow(query: EditorState, editing: boolean, note: string, position: string,
  keys: readonly (readonly [string, string])[], width: number): Row {
  const right = row(...position === '' ? [] : [span(position, 'text'), span(GAP)],
    ...keyHints(keys), span(' '))
  const line = wrapEditor(query.text, Number.MAX_SAFE_INTEGER)[0]
  const field = line === undefined || query.text === ''
    ? [...editing ? [{ text: ' ', inverse: true }] : [], span('Type to search…', 'muted')]
    : draftLine(line, editing ? query.cursor : undefined, undefined)
  const left = row(span('⌕ ', 'accent', true), ...field, ...note === '' ? [] : [span(`${GAP}${note}`, 'muted')])
  const rightCells = widthOf(textOfRow(right))
  // The keys leave before the query is cut.
  if (rightCells + 12 > width) return fitRow(left, width)
  const fitted = fitRow(left, width - rightCells - 1)
  return row(...fitted.spans, span(' '.repeat(width - rightCells - widthOf(textOfRow(fitted)))), ...right.spans)
}
