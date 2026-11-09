/** Text-only tool presentation, usable without React or a terminal. */
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ToolItem } from './transcript.ts'
import type { Tone } from './theme.ts'
import { lineDiff } from './diff.ts'

/** Category tag of a tool and the tone that colours it. */
export interface ToolBadgeStyle {
  tag: string
  tone: Tone
}

/**
 * Semantic colour and clear tag for each tool category (bash, edit, write, read, search, web).
 * @param name - tool name.
 * @param view - the call presentation.
 * @param result - the result presentation, when settled; a diff creating every file reads as WRITE.
 * @returns the tag and its tone; unknown tools show their own name in the accent tone.
 */
export function toolBadge(name: string, view: ToolCallView, result?: ToolResultView): ToolBadgeStyle {
  const lower = name.toLowerCase()
  if (view.card === 'terminal' || lower.includes('bash') || lower.includes('pwsh') || lower.includes('shell') || lower.includes('exec')) {
    return { tag: 'CMD', tone: 'toolBash' }
  }
  if (lower.includes('write') || lower.includes('create')) {
    return { tag: 'WRITE', tone: 'toolWrite' }
  }
  if (view.card === 'diff' || result?.card === 'diff' || view.kind === 'edit' || view.kind === 'delete' || view.kind === 'move' || lower.includes('edit') || lower.includes('replace') || lower.includes('patch')) {
    const isCreate = result?.card === 'diff' && result.diffs.length > 0 && result.diffs.every(d => d.oldText === null)
    return isCreate
      ? { tag: 'WRITE', tone: 'toolWrite' }
      : { tag: 'EDIT', tone: 'toolEdit' }
  }
  if (view.kind === 'read' || result?.card === 'read' || lower.includes('read') || lower.includes('view')) {
    return { tag: 'READ', tone: 'toolRead' }
  }
  if (view.kind === 'search' || result?.card === 'search' || lower.includes('grep') || lower.includes('glob') || lower.includes('search') || lower.includes('find')) {
    return { tag: 'SEARCH', tone: 'toolSearch' }
  }
  if (view.kind === 'fetch' || result?.card === 'web' || lower.includes('web') || lower.includes('fetch')) {
    return { tag: 'WEB', tone: 'toolWeb' }
  }
  return { tag: name.toUpperCase().slice(0, 10), tone: 'accent' }
}

/**
 * One-character icon for a tool call, chosen by result card, then by tool kind.
 * @param view - the tool call view.
 * @returns the icon.
 */
export function glyph(view: ToolCallView): string {
  if (view.card === 'terminal') return '$'
  if (view.card === 'diff') return '±'
  switch (view.kind) {
    case 'read': return '≡'
    case 'search': return '⌕'
    case 'fetch': return '⇩'
    case 'edit':
    case 'delete':
    case 'move': return '±'
    default: return '⚒'
  }
}

/**
 * Last lines of a text, ignoring one trailing newline and normalizing CRLF.
 * @param text - the text.
 * @param lines - maximum lines kept.
 * @returns the kept lines and the count of earlier lines dropped.
 */
export function tail(text: string, lines: number): { shown: string[]; hidden: number } {
  const all = text.replace(/\r\n/g, '\n').split('\n')
  if (all.at(-1) === '') all.pop()
  if (all.length <= lines) return { shown: all, hidden: 0 }
  return { shown: all.slice(-lines), hidden: all.length - lines }
}

/**
 * Plain-text account of a tool item, for the non-terminal fallback.
 * @param item - the tool item.
 * @param full - include the complete result text and diff or terminal output instead of a short preview.
 * @returns a header line, followed by result lines once the call has settled.
 */
export function formatTool(item: ToolItem, full = false): string {
  const badge = toolBadge(item.name, item.call, item.result)
  const head = `  [${badge.tag}] ${glyph(item.call)} ${item.name}${item.call.title === item.name ? '' : `  ${item.call.title}`}`
  if (!item.settled) return head
  if (item.cancelled === true) return `${head}\n      Interrupted before a tool result was received.`
  if (full) {
    const view = item.result
    const details = view?.card === 'diff' ? view.diffs.map(diff => `${diff.path}\n--- before\n${diff.oldText ?? ''}\n+++ after\n${diff.newText}`).join('\n') : view?.card === 'terminal' ? view.output ?? '' : view?.card === 'read' ? view.lines.map(line => `${line.number}: ${line.text}`).join('\n') : ''
    const body = [item.resultText ?? '', details !== item.resultText ? details : ''].filter(Boolean).join('\n')
    return `${head}\n${body}`
  }
  if (item.isError) return `${head}\n      ✗ ${(item.resultText ?? 'failed').trim().split('\n')[0] ?? ''}`
  const view: ToolResultView | undefined = item.result
  if (view?.card === 'diff') {
    return `${head}\n${view.diffs.map(diff => lineDiff(diff.oldText, diff.newText, 30).map(line => `      ${line.sign} ${line.text}`).join('\n')).join('\n')}`
  }
  if (view?.card === 'terminal') {
    const { shown } = tail(view.output ?? '', 6)
    return `${head}\n${shown.map(line => `      ${line}`).join('\n')}`
  }
  const { shown } = tail(item.resultText ?? '', 3)
  return shown.length === 0 ? head : `${head}\n${shown.map(line => `      ${line}`).join('\n')}`
}
