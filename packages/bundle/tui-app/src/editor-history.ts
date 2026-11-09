/** Local edit history, not session history. Never changes a submitted message. */
import type { EditorState } from './editor.ts'
/** Undo and redo stacks of composer states, oldest first. */
export interface UndoState { before: EditorState[]; after: EditorState[] }
/**
 * Create history with no undo or redo entries.
 * @returns a fresh, unshared history.
 */
export const emptyUndo = (): UndoState => ({ before: [], after: [] })
/**
 * Record an edit. Unchanged text leaves history as is; otherwise the redo stack is cleared and at most 100 undo entries are kept.
 * @param history - current history.
 * @param previous - the state before the edit.
 * @param next - the state after the edit.
 * @returns the updated history.
 */
export function remember(history: UndoState, previous: EditorState, next: EditorState): UndoState {
  return previous.text === next.text ? history : { before: [...history.before.slice(-99), previous], after: [] }
}
/**
 * Step back one edit.
 * @param history - current history.
 * @param current - the composer state to push onto the redo stack.
 * @returns the updated history and the restored state; unchanged when there is nothing to undo.
 */
export function undo(history: UndoState, current: EditorState): { history: UndoState; editor: EditorState } {
  const previous = history.before.at(-1)
  if (previous === undefined) return { history, editor: current }
  return { history: { before: history.before.slice(0, -1), after: [...history.after, current] }, editor: previous }
}
/**
 * Reapply one undone edit.
 * @param history - current history.
 * @param current - the composer state to push onto the undo stack.
 * @returns the updated history and the restored state; unchanged when there is nothing to redo.
 */
export function redo(history: UndoState, current: EditorState): { history: UndoState; editor: EditorState } {
  const next = history.after.at(-1)
  if (next === undefined) return { history, editor: current }
  return { history: { before: [...history.before, current], after: history.after.slice(0, -1) }, editor: next }
}
