/** Terminal-native screen primitives. These consume state, never execute it. */
import type { UiAction } from './actions.ts'
import { commandKind, matchScore, PALETTE_TABS, type CommandEntry, type PaletteTab, type PaletteView } from './commands.ts'
import type { EditorState } from './editor.ts'
import { selectionOf, windowAround } from './editor.ts'
import { activeLine, cellWidth, wrapEditor, type VisualLine } from './layout.ts'
import type { PendingApproval, PendingQuestion } from './interaction.ts'
import type { ChatState, Picker, PickerRow } from './store.ts'
import { activity, contextReading, duration, goalPhase, nonnegative, record, sessionIndicators, speedReading, workElapsed } from './metrics.ts'
import { permissionAuditLabel } from './permission-audit.ts'
import { codeBlocks } from './code-blocks.ts'
import { COPY_LABEL, markdownRows } from './markdown-layout.ts'
import { BOX_MIN_WIDTH, boxBottom, boxLine, boxTop, fitRow, indentRows, padText, row, rule, span, textOfRow, twoSides, widthOf, wrapProse, wrapRow, type Row, type Span } from './rich-text.ts'
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
 * each part centred horizontally, the text as one left-aligned block. The whale appears only when its columns plus
 * {@link WELCOME_SIDE} cells on each side and the whole group fit; otherwise the text is centred alone. Text too wide for the
 * area wraps behind a two-cell margin.
 * @param whale - the whale frame to show, or undefined when none is available.
 * @param width - cells across the conversation area.
 * @param height - rows of the conversation area.
 * @returns exactly `height` rows.
 */
export function welcomeRows(whale: readonly Row[] | undefined, width: number, height: number): Row[] {
  const textWidth = Math.max(...WELCOME_TEXT.map(value => widthOf(textOfRow(value))))
  const pad = (rows: readonly Row[], cells: number): Row[] => rows.map(value => row(span(' '.repeat(Math.max(0, Math.floor((width - cells) / 2)))), ...value.spans))
  let group: Row[]
  if (textWidth + 2 * WELCOME_SIDE > width) group = indentRows(WELCOME_TEXT.flatMap(value => wrapProse(value, Math.max(1, width - 2))), '  ', width)
  else {
    const columns = whale?.[0] === undefined ? 0 : widthOf(textOfRow(whale[0]))
    const fits = whale !== undefined && columns + 2 * WELCOME_SIDE <= width && whale.length + 1 + WELCOME_TEXT.length <= height
    group = [...fits ? [...pad(whale, columns), row('')] : [], ...pad(WELCOME_TEXT, textWidth)]
  }
  const top = Math.max(0, Math.floor((height - group.length) / 2))
  const rows = [...Array.from({ length: top }, () => row('')), ...group].slice(0, height)
  while (rows.length < height) rows.push(row(''))
  return rows
}

/**
 * The header: `DSH`, the session title and, on the right, the agent preset.
 * @param state - the chat state.
 * @param width - cells available.
 * @returns the header row.
 */
export function headerRow(state: ChatState, width: number): Row {
  return twoSides(row(span('DSH', 'accent', true), span('  '), span(state.title || 'New session', 'text', true)), row(span(state.preset ?? '', 'muted')), width)
}

/** Space between entries of the indicator and status rows. */
const GAP = '   '

/**
 * The muted row under the header naming the goal, plan, tasks and an imported conversation; each entry keeps its click action.
 * The goal's title gives way first when the row is too narrow.
 * @param state - the chat state.
 * @param width - cells available.
 * @returns the row, or undefined when there is nothing to show.
 */
export function indicatorRow(state: ChatState, width: number): Row | undefined {
  const indicators = sessionIndicators(state)
  const entries: Span[][] = indicators.map((value) => {
    const own = (part: Span): Span => value.action === undefined ? part : { ...part, action: value.action }
    return [own(span(`${value.glyph} `, 'brand')), own(span(value.label, 'muted')),
      ...value.detail === undefined ? [] : [own(span(`${GAP}${value.detail}`, value.tone))]]
  })
  const prechat = state.projections.prechat
  if (typeof prechat === 'number' && prechat > 0) entries.push([span('▤ ', 'brand'), span(`${prechat} imported ${prechat === 1 ? 'message' : 'messages'}`, 'muted')])
  if (entries.length === 0) return undefined
  const cells = (parts: readonly Span[]): number => widthOf(textOfRow(row(...parts)))
  const total = entries.reduce((sum, parts) => sum + cells(parts), 0) + GAP.length * (entries.length - 1)
  const [glyph, title, ...rest] = entries[0] ?? []
  if (total > width && indicators[0]?.glyph === '◎' && glyph !== undefined && title !== undefined) {
    // Shorten the goal title, never the shorter plan and task entries after it.
    const shortened = fitRow(row(title), Math.max(8, cells([title]) - (total - width))).spans
    entries[0] = [glyph, ...shortened.map(part => title.action === undefined ? part : { ...part, action: title.action }), ...rest]
  }
  return fitRow(row(...entries.flatMap((parts, index) => index === 0 ? parts : [span(GAP), ...parts])), width)
}

/**
 * One status-line entry; while the line is too wide, entries leave in ascending `keep` order. `join` replaces the separator
 * before the entry, binding it to the entry it follows on the same side.
 */
interface StatusEntry { spans: Span[]; keep: number; side: 'left' | 'right'; join?: Span }

/**
 * The status line under the composer. Left: the activity with its status glyph (a running Laya pass shows only its phase
 * label, in the accent tone), the model and effort, the permission preset
 * when it is not the default, background jobs, and the work timer while a turn runs, all muted. Right: the context meter bar,
 * usage percentage and token counts, and the `? keys` control. On narrow terminals the separators tighten, then entries leave
 * in this order: the keys control, the model, jobs, the timer, the meter bar, the token counts, the percentage and the preset.
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
  if (state.jobs.length > 0) {
    // The count names live work only; settled records stay listed in the panel until their owner closes.
    const live = state.jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
    const text = live > 0 ? `${live} job${live === 1 ? '' : 's'}` : `${state.jobs.length} finished job${state.jobs.length === 1 ? '' : 's'}`
    entries.push({ side: 'left', keep: 30, spans: [{ ...span(text, 'muted'), action: { kind: 'open-jobs' } }] })
  }
  const elapsed = workElapsed(state, now)
  if (elapsed !== undefined) entries.push({ side: 'left', keep: 40, spans: [span(duration(elapsed), 'muted')] })
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
 * Visible composer lines keep UTF-16 cursor offsets; only display is escaped.
 * @param editor - the draft.
 * @param width - composer width in cells.
 * @param maxLines - visible draft lines, at least 1.
 * @param placeholder - muted text shown for an empty draft.
 * @param disabled - paints no cursor or selection.
 * @param offset - the first visible line; omitted, the window follows the cursor.
 * @returns a rule row followed by the visible draft rows.
 */
export function composerRows(editor: EditorState, width: number, maxLines: number, placeholder: string,
  disabled = false, offset?: number): Row[] {
  const available = Math.max(1, width - 3)
  const lines = wrapEditor(editor.text, available), active = activeLine(lines, editor.cursor)
  const size = Math.max(1, maxLines)
  const first = composerTop(lines, editor, size, offset)
  const visible = { items: lines.slice(first, first + size), offset: first }
  const range = selectionOf(editor)
  const output = [rule(width, lines.length > 1 ? `prompt · ${active + 1}/${lines.length}` : '')]
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
 * The command palette under the composer: a tab row with per-tab counts, the commands (under headings for an empty query), and
 * a footer with the selection position and keys. The name column is sized from every listed command, so it stays put while
 * the selection scrolls; an argument hint follows the name, muted. A typed query adds a kind column from 60 cells.
 * @param view - the palette layout from `paletteView`.
 * @param index - the selected entry, an index into `view.entries`.
 * @param tab - the active tab.
 * @param width - cells available.
 * @param height - rows available, at most {@link PALETTE_MAX_ROWS} used; below 2 yields nothing.
 * @returns the tab row, the visible commands, each clickable to complete, and the footer.
 */
export function paletteRows(view: PaletteView, index: number, tab: PaletteTab, width: number, height: number): Row[] {
  if (height < 2) return []
  const tabs = fitRow(row(span('  '), ...PALETTE_TABS.flatMap(({ id, label }, at) => [...at === 0 ? [] : [span(width < 50 ? '  ' : GAP)],
    { ...span(`${label} ${view.counts[id]}`, id === tab ? 'command' : 'muted', id === tab), action: { kind: 'palette-tab' as const, tab: id } }])), width)
  const count = view.entries.length
  const footer = fitRow(row(span(count === 0 ? 'No matching command · ←→ category · Esc dismiss'
    : `${index + 1}/${count} · ↑↓ choose · ←→ category · Tab complete · Enter run · Esc dismiss`, 'footer')), width)
  const selected = Math.max(0, view.rows.findIndex(value => value.kind === 'entry' && value.index === index))
  const visible = windowAround(view.rows, selected, Math.max(1, Math.min(PALETTE_MAX_ROWS, height) - 2))
  const kinds = !view.grouped && width >= 60
  const named = (entry: CommandEntry): number => widthOf(`/${entry.name}`)
  const full = (entry: CommandEntry): number => named(entry) + (entry.hint === undefined ? 0 : widthOf(entry.hint) + 1)
  const longestName = Math.max(0, ...view.entries.map(named)), hintRoom = Math.min(NAME_CELLS, Math.floor((width - 4) * 0.3))
  const nameWidth = Math.min(Math.max(0, ...view.entries.map(full)), Math.max(longestName, hintRoom))
  const list = Math.min(PALETTE_MAX_ROWS, height) >= 3 ? visible.items.map((value): Row => {
    if (value.kind === 'header') return fitRow(row(span(`  ${value.label}`, 'muted', true), ...value.detail === undefined ? [] : [span(`  ${value.detail}`, 'muted')]), width)
    const { entry } = value, chosen = value.index === index
    // The name is never cut; its argument hint takes what the column leaves.
    const room = nameWidth - named(entry) - 1
    const hint = entry.hint === undefined || room < 2 ? [] : [span(' '), ...fitRow(row(span(entry.hint, 'muted')), room).spans]
    const name = row(span(`/${entry.name}`, 'command', chosen), ...hint)
    const kind = kinds ? [span(padText(commandKind(entry), KIND_CELLS), 'muted')] : []
    const line = fitRow(row(span(chosen ? '❯ ' : '  ', 'command', chosen), ...name.spans, span(' '.repeat(Math.max(0, nameWidth - widthOf(textOfRow(name))) + 2)),
      ...kind, span(entry.description, 'text')), width)
    return { ...line, spans: line.spans.map(part => ({ ...part, action: { kind: 'command-complete' as const, name: entry.name } })) }
  }) : []
  return [tabs, ...list, footer]
}

/** Most queued messages and staged files listed above the composer before a summary row. */
const NOTE_ITEMS = 3

/**
 * What waits above the composer's top rule: queued messages and staged files, each with a `×` that removes it, then the
 * current error (with the command's correct form) and the current transient hint.
 * @param state - the chat state.
 * @param width - cells available.
 * @returns the rows, empty when nothing waits.
 */
export function composerNotes(state: ChatState, width: number): Row[] {
  const output: Row[] = []
  const removable = (parts: readonly Span[], action: UiAction): Row => {
    const text = fitRow(row(...parts), Math.max(0, width - 4))
    return fitRow(row(...text.spans, span(GAP), { ...span('×', 'muted'), action }), width)
  }
  const queue = state.queue.filter(item => item.placement !== 'context')
  queue.slice(0, NOTE_ITEMS).forEach((item, index) => {
    const summary = safeText(contentSummary(item.message.content)).replace(/\s+/gu, ' ')
    output.push(removable([span('  ↳ ', 'muted'), span(item.placement === 'steering' ? 'steering this turn: ' : 'queued for the next turn: ', 'muted'), span(summary, 'text')],
      { kind: 'queue-remove', index }))
  })
  if (queue.length > NOTE_ITEMS) output.push(fitRow(row(span(`  ↳ ${queue.length - NOTE_ITEMS} more queued · /tasks lists them`, 'muted')), width))
  state.attachments.slice(0, NOTE_ITEMS).forEach((attachment, index) => {
    output.push(removable([span('  + ', 'accent'), span(attachment.name, 'text')], { kind: 'detach', index, name: attachment.name }))
  })
  if (state.attachments.length > NOTE_ITEMS) output.push(fitRow(row(span(`  + ${state.attachments.length - NOTE_ITEMS} more files · /detach removes all`, 'muted')), width))
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
    output.push({ ...value, spans: value.spans.map(part => ({ ...part, inverse: selected, action })) })
    if (itemHeight === 2) {
      const detail = fitRow(row(span(`    ${entry.detail}`, 'muted')), width)
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

/**
 * The approval panel's details: tool, owner, cwd, reason and full arguments, plus a
 * copyable command when the arguments are JSON with a `command` string.
 * @param pending - the pending approval.
 * @param width - cells available.
 * @returns the wrapped detail rows.
 */
export function approvalDetails(pending: PendingApproval, width: number): Row[] {
  let command: string | undefined
  try {
    const args: unknown = JSON.parse(pending.detail ?? '')
    if (args !== null && typeof args === 'object' && 'command' in args && typeof args.command === 'string') command = args.command
  } catch { /* Not all tools use JSON. */ }
  const invocation: Row[] = command === undefined ? [] : [row(''), twoSides(row(span('COMMAND', 'toolBash', true)), row({ ...span('[ Copy ]', 'accent', true), action: { kind: 'copy-text', text: command, label: 'requested command' } }), width),
    ...wrapRow(row(span(command, 'text', true)), width)]
  return [ ...wrapRow(row(span(`Tool  ${pending.toolName}`, 'warning', true)), width),
    ...wrapRow(row(span(`Owner ${pending.owner}`, 'muted')), width),
    ...(pending.cwd === undefined ? [] : wrapRow(row(span(`Cwd   ${pending.cwd}`, 'muted')), width)), ...invocation,
    row(''), ...wrapRow(row(span(pending.reason ?? 'The tool requests authorization for this invocation.', 'text')), width),
    row(''), row(span('Complete arguments', 'muted', true)), ...wrapRow(row(pending.detail ?? '(No arguments supplied by the tool)'), width)]
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
 * The approval panel's controls: the Allow once / Reject choice, with the current one bracketed in a neutral tone, and the
 * keys, whose `Enter confirm` is also the mouse confirm target. One row when it fits, otherwise the choice above the keys.
 * @param width - cells available.
 * @param allowed - whether Allow once is the current choice.
 * @param count - pending approvals; above 1 the keys row shows it.
 * @returns the control rows.
 */
export function approvalControls(width: number, allowed: boolean, count: number): Row[] {
  const choice = (label: string, value: boolean): Span => value === allowed
    ? { ...span(`[ ${label} ]`, 'text', true), action: { kind: 'approval-select', allowed: value } }
    : { ...span(`  ${label}  `, 'muted'), action: { kind: 'approval-select', allowed: value } }
  const choices = row(span(' '), choice('Allow once', true), span('  '), choice('Reject', false))
  const keys = row(span('←→ choose · ', 'footer'), { ...span('Enter confirm', 'footer'), action: { kind: 'approval-confirm' } },
    span(` · y select allow · n/Esc reject${count > 1 ? ` · ${count} pending` : ''}`, 'footer'))
  const together = row(...choices.spans, span('    '), ...keys.spans)
  return widthOf(textOfRow(together)) <= width ? [together] : [fitRow(choices, width), fitRow(keys, width)]
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

/**
 * The current question's options, custom-answer composer and confirm row.
 * @param pending - the pending question set.
 * @param draft - the reader's progress.
 * @param width - cells available.
 * @param height - panel height, which bounds the visible options and composer lines.
 * @returns the control rows.
 */
export function questionControls(pending: PendingQuestion, draft: QuestionDraft, width: number, height: number): Row[] {
  const question = pending.questions[draft.index], options = question?.options ?? []
  const visible = windowAround(options, draft.optionIndex, Math.max(1, Math.min(5, Math.floor(height / 4))))
  const output: Row[] = []
  for (let position = 0; position < visible.items.length; position++) {
    const option = visible.items[position]
    if (option === undefined) continue
    const selected = !draft.customMode && position + visible.offset === draft.optionIndex
    const value = fitRow(row(span(`${draft.selected.includes(option.label) ? '●' : '○'} ${position + visible.offset + 1}. `, 'accent'), span(option.label, 'text', selected)), width)
    output.push({ ...value, spans: value.spans.map(part => ({ ...part, inverse: selected, action: { kind: 'question-option' as const, index: position + visible.offset } })) })
  }
  output.push(...composerRows(draft.custom, width, Math.max(1, Math.min(3, Math.floor(height / 6))), draft.customMode ? 'Type your answer…' : 'Tab to write an answer', !draft.customMode).slice(1))
  output.push(fitRow(row({ ...span('[ Confirm ] ', 'accent', true), action: { kind: 'question-confirm' } }, span(`${options.length ? `↑↓ choose · Space ${question?.multiSelect ? 'toggle' : 'select'} · Tab custom · ` : ''}Enter confirm · Esc cancel`, 'footer')), width))
  return output
}

/** Projection values arrive untyped; scalars print as themselves, structures as JSON, and absence as a dash. */
function shown(value: unknown, absent = '—'): string {
  if (value === undefined || value === null) return absent
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString()
  return jsonText(value) ?? absent
}
function keyValue(key: string, value: unknown, width: number): Row[] { return wrapRow(row(span(`${key}  `, 'muted'), shown(value)), width) }

function jobRows(state: ChatState, width: number): Row[] {
  if (state.jobs.length === 0) return [row(span('No background jobs.', 'muted'))]
  return state.jobs.flatMap(job => wrapRow(row({ ...span(safeText(`[${job.status}] ${job.label}\n${job.id}${job.detail === undefined ? '' : `\n${job.detail}`}`), 'accent'), action: { kind: 'inspect-job', jobId: job.id } }), width))
}

/**
 * The body of an inspector panel (help, permissions, goal, jobs, tasks or the default status view).
 * @param state - the chat state.
 * @param panel - the panel to render.
 * @param commands - the commands listed by help.
 * @param width - cells available.
 * @returns the wrapped panel rows.
 */
export function inspectorRows(state: ChatState, panel: ChatState['panel'], commands: readonly CommandEntry[], width: number): Row[] {
  const output: Row[] = []
  if (panel === 'help') {
    output.push(row(span('Keyboard', 'accent', true)), ...markdownRows([
      'Enter: send · Alt/Shift+Enter or Ctrl+J: newline (terminal support varies) · ? on an empty prompt: the main keys above the composer, until Esc or the next key.',
      '/ opens the command palette: ↑↓ choose, Tab completes, Enter runs; ←→ at the end of the query switch between All, Agent, Skills and Terminal.',
      'While a turn runs, Enter steers it: the agent reads the message at its next step. Tab (or /queue add text) holds it for the next turn instead.',
      'Enter on an empty prompt sends pending messages now: a running command moves to the background and the agent is told when it finishes; any other work is interrupted. Ctrl+Enter sends a draft immediately when the terminal distinguishes it.',
      'Interrupting a turn starts your queued messages next; interrupting them as well keeps the rest queued.',
      'PgUp/PgDn: scroll conversation · Shift+↑/↓: scroll one line · End or click [↓ Back to bottom]: jump to latest.',
      'Click on Thinking: reveal or mask the model reasoning inline.',
      'Click a tool row: open its details card inline in the chat; click the card heading to fold it back into one row.',
      'Ctrl+Home/End: start/end · Ctrl+O: transcript focus.',
      'Ctrl+F: search the full transcript, including folded details · n/N: next/previous.',
      'Alt+G or a click on the goal under the header: the full objective, with Edit (into the composer), Pause/Resume and Clear.',
      'Ctrl+R: search prompt history · Ctrl+S: stash/restore a draft.',
      'Click Copy on a code block: copy exact code · /copy: last answer · /copy code: last code block.',
      'Click × beside a queued message or a staged file above the composer to remove it.',
      'Ctrl+G or /editor: edit the prompt in VISUAL/EDITOR · never auto-sends.',
      'Alt+V or /paste-image: stage a clipboard image for the next prompt.',
      '/resume searches saved content in-page; previewing never activates a session.',
      'Click the permission preset in the status line, shown when it is not the default, or use /permission to choose the current session preset.',
      'Esc: close a panel first, otherwise interrupt a running turn.',
    ].join('\n\n'), width), row(''), row(span('Commands · preset entries use the shared command registry', 'accent', true)))
    for (const entry of commands) output.push(...wrapRow(row(span(`/${entry.name}${entry.hint === undefined ? '' : ` <${entry.hint}>` }  `, 'command'), entry.description), width))
  } else if (panel === 'permissions') {
    const permission = record(state.projections.permissions).currentValue
    output.push(...keyValue('Permission preset', typeof permission === 'string' ? permission : undefined, width), ...keyValue('Effective policy', state.approvalPolicy, width), ...markdownRows(state.approvalPolicy === 'never'
      ? 'The core rejects requests that need approval. “Never” does not mean automatic approval.'
      : permission === 'smart' ? 'Smart uses a separate same-model request for eligible sandbox escalations. Only low-risk decisions can grant this invocation. High-risk, ambiguous, invalid or timed-out reviews fall back to the existing human dialog. Extra tokens are not included in the agent context or its decode metrics.'
        : state.approvalPolicy === 'ask' ? 'When the core asks, choose **Allow once** or **Reject**. Grants do not persist to the session. The pending dialog defaults to Reject.'
          : 'The approval service is not available in this session preset.', width), row(''))
    output.push(...markdownRows('Use /auto-approve smart, /auto-approve manual, or /auto-approve history. Smart is not a security guarantee. Full access is separate and requires explicit confirmation.', width))
    output.push(row(''), row(span('Permission audit · latest 50 questions', 'accent', true)))
    for (const item of state.permissionAudit ?? []) {
      output.push(...wrapRow(row(span(permissionAuditLabel(item), item.outcome === 'allowed-once' ? 'success' : item.outcome === 'rejected' ? 'warning' : 'muted')), width))
      if (item.review !== undefined) output.push(...wrapRow(row(span(`  ${item.review.reason} · ${duration(item.review.durationMs)}`, 'muted')), width))
      if (item.owner !== state.sessionId) output.push(...wrapRow(row(span(`  subagent ${item.owner}`, 'muted')), width))
    }
    output.push(...markdownRows('This is a read-only inspector. Policy, tool availability, sandboxing and admission remain owned by the same services as Web. This panel is not a sandbox guarantee.', width))
    for (const pending of state.pending) if (pending.kind === 'approval') output.push(row(''), ...approvalDetails(pending, width))
  } else if (panel === 'goal') {
    const projected = record(state.projections.goal), goal = record(projected.goal)
    if (typeof goal.objective !== 'string') output.push(row(span('No goal in this session. Start one with /goal <objective>.', 'muted')))
    else {
      output.push(...keyValue('Status', goalPhase(state), width))
      if (typeof goal.blockedReason === 'string') output.push(...keyValue('Blocked reason', goal.blockedReason, width))
      output.push(row(''), row(span('Objective', 'accent', true)), ...markdownRows(goal.objective, width))
    }
  } else if (panel === 'jobs') {
    output.push(row({ ...span('[ All jobs ]', 'accent', true), action: { kind: 'open-jobs' } }), row(''))
    const job = state.jobs.find(item => item.id === state.selectedJob)
    if (state.selectedJob === undefined) output.push(...jobRows(state, width))
    else if (job === undefined) output.push(row(span('This job is no longer available.', 'muted')))
    else {
      output.push(...keyValue('Command', safeText(job.label), width), ...keyValue('Job', job.id, width), ...keyValue('Status', job.status, width))
      if (job.progress ?? job.detail) output.push(...keyValue('Detail', safeText(job.progress ?? job.detail ?? ''), width))
      const view = state.jobDetail?.jobId === job.id ? state.jobDetail : undefined
      output.push(row(''))
      if (view?.gapBefore) output.push(...wrapRow(row(span('Some earlier output is no longer retained.', 'warning')), width))
      if (view?.error) output.push(...wrapRow(row(span(safeText(view.error), 'error')), width))
      output.push(...wrapRow(row(safeText(view?.text || (view === undefined ? 'Loading output…' : view.streaming ? 'Waiting for output…' : 'No output.'))), width))
    }
  } else if (panel === 'tasks') {
    output.push(...sessionIndicators(state).flatMap(value => wrapRow(row(span(`${value.glyph} `, 'brand'), span(value.label, 'text'),
      ...value.detail === undefined ? [] : [span(` · ${value.detail}`, value.tone)]), width)))
    const goal = record(record(state.projections.goal).goal)
    if (typeof goal.blockedReason === 'string') output.push(...keyValue('Blocked reason', goal.blockedReason, width))
    const todos = Array.isArray(state.projections.todos) ? state.projections.todos.map(record) : []
    output.push(row(''), row(span('Task checklist', 'accent', true)))
    if (todos.length === 0) output.push(row(span('No current task checklist.', 'muted')))
    for (const task of todos) output.push(...wrapRow(row(span(`${task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◌' : '○'} [${shown(task.status, 'unknown')}] `, task.status === 'completed' ? 'success' : task.status === 'in_progress' ? 'accent' : 'muted'), shown(task.content, '')), width))
    output.push(row(''), row(span('Background jobs', 'accent', true)))
    output.push(...jobRows(state, width))
    output.push(row(''), row(span('Queued messages', 'accent', true)))
    if (state.queue.length === 0) output.push(row(span('No queued messages.', 'muted')))
    state.queue.forEach((item, index) => output.push(...wrapRow(row(`${index + 1}. [${item.placement}] ${contentSummary(item.message.content)}`), width)))
    output.push(row(''), ...markdownRows('Use the existing /goal, /plan and /queue commands to act. /queue remove N, /queue steer N and /queue edit N text use the shared controller. The checklist is the same current todos projection shown by Web; historical lists remain in the transcript.', width))
  } else {
    const pressure = contextReading(state.projections), speed = speedReading(state.projections)
    const usage = record(state.projections.tokenUsage), stats = record(state.projections.sessionStats)
    output.push(...keyValue('Session', state.sessionId, width), ...keyValue('Directory', state.cwd, width), ...keyValue('Preset', state.preset, width),
      ...keyValue('Model', `${state.selection.provider}/${state.selection.model}`, width), ...keyValue('Effort', state.selection.reasoningEffort ?? 'provider default', width), row(''),
      row(span('Context · latest host projection', 'accent', true)), ...keyValue('Pressure', pressure.label, width),
      ...markdownRows('Context pressure is approximate and may lag a model or session change. It is not the accumulated usage total. Compaction policy and thresholds come from the preset, not this interface.', width), row(''),
      row(span('Accumulated usage · provider accounting', 'accent', true)))
    for (const [label, field] of [['Uncached input', 'uncachedInputTokens'], ['Cache read', 'cacheReadTokens'], ['Cache write', 'cacheWriteTokens'], ['Output (includes reasoning)', 'outputTokens']] as const) {
      const value = nonnegative(usage[field]); output.push(...keyValue(label, value === undefined ? '—' : tokens(value), width))
    }
    output.push(row(''), row(span('Performance · session averages, not live GPU speed', 'accent', true)),
      ...keyValue('Decode', speed.decode === undefined ? '—' : `${speed.decode.toFixed(2)} tok/s (timed streamed steps)`, width),
      ...keyValue('Time to first token', speed.ttftMs === undefined ? '—' : duration(speed.ttftMs), width),
      ...keyValue('Completed steps / turns', `${shown(stats.steps)} / ${shown(stats.turns)}`, width),
      ...markdownRows('Decode = timed output tokens / streaming wall time. TTFT is an observed latency and includes transport or scheduling overhead. Prefill speed is not exposed by this core and is deliberately not estimated. Missing measurements remain “—”.', width))
    const breakdown = record(state.projections.contextBreakdown)
    if (Object.keys(breakdown).length > 0) {
      output.push(row(''), row(span('Context composition · heuristic estimate', 'accent', true)))
      for (const [label, field] of [['System', 'systemTokens'], ['Tool schemas', 'toolsTokens'], ['Messages', 'messageTokens']] as const) output.push(...keyValue(label, breakdown[field], width))
      output.push(...markdownRows('These estimates are a separate breakdown; do not add them to provider usage.', width))
    }
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
 * Underlines a row containing a search match, case-insensitively.
 * @param value - the row.
 * @param query - the search text; empty leaves the row unchanged.
 * @returns the underlined row, or `value` without a match.
 */
export function highlightRow(value: Row, query: string): Row {
  if (query === '') return value
  const needle = safeText(query).toLocaleLowerCase(), full = textOfRow(value).toLocaleLowerCase()
  if (!full.includes(needle)) return value
  return { ...value, spans: value.spans.map(part => ({ ...part, underline: true })) }
}
