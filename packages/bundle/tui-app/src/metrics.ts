/** Read only the same host projections exposed to Web. No token estimator. */
import type { LayaPhase } from '@deepseek-ai/dsh-compaction-laya-pruner'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { UiAction } from './actions.ts'
import type { ChatState } from './store.ts'
import { tokens } from './terminal.ts'
/**
 * View a projection value as a field map.
 * @param value - any projection value.
 * @returns the value when it is a non-array object, otherwise an empty object.
 */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
/**
 * A finite, non-negative number from a projection field.
 * @param value - any projection field.
 * @returns the number, or undefined for anything else.
 */
export const nonnegative = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
/**
 * Context-window usage from the `contextPressure` projection.
 * @param projections - host projections.
 * @param projections.contextPressure - projected or pressure tokens and the context window.
 * @returns known token counts, their ratio when both are known, and a status label.
 */
export function contextReading(projections: ChatState['projections']): { used?: number; maximum?: number; ratio?: number; label: string } {
  const pressure = record(projections.contextPressure)
  const used = nonnegative(pressure.projectedTokens) ?? nonnegative(pressure.pressureTokens)
  const maximum = nonnegative(pressure.contextWindow)
  if (used === undefined) return { ...(maximum === undefined ? {} : { maximum }), label: maximum === undefined ? 'ctx —' : `ctx —/${tokens(maximum)}` }
  if (maximum === undefined || maximum === 0) return { used, label: `ctx ~${tokens(used)}` }
  const ratio = used / maximum
  return { used, maximum, ratio, label: `ctx ~${Math.round(ratio * 100)}% · ${tokens(used)}/${tokens(maximum)}` }
}
/**
 * Prefill and decode throughput over the latest model responses: summed tokens over summed wall time, so long responses
 * weigh more than short ones.
 * @param transcript - the transcript holding the speed samples.
 * @returns tokens per second for each phase; a phase is omitted when no sample measured it.
 */
export function recentSpeed(transcript: ChatState['transcript']): { prefill?: number; decode?: number } {
  const samples = transcript.speedSamples ?? []
  const rate = (pairs: readonly (readonly [number, number])[]): number | undefined => {
    const measured = pairs.filter(([tokens, ms]) => tokens > 0 && ms > 0)
    const ms = measured.reduce((sum, [, value]) => sum + value, 0)
    return ms === 0 ? undefined : measured.reduce((sum, [tokens]) => sum + tokens, 0) * 1000 / ms
  }
  const prefill = rate(samples.map(sample => [sample.prefillTokens, sample.prefillMs] as const))
  const decode = rate(samples.map(sample => [sample.decodeTokens, sample.decodeMs] as const))
  return { ...prefill === undefined ? {} : { prefill }, ...decode === undefined ? {} : { decode } }
}

/**
 * Decode throughput and mean time to first token from the `sessionStats` projection.
 * @param projections - host projections.
 * @param projections.sessionStats - accumulated decode and TTFT totals.
 * @returns tokens per second and mean TTFT in ms; each is omitted when its totals are missing or zero.
 */
export function speedReading(projections: ChatState['projections']): { decode?: number; ttftMs?: number } {
  const stats = record(projections.sessionStats)
  const decodeMs = nonnegative(stats.decodeMs), decodeTokens = nonnegative(stats.decodeTokens)
  const ttftMs = nonnegative(stats.ttftMs), ttftSteps = nonnegative(stats.ttftSteps)
  return { ...(decodeMs === undefined || decodeMs === 0 || decodeTokens === undefined ? {} : { decode: decodeTokens * 1000 / decodeMs }),
    ...(ttftMs === undefined || ttftSteps === undefined || ttftSteps === 0 ? {} : { ttftMs: ttftMs / ttftSteps }) }
}
/**
 * Short elapsed-time label.
 * @param ms - milliseconds.
 * @returns `—` for negative or non-finite input, otherwise `ms`, `s` or `m s` units.
 */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1000)}s`
}
/**
 * What a running `laya_context_pruner` pass is doing, for the status line and the live pruning row.
 * @param phase - the pass's latest reported phase; a pass without phase is pruning.
 * @returns the phase label.
 */
export function layaPhaseLabel(phase: LayaPhase | undefined): string {
  switch (phase) {
    case 'release': return 'DS4 · freeing cache memory'
    case 'start': return 'Starting Laya'
    case 'stop': return 'Stopping Laya'
    case 'restore': return 'DS4 · restoring cache capacity'
    case 'prune': case undefined: return 'laya_context_pruner · pruning context'
    default: return assertNever(phase, 'Laya phase')
  }
}
/**
 * Whether a pass in this phase is pruning. A pass without phase reports cuts from its start; release, start, stop and restore
 * manage the model.
 * @param phase - the pass's latest reported phase.
 * @returns true for `prune` and for no phase.
 */
export function layaCutting(phase: LayaPhase | undefined): boolean {
  return phase === undefined || phase === 'prune'
}
/**
 * The status-line activity label; pending interactions outrank compaction, busy text and turn progress. Background jobs are
 * not part of it: the status line counts them separately.
 * @param state - chat state.
 * @returns the label.
 */
export function activity(state: ChatState): string {
  if (state.exiting) return 'Saving sessions…'
  if (state.pending[0]?.kind === 'approval') return 'Permission required'
  if (state.pending[0]?.kind === 'question') return 'Your answer is needed'
  if ((state.reviewingApprovals ?? 0) > 0) return `Reviewing permission · ${state.reviewingApprovals} isolated request(s)`
  if (state.transcript.layaPruning === true) return layaPhaseLabel(state.transcript.layaPhase)
  if (state.transcript.compacting) return 'Compacting context'
  if (state.busy !== undefined) return state.busy
  if (state.status !== 'running') return 'Ready'
  const active = state.transcript.items.filter(item => !item.settled)
  const tools = active.filter(item => item.kind === 'tool')
  const last = active.at(-1)
  return tools.length > 0 ? `${tools.length} tool${tools.length === 1 ? '' : 's'} running` : last?.kind === 'assistant' ? (last.text !== '' ? 'Responding' : last.reasoning !== '' ? 'Thinking' : 'Waiting for model') : 'Waiting for model'
}
/**
 * Wall time of the work in progress: from the latest admitted human message, or from the turn start when no message started it.
 * @param state - chat state.
 * @param now - current time in ms.
 * @returns the elapsed milliseconds while a turn runs, otherwise undefined.
 */
export function workElapsed(state: ChatState, now: number): number | undefined {
  if (state.status !== 'running') return undefined
  const started = state.transcript.workStartedAt ?? state.transcript.turnStartedAt
  return started === undefined ? undefined : Math.max(0, now - started)
}
/**
 * One entry of the indicator row under the header: a glyph in the brand tone, a muted label, and optional muted detail.
 * `warning` marks a blocked goal only; an `action` makes the entry a click target.
 */
export interface SessionIndicator { glyph: string; label: string; detail?: string; tone: 'muted' | 'warning'; action?: UiAction }
/**
 * The goal's lifecycle as the reader sees it; a disarmed active goal waits for `/goal resume`.
 * @param state - chat state.
 * @returns the phase label, `saved` when the goal has none, or undefined without a goal.
 */
export function goalPhase(state: ChatState): string | undefined {
  const goal = record(record(state.projections.goal).goal)
  if (typeof goal.objective !== 'string') return undefined
  return goal.phase === 'active' && state.goalActivation === 'disarmed' ? 'ready to resume' : (typeof goal.phase === 'string' ? goal.phase : 'saved')
}
/**
 * Indicators from durable Goal/Plan/Todo values only; goal activation affects only the goal's detail. The goal names its
 * objective's first line and shows its phase only when it is not running: a paused or disarmed goal says how to resume it.
 * @param state - chat state.
 * @returns goal, plan and task entries in that order, each present only when its projection has content.
 */
export function sessionIndicators(state: ChatState): SessionIndicator[] {
  const values: SessionIndicator[] = []
  const goal = record(record(state.projections.goal).goal), phase = goalPhase(state)
  if (typeof goal.objective === 'string' && phase !== undefined) {
    // The first line names the goal; the full objective lives in the goal panel.
    const title = goal.objective.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
    const detail = phase === 'active' ? undefined : phase === 'ready to resume' || phase === 'paused' ? 'paused · /goal resume' : phase
    values.push({ glyph: '◎', label: title, ...detail === undefined ? {} : { detail }, tone: phase === 'blocked' ? 'warning' : 'muted', action: { kind: 'open-goal' } })
  }
  const plan = record(state.projections.plan)
  if (plan.active === true || plan.pending === true) {
    values.push({ glyph: '▣', label: plan.pending === true ? (plan.active === true ? 'leaving plan…' : 'entering plan…') : 'plan', tone: 'muted', action: { kind: 'open-tasks' } })
  }
  const todos = Array.isArray(state.projections.todos) ? state.projections.todos.map(record) : []
  if (todos.length > 0) {
    const done = todos.filter(task => task.status === 'completed').length
    values.push({ glyph: '☐', label: `${done}/${todos.length} tasks`, tone: 'muted', action: { kind: 'open-tasks' } })
  }
  return values
}
