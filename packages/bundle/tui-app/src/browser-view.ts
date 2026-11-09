/** Asynchronous browser UI. Queries are cancellable and stale responses never replace newer results. */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { Picker, PickerRow } from './store.ts'
import { filterPicker } from './screen.ts'
import { mergeSessionSearch, type SessionSearch, type SessionPreview } from './session-browser.ts'
import { row, span, wrapRow, type Row } from './rich-text.ts'
/** Optional backend queries for the session picker; an absent query disables that feature. */
export interface BrowserActions {
  searchSessions?: (query: string, signal: AbortSignal) => Promise<SessionSearch>
  previewSession?: (id: string, signal: AbortSignal) => Promise<SessionPreview>
}
/** Picker rows plus the search and preview state that matches the current query and highlighted row. */
export interface SessionBrowserView {
  rows: PickerRow[]
  search: { query: string; result?: SessionSearch; error?: string; loading: boolean } | undefined
  preview: { id: string; result?: SessionPreview; error?: string; loading: boolean } | undefined
  offset: number
  setOffset: Dispatch<SetStateAction<number>>
}
/**
 * React hook backing the session and generic pickers. Session searches are debounced by 220 ms and previews by 100 ms; a query
 * change aborts the in-flight request.
 * @param picker - the open picker, or undefined when none is open.
 * @param query - the current filter text.
 * @param index - the highlighted row index; clamped to the filtered rows.
 * @param actions - backend queries; a missing one leaves search or preview idle.
 * @returns the filtered rows, the search and preview state matching the current query and row, and the preview scroll offset with
 *   its setter.
 */
export function useSessionBrowser(picker: Picker | undefined, query: string, index: number, actions: BrowserActions): SessionBrowserView {
  const [search, setSearch] = useState<{ query: string; result?: SessionSearch; error?: string; loading: boolean }>({ query: '', loading: false })
  const [preview, setPreview] = useState<{ id: string; result?: SessionPreview; error?: string; loading: boolean }>({ id: '', loading: false })
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    const run = actions.searchSessions
    if (picker?.kind !== 'sessions' || query.trim() === '' || run === undefined) { setSearch({ query, loading: false }); return }
    const abort = new AbortController()
    setSearch({ query, loading: true })
    const failed = (error: unknown): void => {
      if (!abort.signal.aborted) setSearch({ query, error: error instanceof Error ? error.message : String(error), loading: false })
    }
    const timer = setTimeout(() => { void run(query, abort.signal).then((result) => {
      if (!abort.signal.aborted) setSearch({ query, result, loading: false })
    }).catch(failed) }, 220)
    return () => { clearTimeout(timer); abort.abort() }
  }, [picker, query, actions.searchSessions])
  const rows = picker?.kind === 'sessions'
    ? mergeSessionSearch(picker.rows, query, search.query === query ? search.result : undefined)
    : filterPicker(picker, query)
  const id = rows[Math.min(index, Math.max(0, rows.length - 1))]?.id ?? ''
  useEffect(() => {
    setOffset(0)
    const run = actions.previewSession
    if (picker?.kind !== 'sessions' || id === '' || run === undefined) { setPreview({ id, loading: false }); return }
    const abort = new AbortController(); setPreview({ id, loading: true })
    const failed = (error: unknown): void => {
      if (!abort.signal.aborted) setPreview({ id, error: error instanceof Error ? error.message : String(error), loading: false })
    }
    const timer = setTimeout(() => { void run(id, abort.signal).then((result) => {
      if (!abort.signal.aborted) setPreview({ id, result, loading: false })
    }).catch(failed) }, 100)
    return () => { clearTimeout(timer); abort.abort() }
  }, [picker, id, actions.previewSession])
  return { rows, search: search.query === query ? search : undefined, preview: preview.id === id ? preview : undefined, offset, setOffset }
}
/**
 * Previews contain text excerpts, not a second active session or a second event subscription.
 * @param value - the preview state for the highlighted session, or undefined when none is loaded.
 * @param width - wrap width in cells.
 * @returns loading, error, empty or summary rows.
 */
export function previewRows(value: { result?: SessionPreview; loading: boolean; error?: string } | undefined, width: number): Row[] {
  if (value?.loading === true) return [row(span('Loading saved conversation…', 'muted'))]
  if (value?.error !== undefined) return wrapRow(row(span(`Preview unavailable: ${value.error}`, 'warning')), width)
  const preview = value?.result
  if (preview === undefined) return [row(span('Select a saved session to preview.', 'muted'))]
  return [ ...wrapRow(row(span(`${preview.messages} messages · ${preview.tools} tool calls`, 'accent', true)), width),
    ...wrapRow(row(span(preview.cwd, 'muted')), width), row(''), row(span('FIRST PROMPT', 'muted', true)),
    ...wrapRow(row(preview.firstPrompt || '(no user text)'), width), row(''), row(span('LAST ANSWER', 'muted', true)),
    ...wrapRow(row(preview.lastResponse || '(no assistant text)'), width) ]
}
