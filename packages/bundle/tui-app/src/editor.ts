/**
 * Pure, grapheme-aware composer state. Display escaping never mutates a prompt.
 * `anchor` marks the other end of a mouse selection; the selection is the text
 * between it and the cursor, and editing replaces it.
 */
export interface EditorState { text: string; cursor: number; anchor?: number }
/** The key modifiers and named keys of one input event, as Ink reports them. */
export interface EditorKey {
  return?: boolean
  escape?: boolean
  tab?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  backspace?: boolean
  delete?: boolean
  home?: boolean
  end?: boolean
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/**
 * An empty draft.
 * @returns a draft with no text and the cursor at 0.
 */
export const emptyEditor = (): EditorState => ({ text: '', cursor: 0 })
/**
 * A draft with the cursor at the end of its text.
 * @param text - the draft text.
 * @returns the draft.
 */
export const editorAtEnd = (text: string): EditorState => ({ text, cursor: text.length })
/**
 * The grapheme boundary before a cursor.
 * @param text - the draft text.
 * @param cursor - a UTF-16 offset.
 * @returns the start offset of the grapheme preceding `cursor`, or 0.
 */
export function previousBoundary(text: string, cursor: number): number {
  let previous = 0
  for (const part of segmenter.segment(text)) {
    if (part.index >= cursor) break
    previous = part.index
  }
  return previous
}
/**
 * The grapheme boundary after a cursor.
 * @param text - the draft text.
 * @param cursor - a UTF-16 offset.
 * @returns the next grapheme start after `cursor`, or `text.length`.
 */
export function nextBoundary(text: string, cursor: number): number {
  for (const part of segmenter.segment(text)) if (part.index > cursor) return part.index
  return text.length
}
/**
 * The selected span of a draft.
 * @param state - the draft.
 * @returns the ordered offsets, or `undefined` when nothing is selected.
 */
export function selectionOf(state: EditorState): { start: number; end: number } | undefined {
  if (state.anchor === undefined || state.anchor === state.cursor) return undefined
  return { start: Math.min(state.anchor, state.cursor), end: Math.max(state.anchor, state.cursor) }
}
/** The draft without its selection, with the cursor where the selection began. */
function collapse(state: EditorState): EditorState {
  const range = selectionOf(state)
  return range === undefined ? { text: state.text, cursor: state.cursor } : remove(state, range.start, range.end)
}
/**
 * Inserts text at the cursor, replacing any selection; CR and CRLF become LF.
 * @param state - the draft.
 * @param text - the text to insert.
 * @returns the draft with the cursor after the inserted text.
 */
export function insertText(state: EditorState, text: string): EditorState {
  const clean = text.replace(/\r\n?/g, '\n')
  const base = collapse(state)
  return { text: base.text.slice(0, base.cursor) + clean + base.text.slice(base.cursor), cursor: base.cursor + clean.length }
}
function remove(state: EditorState, start: number, end: number): EditorState {
  return { text: state.text.slice(0, start) + state.text.slice(end), cursor: start }
}
/**
 * Moves the cursor to the same column of the adjacent logical line, snapped to a grapheme boundary.
 * @param state - the draft.
 * @param direction - -1 for up, 1 for down.
 * @returns the moved draft, or `undefined` when no line exists in that direction.
 */
export function moveLine(state: EditorState, direction: -1 | 1): EditorState | undefined {
  const start = state.cursor === 0 ? 0 : state.text.lastIndexOf('\n', state.cursor - 1) + 1
  const column = state.cursor - start
  if (direction === -1) {
    if (start === 0) return undefined
    const previous = start < 2 ? 0 : state.text.lastIndexOf('\n', start - 2) + 1
    const target = Math.min(previous + column, start - 1)
    const boundary = previousBoundary(state.text, target)
    const snapped = nextBoundary(state.text, boundary) > target ? boundary : target
    return { ...state, cursor: target === 0 ? 0 : snapped }
  }
  const end = state.text.indexOf('\n', state.cursor)
  if (end < 0) return undefined
  const next = state.text.indexOf('\n', end + 1)
  const target = Math.min(end + 1 + column, next < 0 ? state.text.length : next)
  const boundary = previousBoundary(state.text, target)
  return { ...state, cursor: nextBoundary(state.text, boundary) > target ? boundary : target }
}
/**
 * Keys owned by the editor. Submit/history/pickers are deliberately separate.
 * @param state - the draft.
 * @param input - the typed text; control characters are dropped.
 * @param key - the named keys and modifiers of the event.
 * @returns the edited draft, or `state` when the key is not an editing key.
 */
export function edit(state: EditorState, input: string, key: EditorKey): EditorState {
  const range = selectionOf(state)
  if (range !== undefined) {
    const plain = !key.ctrl && !key.meta
    if (key.backspace || key.delete) return remove(state, range.start, range.end)
    if (key.leftArrow && plain) return { text: state.text, cursor: range.start }
    if (key.rightArrow && plain) return { text: state.text, cursor: range.end }
    const newline = (key.ctrl && input === 'j') || (key.return && (key.shift || key.meta))
    const typed = plain && input !== '' && !key.return && !key.escape && !key.tab && !key.upArrow && !key.downArrow && !key.home && !key.end
    return edit(newline || typed ? collapse(state) : { text: state.text, cursor: state.cursor }, input, key)
  }
  const { text, cursor } = state
  const start = cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1
  const foundEnd = text.indexOf('\n', cursor)
  const end = foundEnd < 0 ? text.length : foundEnd
  if (key.home || (key.ctrl && input === 'a')) return { text, cursor: start }
  if (key.end || (key.ctrl && input === 'e')) return { text, cursor: end }
  if (key.ctrl && input === 'u') return remove(state, start === cursor && start > 0 ? start - 1 : start, cursor)
  if (key.ctrl && input === 'k') return remove(state, cursor, end === cursor && end < text.length ? end + 1 : end)
  if (key.ctrl && input === 'w') return remove(state, text.slice(0, cursor).replace(/\S+\s*$/u, '').length, cursor)
  if (key.leftArrow) return { text, cursor: key.ctrl || key.meta ? text.slice(0, cursor).replace(/\S+\s*$/u, '').length : previousBoundary(text, cursor) }
  if (key.rightArrow) {
    const distance = /^\s*\S+\s*/u.exec(text.slice(cursor))?.[0].length ?? 0
    return { text, cursor: key.ctrl || key.meta ? cursor + distance : nextBoundary(text, cursor) }
  }
  if (key.backspace) return remove(state, previousBoundary(text, cursor), cursor)
  if (key.delete) return remove(state, cursor, nextBoundary(text, cursor))
  if ((key.ctrl && input === 'j') || (key.return && (key.shift || key.meta))) return insertText(state, '\n')
  if (key.ctrl || key.meta || key.return || key.escape || key.tab) return state
  return input === '' ? state : insertText(state, input.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''))
}

/**
 * Keep a selected row visible while navigating a long command/session list.
 * @param items - the full list.
 * @param index - the selected index, kept near the window's middle.
 * @param size - the window length, at least 1.
 * @returns the visible slice and its offset into `items`.
 */
export function windowAround<T>(items: readonly T[], index: number, size = 8): { items: readonly T[]; offset: number } {
  const width = Math.max(1, size)
  const offset = Math.max(0, Math.min(Math.max(0, items.length - width), index - Math.floor(width / 2)))
  return { items: items.slice(offset, offset + width), offset }
}
