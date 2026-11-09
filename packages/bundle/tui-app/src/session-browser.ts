/** Read-only session browser over shared search and detached Session log reads. */
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionQueryEngine, SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
type SessionInspection = SessionLogSnapshot
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { applyEvent, emptyTranscript, type Presenters } from './transcript.ts'
import type { PickerRow } from './store.ts'
import { matchScore } from './commands.ts'
/** One page of full-text search hits with a snippet per Session. */
export interface SessionSearch { items: readonly { sessionId: string; snippet: string }[]; hasMore: boolean }
/** Summary of a stored Session; prompt and response text are excerpts of at most 1800 characters. */
export interface SessionPreview {
  sessionId: string
  messages: number
  tools: number
  firstPrompt: string
  lastResponse: string
  cwd: string
  preset?: string
}
const plain: Presenters = { call(name, args) { return { card: 'generic', title: name, rawInput: args } }, result() { return undefined } }
const excerpt = (text: string): string => text.length > 1800 ? `${text.slice(0, 1800)}\n[… preview excerpt; resume to read the full message]` : text
/**
 * Replay through the existing display fold so compact/prune copies are not double-counted.
 * @param inspection - detached Session log snapshot.
 * @param id - Session id reported in the preview.
 * @returns message and tool counts plus first-prompt and last-response excerpts.
 */
export function previewFromInspection(inspection: SessionInspection, id: string): SessionPreview {
  const transcript = emptyTranscript()
  for (const event of inspection.events) applyEvent(transcript, event, plain, true)
  const users = transcript.items.filter(item => item.kind === 'user'), assistants = transcript.items.filter(item => item.kind === 'assistant')
  return { sessionId: id, cwd: inspection.session.cwd ?? '', messages: users.length + assistants.length,
    tools: transcript.items.filter(item => item.kind === 'tool').length,
    firstPrompt: excerpt(users[0]?.text ?? ''), lastResponse: excerpt(assistants.at(-1)?.text ?? '') }
}
/**
 * Search results are intersected with the already-authorized picker scope, never a second list.
 * @param rows - picker rows in scope.
 * @param query - filter text; blank returns every row.
 * @param search - full-text hits whose snippets are appended to matching rows.
 * @returns rows matching by fuzzy score or search hit, best score first.
 */
export function mergeSessionSearch(rows: readonly PickerRow[], query: string, search?: SessionSearch): PickerRow[] {
  if (query.trim() === '') return [...rows]
  const hits = new Map(search?.items.map(item => [item.sessionId, item.snippet]) ?? [])
  return rows.map(entry => ({ entry, score: Math.max(matchScore(entry.label, query), matchScore(`${entry.id} ${entry.detail}`, query) / 2), snippet: hits.get(entry.id) }))
    .filter(item => item.score >= 0 || item.snippet !== undefined)
    .sort((a, b) => b.score - a.score)
    .map(({ entry, snippet }) => snippet === undefined ? entry : { ...entry, detail: `${entry.detail} · Match: ${snippet.replace(/\s+/gu, ' ')}` })
}
/**
 * Bounded, process-local preview cache; never constructs/resumes an Agent.
 * Previews are cached for 10 seconds, at most 12 entries.
 * @param api - search provider.
 * @param query - Session log reader.
 * @returns search, cached preview, and cache clearing; each async call throws on abort.
 */
export function createSessionBrowser(api: Pick<SessionController, 'search'>, query: Pick<SessionQueryEngine, 'readSession'>): {
  search(query: string, signal: AbortSignal): Promise<SessionSearch>
  preview(id: string, signal: AbortSignal): Promise<SessionPreview>
  clear(): void
} {
  const cache = new Map<string, { at: number; value: SessionPreview }>()
  return {
    clear() { cache.clear() },
    async search(query, signal) { signal.throwIfAborted(); return api.search({ query }, signal) },
    async preview(id, signal) {
      signal.throwIfAborted()
      const hit = cache.get(id)
      if (hit !== undefined && Date.now() - hit.at < 10000) return hit.value
      const value = previewFromInspection(await query.readSession(brandString<SessionId>(id)), id)
      signal.throwIfAborted(); cache.delete(id); cache.set(id, { at: Date.now(), value })
      while (cache.size > 12) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      return value
    },
  }
}
