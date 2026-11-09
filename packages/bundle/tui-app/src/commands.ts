/**
 * Slash commands the chat handles itself, beside the plugin-owned registry
 * (`ctx.commands`) that supplies `/goal`, `/plan`, `/compact`, `/feedback`,
 * and whatever else the composed profile registers. Both sets share one
 * discovery popup and one dispatch path.
 * @module @deepseek-ai/dsh-tui-app/commands
 */

import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'

/** What a chat-owned command acts on; the palette's Terminal tab lists them under these headings. */
export type CommandGroup = 'session' | 'model' | 'input' | 'view' | 'settings'

/** One command the popup offers. */
export interface CommandEntry {
  name: string
  description: string
  /** Placeholder for free-form input, when the command takes any. */
  hint?: string
  /** Chat-owned (`local`), supplied by the composed registry (`registry`), or a user-invocable skill (`skill`). */
  origin: 'local' | 'registry' | 'skill'
  /** For chat-owned commands, the group the palette lists the command under. */
  group?: CommandGroup
}

/** Commands the chat implements locally, in the order the palette's Terminal tab lists them within each group. */
export const LOCAL_COMMANDS: readonly CommandEntry[] = Object.freeze([
  { name: 'new', description: 'new session; optional agent preset', hint: 'preset', origin: 'local', group: 'session' },
  { name: 'resume', description: 'search saved sessions or resume an ID', hint: 'id | --last | --all', origin: 'local', group: 'session' },
  { name: 'sessions', description: 'browse saved sessions', origin: 'local', group: 'session' },
  { name: 'fork', description: 'fork at the last completed turn', origin: 'local', group: 'session' },
  { name: 'rename', description: 'persist a new session title', hint: 'title', origin: 'local', group: 'session' },
  { name: 'export', description: 'write the complete transcript to a new Markdown file', hint: 'path', origin: 'local', group: 'session' },
  { name: 'clear', description: 'clear display only; keep the session and context', origin: 'local', group: 'session' },
  { name: 'exit', description: 'cancel, save and leave', origin: 'local', group: 'session' },
  { name: 'model', description: 'choose a model (same catalog as Web)', hint: 'provider/model', origin: 'local', group: 'model' },
  { name: 'effort', description: 'choose a model-supported reasoning effort', hint: 'effort | default', origin: 'local', group: 'model' },
  { name: 'status', description: 'session, preset, model and context usage', origin: 'local', group: 'model' },
  { name: 'context', description: 'inspect context and accumulated token usage', origin: 'local', group: 'model' },
  { name: 'attach', description: 'stage a local file for the next prompt', hint: 'path', origin: 'local', group: 'input' },
  { name: 'image', description: 'stage an image using Web image admission', hint: 'path', origin: 'local', group: 'input' },
  { name: 'paste-image', description: 'stage a clipboard image (Alt+V); never auto-send', origin: 'local', group: 'input' },
  { name: 'detach', description: 'remove staged attachments', origin: 'local', group: 'input' },
  { name: 'editor', description: 'edit draft in VISUAL/EDITOR (Ctrl+G); never auto-send', origin: 'local', group: 'input' },
  { name: 'queue', description: 'queue for the next turn, send now, or remove, edit or steer queued messages', hint: 'add text | send | remove N | steer N | edit N text', origin: 'local', group: 'input' },
  { name: 'steer', description: 'deliver input at the next step (what Enter does while a turn runs)', hint: 'message', origin: 'local', group: 'input' },
  { name: 'stop', description: 'cancel the active turn or command', origin: 'local', group: 'input' },
  { name: 'diff', description: 'review recorded file changes with numbered hunks', origin: 'local', group: 'view' },
  { name: 'transcript', description: 'browse messages and expand individual tool calls', origin: 'local', group: 'view' },
  { name: 'expand', description: 'expand or collapse all tool details (display only)', origin: 'local', group: 'view' },
  { name: 'jobs', description: 'show session background jobs', origin: 'local', group: 'view' },
  { name: 'tasks', description: 'inspect goal, plan, tasks and background jobs', origin: 'local', group: 'view' },
  { name: 'permissions', description: 'inspect current permission policy and pending requests', origin: 'local', group: 'view' },
  { name: 'help', description: 'commands and keyboard shortcuts', origin: 'local', group: 'view' },
  { name: 'theme', description: 'choose terminal colours, never model settings', hint: 'dark | light | mono', origin: 'local', group: 'settings' },
  { name: 'mouse', description: 'mouse scrolling and buttons; off restores terminal selection', hint: 'on | off', origin: 'local', group: 'settings' },
  { name: 'links', description: 'clickable URL and file references via OSC 8', hint: 'on | off', origin: 'local', group: 'settings' },
  { name: 'notify', description: 'attention notifications when the terminal is unfocused', hint: 'off | bell | desktop', origin: 'local', group: 'settings' },
  { name: 'title', description: 'dynamic terminal tab title', hint: 'on | off', origin: 'local', group: 'settings' },
  { name: 'layout', description: 'adaptive detail pane or single-column layout', hint: 'auto | single | split', origin: 'local', group: 'settings' },
  { name: 'cwd', description: 'show this session’s recorded working directory', origin: 'local', group: 'settings' },
  { name: 'copy', description: 'copy last answer or code; code blocks also have a mouse Copy button', hint: 'code | raw', origin: 'local', group: 'settings' },
])

/** Palette headings of the chat-owned command groups, in display order. */
export const COMMAND_GROUPS: readonly { id: CommandGroup; label: string }[] = Object.freeze([
  { id: 'session', label: 'Session' }, { id: 'model', label: 'Model & context' }, { id: 'input', label: 'Input' },
  { id: 'view', label: 'View' }, { id: 'settings', label: 'Settings' },
])

/**
 * Merge local commands, registry commands, and user-invocable skills into one
 * sorted, de-duplicated list; a registry name wins except the reserved /stop
 * and /exit controls, and any command name wins over a skill of that name.
 * @param registry - commands the composed registry offers the current session.
 * @param skills - user-invocable skills of the current session, sent as `/name` prompts.
 * @returns the popup entries sorted by name.
 */
export function mergeCommands(
  registry: readonly CommandDescriptor[],
  skills: readonly { name: string; description: string }[] = [],
): CommandEntry[] {
  const byName = new Map<string, CommandEntry>()
  for (const skill of skills) byName.set(skill.name, { name: skill.name, description: skill.description.replaceAll(/\s+/gu, ' ').trim(), hint: 'task', origin: 'skill' })
  for (const local of LOCAL_COMMANDS) byName.set(local.name, local)
  for (const descriptor of registry) {
    if (descriptor.name === 'stop' || descriptor.name === 'exit' || descriptor.name === 'reasoning') continue
    byName.set(descriptor.name, {
      name: descriptor.name,
      description: descriptor.description,
      ...descriptor.input === undefined ? {} : { hint: descriptor.input.hint },
      origin: 'registry',
    })
  }
  return [...byName.values()].sort((left, right) => left.name < right.name ? -1 : 1)
}

/**
 * Ranked fuzzy discovery. Executed command names remain exact and unchanged.
 * @param haystack - candidate text, compared case-insensitively.
 * @param query - typed text; surrounding whitespace is ignored.
 * @returns 0 for an empty query, -1 when the query's characters do not occur in order, otherwise a score where exact > prefix >
 *   substring > subsequence.
 */
export function matchScore(haystack: string, query: string): number {
  const text = haystack.toLocaleLowerCase(), needle = query.toLocaleLowerCase().trim()
  if (needle === '') return 0
  if (text === needle) return 1000
  if (text.startsWith(needle)) return 800 - text.length
  const at = text.indexOf(needle)
  if (at >= 0) return 500 - at
  let cursor = 0; let gaps = 0; let previous = -1
  for (const character of needle) {
    const found = text.indexOf(character, cursor)
    if (found < 0) return -1
    gaps += previous < 0 ? found : found - previous - 1
    previous = found; cursor = found + 1
  }
  return Math.max(1, 200 - gaps - text.length)
}
/**
 * Rank commands by name match, with description matches weighted at one tenth.
 * @param entries - available commands.
 * @param typed - composer text; a leading `/` is ignored.
 * @returns matching commands, best first, ties ordered by name.
 */
export function filterCommands(entries: readonly CommandEntry[], typed: string): CommandEntry[] {
  const needle = typed.replace(/^\//u, '')
  return entries.map(entry => ({ entry, score: Math.max(matchScore(entry.name, needle), matchScore(entry.description, needle) / 10) }))
    .filter(value => value.score >= 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .map(value => value.entry)
}

/** A category tab of the command palette. */
export type PaletteTab = 'all' | 'agent' | 'skills' | 'terminal'
/** The palette's tabs in display order, with their labels. */
export const PALETTE_TABS: readonly { id: PaletteTab; label: string }[] = Object.freeze([
  { id: 'all', label: 'All' }, { id: 'agent', label: 'Agent' }, { id: 'skills', label: 'Skills' }, { id: 'terminal', label: 'Terminal' },
])
/**
 * The short kind name shown beside a ranked match.
 * @param entry - the command.
 * @returns `agent`, `skill` or `terminal`.
 */
export function commandKind(entry: CommandEntry): 'agent' | 'skill' | 'terminal' {
  switch (entry.origin) {
    case 'registry': return 'agent'
    case 'skill': return 'skill'
    case 'local': return 'terminal'
  }
}
const inTab = (entry: CommandEntry, tab: PaletteTab): boolean => tab === 'all'
  || (tab === 'agent' ? entry.origin === 'registry' : tab === 'skills' ? entry.origin === 'skill' : entry.origin === 'local')

/** One palette line: a non-selectable group heading, or a command at position `index` among the selectable entries. */
export type PaletteRow =
  | { kind: 'header'; label: string; detail?: string }
  | { kind: 'entry'; entry: CommandEntry; index: number }
/** What the palette shows for one query and tab. */
export interface PaletteView {
  /** Headings and commands in display order. */
  rows: PaletteRow[]
  /** The selectable commands in display order; a selection index points into this list. */
  entries: CommandEntry[]
  /** Matching commands per tab, for the tab labels. */
  counts: Readonly<Record<PaletteTab, number>>
  /** True for the empty query, where commands are listed under headings instead of by rank. */
  grouped: boolean
}

/**
 * Lay out the palette for the typed text. An empty query lists every command under headings: by kind (Agent, Skills, Terminal)
 * in the All tab, by {@link COMMAND_GROUPS} in the Terminal tab, and without headings in the Agent and Skills tabs. A typed
 * query keeps the {@link filterCommands} ranking without headings.
 * @param entries - available commands.
 * @param typed - composer text; a leading `/` is ignored.
 * @param tab - the active tab.
 * @returns the rows, the selectable entries and per-tab counts.
 */
export function paletteView(entries: readonly CommandEntry[], typed: string, tab: PaletteTab): PaletteView {
  const matches = filterCommands(entries, typed)
  const counts: Record<PaletteTab, number> = { all: matches.length, agent: 0, skills: 0, terminal: 0 }
  for (const entry of matches) for (const { id } of PALETTE_TABS) if (id !== 'all' && inTab(entry, id)) counts[id]++
  const shown = matches.filter(entry => inTab(entry, tab))
  const grouped = typed.replace(/^\//u, '').trim() === ''
  const rows: PaletteRow[] = []
  let next = 0
  const add = (list: readonly CommandEntry[]): void => { for (const entry of list) rows.push({ kind: 'entry', entry, index: next++ }) }
  const section = (label: string, list: readonly CommandEntry[], detail?: string): void => {
    if (list.length === 0) return
    rows.push({ kind: 'header', label, ...detail === undefined ? {} : { detail } })
    add(list)
  }
  if (!grouped || tab === 'agent' || tab === 'skills') add(shown)
  else if (tab === 'all') {
    section('AGENT', shown.filter(entry => entry.origin === 'registry'), 'from the session preset')
    section('SKILLS', shown.filter(entry => entry.origin === 'skill'), 'skills of this session')
    section('TERMINAL', shown.filter(entry => entry.origin === 'local'), 'handled by this app')
  } else {
    const order = (entry: CommandEntry): number => LOCAL_COMMANDS.findIndex(local => local.name === entry.name)
    for (const group of COMMAND_GROUPS) {
      section(group.label.toUpperCase(), shown.filter(entry => entry.group === group.id).sort((a, b) => order(a) - order(b)))
    }
    section('OTHER', shown.filter(entry => entry.group === undefined))
  }
  return { rows, entries: rows.flatMap(value => value.kind === 'entry' ? [value.entry] : []), counts, grouped }
}

/**
 * Whether the composer text is a command still being named (no input yet).
 * @param value - composer text.
 * @returns true when it starts with `/` and has no whitespace.
 */
export function isNamingCommand(value: string): boolean {
  return value.startsWith('/') && !/\s/u.test(value)
}
