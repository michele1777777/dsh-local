/** Session discovery uses the same authorized, activity-sorted list as Web. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { shorten } from './terminal.ts'

/** A resumable Session as listed by the terminal. */
export interface Candidate { id: SessionId; updatedAt: number; label: string; cwd: string; running: boolean }
/**
 * Resumable Sessions from controller summaries; subagent, blank and cwd-less Sessions are excluded.
 * @param rows - session summaries.
 * @param cwd - the working directory to match.
 * @param all - include Sessions from every directory.
 * @returns candidates, most recently updated first, ties by id.
 */
export function candidatesFromSummaries(rows: readonly SessionSummary[], cwd: string, all = false): Candidate[] {
  return rows
    .filter(row => row.origin !== 'subagent' && row.cwd !== undefined && (all || row.cwd === cwd) && !row.blank)
    .map(row => ({
      id: row.sessionId, updatedAt: row.updatedAt, cwd: row.cwd ?? '', running: row.running,
      label: typeof row.projections?.values.title === 'string' ? row.projections.values.title : '(untitled session)',
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt || String(a.id).localeCompare(String(b.id)))
}
/**
 * List resumable Sessions through the session controller.
 * @param ctx - context providing `sessionController`.
 * @param cwd - the working directory to match.
 * @param all - include Sessions from every directory.
 * @param signal - cancels the list request.
 * @returns candidates as {@link candidatesFromSummaries} orders them.
 */
export async function listCandidates(ctx: Context, cwd: string, all = false, signal = new AbortController().signal): Promise<Candidate[]> {
  return candidatesFromSummaries((await ctx.sessionController.list({}, signal)).items, cwd, all)
}
/**
 * The most recently updated resumable Session.
 * @param ctx - context providing `sessionController`.
 * @param cwd - the working directory to match.
 * @param all - include Sessions from every directory.
 * @returns its id, or undefined when there is none.
 */
export async function mostRecent(ctx: Context, cwd: string, all = false): Promise<SessionId | undefined> {
  return (await listCandidates(ctx, cwd, all))[0]?.id
}
/**
 * Exact identity wins. Prefixes and titles are accepted only when unambiguous.
 * @param candidates - Sessions to search.
 * @param input - a session id, id prefix or case-insensitive title.
 * @returns the matching candidate, or undefined when none matches.
 * @throws Error when more than one candidate matches.
 */
export function resolveCandidate(candidates: readonly Candidate[], input: string): Candidate | undefined {
  const exact = candidates.find(row => row.id === input)
  if (exact !== undefined) return exact
  const matches = candidates.filter(row => String(row.id).startsWith(input) || row.label.toLowerCase() === input.toLowerCase())
  if (matches.length > 1) throw new Error(`Ambiguous session “${input}”. Use the full session ID or the picker.`)
  return matches[0]
}
/**
 * Numbered two-line plain-text entries for a session list.
 * @param candidates - Sessions to list.
 * @returns one entry per candidate: time, title and running state, then id and cwd.
 */
export function formatCandidates(candidates: readonly Candidate[]): string[] {
  return candidates.map((row, index) => `${index + 1}. ${new Date(row.updatedAt).toLocaleString()}  ${shorten(row.label)}${row.running ? ' · running' : ''}\n   ${row.id}  ${row.cwd}`)
}
