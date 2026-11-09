/**
 * Verbatim context pruning decided by a local Laya compactor service.
 *
 * Runs on `agent/pre-step` ahead of `compaction-basic` (registered with `prepend`). When the routed
 * request reaches `thresholdRatio` of the model context window, it sends the current surface to the
 * Laya service, which judges old tool outputs, user messages and agent messages against the current work
 * and fills a `targetRatio` budget. Spans of dropped items (balanced tool pairing, never the system prompt)
 * are replaced by one `notice` user message; truncated tool outputs and user messages keep only their
 * chosen lines, and a gap in a file `read` output names the hidden file lines and the read that restores them.
 * The latest call of each `pinnedTools` tool is never pruned. Every replacement follows a `compaction/prune`
 * shadow-price event, so all model-visible changes are logged. On any service failure nothing is replaced
 * and `compaction-basic` decides as usual; it also still runs when the pruned context stays above its own
 * threshold.
 *
 * @module @deepseek-ai/dsh-compaction-laya-pruner
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { layaRewriteProjection } from './projection.ts'
import { readLayaResponse } from './response.ts'
import type { LayaPhase } from './response.ts'
export type { LayaPhase } from './response.ts'

export { keepLinesText, layaRewriteProjection, rewriteMessageText } from './projection.ts'
export type { LayaRewriteTarget } from './projection.ts'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'

/** Plugin name. */
export const name = 'compaction-laya-pruner'

/** Required services: token pricing, model capacity, sessions. */
export const inject = ['tokenMeter', 'llm', 'sessions']

/** One judged tool output as recorded in `laya-pruner/end`. */
export interface LayaPrunerItem {
  /** Surface seq of the judged `tool/result` before replacement. */
  seq: SessionSeq
  /** One-line description of the tool call (tool name and main arguments). */
  label: string
  /** Laya decision for this output. */
  action: 'KEEP' | 'TRUNCATE' | 'DROP'
  /** Output lines before pruning. */
  lines: number
  /** Kept line ranges, 1-indexed and inclusive. */
  keepLines: Array<[number, number]>
  /** Estimated tokens before pruning. */
  tokensBefore: number
  /** Estimated tokens kept. */
  tokensAfter: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Notices (removed spans) and relays (truncated user messages) written by the Laya pruning pass.
     * Readers preserve the content without this producer; the kind only marks it as context, not a request.
     * @persistenceAttribution
     */
    'laya-pruner': { kind: 'laya-pruner' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A Laya pruning pass started — log-only, no surfaceOp.
     * @param pruneId - identity shared with the matching `laya-pruner/end`.
     * @param turn - the turn whose step boundary triggered the pass.
     * @param tokensBefore - measured request tokens before the pass.
     * @param contextWindow - routed model context window.
     */
    'laya-pruner/start': { pruneId: string; turn: number; tokensBefore: number; contextWindow: number }
    /**
     * Observed memory/worker phase of one managed pruning operation; log-only.
     * @param pruneId - identity of the matching start/end records.
     * @param turn - turn whose step boundary triggered pruning.
     * @param phase - server phase observed before the terminal result.
     */
    'laya-pruner/progress': { pruneId: string; turn: number; phase: LayaPhase }

    /**
     * A Laya pruning pass ended — log-only, no surfaceOp. `outcome: 'fallback'` means nothing was
     * replaced and the regular compaction decides; `items` lists every judged tool output.
     * @param pruneId - identity shared with the matching `laya-pruner/start`.
     * @param turn - the turn whose step boundary triggered the pass.
     * @param outcome - `pruned` when replacements landed, `fallback` otherwise.
     * @param tokensBefore - measured request tokens before the pass.
     * @param tokensAfter - measured request tokens after the pass.
     * @param ms - wall time of the pass in milliseconds.
     * @param kept - number of tool outputs kept whole.
     * @param truncated - number of tool outputs reduced to their kept lines.
     * @param dropped - number of tool outputs replaced by a one-line note.
     * @param items - every judged tool output with its decision.
     * @param error - failure reason when `outcome` is `fallback`.
     */
    'laya-pruner/end': {
      pruneId: string
      turn: number
      outcome: 'pruned' | 'fallback'
      tokensBefore: number
      tokensAfter: number
      ms: number
      kept: number
      truncated: number
      dropped: number
      items: LayaPrunerItem[]
      error?: string
    }
  }
}

/** Configuration of the Laya pruning pass. */
export interface LayaPrunerConfig {
  /** Laya compactor service base URL. */
  url?: string
  /** Exact provider/model overrides with complete compact URLs. A managed endpoint must
   * stop its temporary worker and restore model memory before responding, including errors. */
  modelEndpoints?: Array<{
    /** Provider route id matched exactly. */
    provider: string
    /** Model id matched exactly within that provider. */
    model: string
    /** Complete HTTP(S) compaction endpoint URL. */
    url: string
  }>
  /** Fraction of the context window at which the pass runs (same scale as compaction-basic). */
  thresholdRatio?: number
  /**
   * Same cap as compaction-basic: the pass also runs once the request exceeds the window minus the routed
   * output reservation and these headroom tokens, so it always fires no later than the summary compaction.
   * Keep it equal to compaction-basic's `headroomTokens` (default 65536 there too).
   */
  headroomTokens?: number
  /** Fraction of the context window the request should occupy after the pass. */
  targetRatio?: number
  /** Fraction of the context window always given to the best judged (non-pinned) items; pinned content comes on top. */
  minBudgetRatio?: number
  /** Service request timeout in milliseconds. */
  timeoutMs?: number
  /**
   * Agent reasoning kept by the pass: `last` keeps only the latest agent message's reasoning (the step in
   * progress); `open-turn` keeps all reasoning since the current user request (for APIs such as DeepSeek's
   * that require it back during a tool-call sequence).
   */
  keepReasoning?: 'last' | 'open-turn'
  /**
   * Tools whose latest call is never pruned: their call arguments carry state the agent keeps working from
   * (`todo_write` holds the whole todo list), and a step whose outputs are all dropped is removed with its calls.
   * Decisions on the latest result of each named tool are ignored and reported as KEEP.
   */
  pinnedTools?: string[]
  /**
   * `pass` runs the pruning pass; `projection` only registers the `laya-pruner/rewrite` message projection.
   * Hosts that mount the pass per session (TUI, Web) need the projection at host level so stored sessions
   * containing rewrites can be resumed before any session plugin loads.
   */
  mode?: 'pass' | 'projection'
}

/** Validated configuration schema. */
export const Config: z<LayaPrunerConfig> = z.object({
  url: z.string().default('http://127.0.0.1:8766'),
  modelEndpoints: z.array(z.object({ provider: z.string(), model: z.string(), url: z.string() })).default([]),
  thresholdRatio: z.number().min(0.01).max(1).default(0.8),
  headroomTokens: z.number().step(1).min(0).default(65536),
  targetRatio: z.number().min(0.005).max(0.9).default(0.25),
  minBudgetRatio: z.number().min(0).max(0.9).default(0.25),
  timeoutMs: z.number().step(1).min(1000).default(120000),
  keepReasoning: z.union([z.const('last'), z.const('open-turn')]).default('last'),
  pinnedTools: z.array(z.string()).default(['todo_write']),
  mode: z.union([z.const('pass'), z.const('projection')]).default('pass'),
})

interface ServiceItem {
  id: string
  kind: string
  action: 'KEEP' | 'TRUNCATE' | 'DROP'
  keep_lines: Array<[number, number]>
  lines: number
  tokens_before: number
  tokens_after: number
  label: string
}

interface ToolNode {
  seq: SessionSeq
  event: SessionEvent<'tool/result'>
  original: ToolResultMessage
  text: string
  /** A previous pass already replaced or truncated it: it can still be dropped (or its step removed), not re-truncated. */
  pruned: boolean
}

/** One service event and the surface nodes it was built from. */
interface Snapshot {
  events: Array<Record<string, unknown>>
  /** Surface seqs per service event (one message node, or the tool-result nodes of one user group). */
  eventSeqs: SessionSeq[][]
  /** Tool-call ids per assistant event. */
  callIds: string[][]
  tools: Map<string, ToolNode>
  /** Message nodes by service event index (user/assistant text messages). */
  messages: Map<number, { seq: SessionSeq; role: 'user' | 'assistant'; event: SessionEvent; text: string; pruned: boolean }>
  /** Characters of every event text and tool output (for the fixed-token estimate). */
  chars: number
  /** Index of the latest user-written message: the current request, never judged. */
  latestRequest?: number
  /** Index of the latest context message per plugin (e.g. the current runtime snapshot), never judged. */
  latestContext: Map<string, number>
  /** Agent message nodes that carry reasoning blocks, by service event index. */
  reasoning: Map<number, SessionSeq>
}

const DROP_NOTE_PREFIX = '[laya_context_pruner: output removed'
/** Common part of every gap note, generic or with a re-read pointer; marks an output as already pruned. */
const GAP_MARK = 'lines pruned by laya_context_pruner'
const GAP_NOTE = `${GAP_MARK} ...]`
/** A file `read` output (dsh-tool-fs): `<path>` header, then `N: text` lines numbered from the file. */
const READ_FILE_HEADER = /^<path>([^\n]*)<\/path>\n<type>file<\/type>\n/u
const READ_LINE_NUMBER = /^(\d+): /u
const REMOVED_NOTE_PREFIX = '[laya_context_pruner: removed'
const CHARS_PER_TOKEN = 3.5

/**
 * True when a previous pass already replaced this output or truncated it. Such an item is still judged and can
 * still be dropped, and its step removed with the call arguments (the code a `write` or `edit` carried); it is
 * never truncated again, so the gap notes of the earlier pass keep naming the right lines.
 */
function alreadyPruned(text: string): boolean {
  return text.startsWith(DROP_NOTE_PREFIX) || text.startsWith(REMOVED_NOTE_PREFIX) || text.includes(GAP_MARK)
}

/** Concatenated text of the text blocks (the text Laya judges). */
function blocksText(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
}

/**
 * One note for a removed gap. In a file `read` output it names the hidden file lines and the read that restores
 * them, so the agent can recover a needed line in one step instead of rebuilding it; `path` is set only when the
 * output shows the file path nowhere else (its `<path>` header was removed and no earlier note named it).
 */
function gapNote(removed: readonly string[], read: boolean, path: string | undefined): { text: string; pointer: boolean } {
  const numbers = removed.flatMap((line) => {
    const match = READ_LINE_NUMBER.exec(line)
    return match === null ? [] : [Number(match[1])]
  })
  const first = numbers[0]
  const last = numbers.at(-1)
  if (!read || first === undefined || last === undefined) return { text: `[... ${removed.length} ${GAP_NOTE}`, pointer: false }
  const where = `${path ?? 'file'} lines ${first}-${last}, read offset ${first} limit ${last - first + 1}`
  return { text: `[... ${removed.length} ${GAP_MARK}: ${where} ...]`, pointer: true }
}

/** Kept lines joined in order; each removed gap becomes one note line. A file read names its path exactly once. */
function keptText(text: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  const lines = text.split('\n')
  const path = READ_FILE_HEADER.exec(text)?.[1]
  const keep = new Set<number>()
  for (const [a, b] of ranges) for (let i = a; i <= b; i += 1) keep.add(i - 1)
  let pathShown = keep.has(0)
  const note = (removed: readonly string[]): string => {
    const { text: value, pointer } = gapNote(removed, path !== undefined, pathShown ? undefined : path)
    pathShown ||= pointer
    return value
  }
  const out: string[] = []
  let gap: string[] = []
  lines.forEach((line, i) => {
    if (keep.has(i)) {
      if (gap.length > 0) out.push(note(gap))
      gap = []
      out.push(line)
    } else {
      gap.push(line)
    }
  })
  if (gap.length > 0) out.push(note(gap))
  return out.join('\n')
}

/**
 * Snapshot the current surface as the service's event list, with the surface nodes behind every event.
 * @param session - session whose current surface is read.
 * @returns service events plus the node indexes used to apply decisions.
 */
const ACTIONS: ReadonlySet<string> = new Set(['KEEP', 'TRUNCATE', 'DROP'])

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate the service answer completely before anything is applied, so a malformed answer is a clean
 * fallback instead of a half-applied pass: every item needs an id, a kind, a known action, a line count and
 * 1-based inclusive ranges inside it.
 * @param body - decoded JSON response of `POST /compact`.
 * @returns the decisions.
 */
function parseItems(body: unknown): ServiceItem[] {
  const items = typeof body === 'object' && body !== null ? (body as { items?: unknown }).items : undefined
  if (!Array.isArray(items)) throw new Error('laya service answer has no items array')
  return items.map((raw: unknown, k): ServiceItem => {
    const it = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const where = `laya service item ${k}`
    if (typeof it['id'] !== 'string' || it['id'].length === 0) throw new Error(`${where}: id must be a nonempty string`)
    if (typeof it['kind'] !== 'string') throw new Error(`${where}: kind must be a string`)
    if (typeof it['action'] !== 'string' || !ACTIONS.has(it['action'])) throw new Error(`${where}: action must be KEEP, TRUNCATE or DROP`)
    if (!isCount(it['lines'])) throw new Error(`${where}: lines must be a non-negative integer`)
    const lines = it['lines']
    const ranges = it['keep_lines'] ?? []
    if (!Array.isArray(ranges)) throw new Error(`${where}: keep_lines must be an array`)
    const keep = ranges.map((range: unknown): [number, number] => {
      if (!Array.isArray(range) || range.length !== 2 || !isCount(range[0]) || !isCount(range[1])
        || range[0] < 1 || range[1] < range[0] || range[1] > lines) {
        throw new Error(`${where}: keep_lines entries must be [start, end] with 1 <= start <= end <= ${lines}`)
      }
      return [range[0], range[1]]
    })
    return {
      id: it['id'], kind: it['kind'], action: it['action'] as ServiceItem['action'], keep_lines: keep, lines,
      tokens_before: isCount(it['tokens_before']) ? it['tokens_before'] : 0,
      tokens_after: isCount(it['tokens_after']) ? it['tokens_after'] : 0,
      label: typeof it['label'] === 'string' ? it['label'] : '',
    }
  })
}

/**
 * The session surface as service events. `pending` is the input this step claimed: at the first step of a
 * turn the new request is in the pre-step payload and reaches the surface only after it, so it is appended
 * here (never judged, pinned as the current request).
 */
function snapshot(session: Session, pending: readonly UserMessage[] = []): Snapshot {
  const snap: Snapshot = {
    events: [], eventSeqs: [], callIds: [], tools: new Map(), messages: new Map(), chars: 0, latestContext: new Map(), reasoning: new Map(),
  }
  for (const seq of [...session.surface.nodes]) {
    // oxlint-disable-next-line typescript/no-deprecated -- same history read as compaction-tool-result-pruner.
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'tool/result') {
      const original = session.deriveEventMessage(event) as ToolResultMessage
      const text = blocksText(original.content)
      snap.chars += text.length
      snap.tools.set(original.toolCallId, { seq, event, original, text, pruned: alreadyPruned(text) })
      const entry = { id: original.toolCallId, text, is_error: original.isError === true }
      const last = snap.events.at(-1)
      const lastSeqs = snap.eventSeqs.at(-1)
      if (last !== undefined && lastSeqs !== undefined && last.role === 'user' && (last.text as string) === '' && (last.tool_results as unknown[]).length > 0) {
        ;(last.tool_results as unknown[]).push(entry)
        lastSeqs.push(seq)
      } else {
        snap.events.push({ role: 'user', text: '', tool_uses: [], tool_results: [entry] })
        snap.eventSeqs.push([seq])
        snap.callIds.push([])
      }
      continue
    }
    const message = session.deriveEventMessage(event)
    // System/developer instructions are never judged; tool results are handled above.
    if (message === null || (message.role !== 'user' && message.role !== 'assistant')) continue
    const text = blocksText(message.content)
    snap.chars += text.length
    const toolUses = message.content.flatMap((b) => {
      if (b.type !== 'tool-call') return []
      let input: unknown
      try {
        input = JSON.parse(b.arguments)
      } catch (error: unknown) {
        // Model-written arguments may be invalid JSON; the raw string still describes the call.
        input = { raw: b.arguments, parseError: String(error) }
      }
      return [{ id: b.id, name: b.name, input }]
    })
    const index = snap.events.length
    // A user-role message from any producer other than the user (runtime-context snapshot, notice, relay, catalog)
    // is context, not a request; its source kind keys the latest context per producer.
    const contextOf = message.role === 'user' && message.source.kind !== 'user' ? message.source.kind : undefined
    snap.events.push({
      role: message.role, text, tool_uses: toolUses, tool_results: [], ...contextOf === undefined ? {} : { context: true },
    })
    snap.eventSeqs.push([seq])
    snap.callIds.push(toolUses.map(u => u.id))
    if (event.type === 'assistant/message' && message.content.some(b => b.type === 'reasoning')) snap.reasoning.set(index, seq)
    if (contextOf !== undefined) snap.latestContext.set(contextOf, index)
    else if (message.role === 'user') snap.latestRequest = index
    if (contextOf === undefined) snap.messages.set(index, { seq, role: message.role, event, text, pruned: alreadyPruned(text) })
  }
  for (const message of pending) {
    const index = snap.events.length
    const contextOf = message.source.kind !== 'user' ? message.source.kind : undefined
    snap.events.push({ role: 'user', text: blocksText(message.content), tool_uses: [], tool_results: [], ...contextOf === undefined ? {} : { context: true } })
    snap.eventSeqs.push([])
    snap.callIds.push([])
    if (contextOf !== undefined) snap.latestContext.set(contextOf, index)
    else snap.latestRequest = index
  }
  for (const index of [snap.latestRequest, ...snap.latestContext.values()]) {
    const pinned = index === undefined ? undefined : snap.events[index]
    if (index === undefined || pinned === undefined) continue
    pinned.pinned = true
    snap.messages.delete(index)
  }
  return snap
}

/** Group surface seqs into maximal runs of consecutive current surface nodes. */
function contiguousRuns(session: Session, seqs: ReadonlySet<SessionSeq>): SessionSeq[][] {
  const runs: SessionSeq[][] = []
  let run: SessionSeq[] = []
  for (const seq of session.surface.nodes) {
    if (seqs.has(seq)) {
      run.push(seq)
    } else if (run.length > 0) {
      runs.push(run)
      run = []
    }
  }
  if (run.length > 0) runs.push(run)
  return runs
}

/**
 * Register the Laya pruning pass ahead of the regular compaction.
 * @param ctx - plugin context.
 * @param config - pass configuration.
 */
export function apply(ctx: Context, config: LayaPrunerConfig): void {
  const cfg = Config(config) as Required<LayaPrunerConfig>
  const url = cfg.url.replace(/\/$/, '')
  for (const endpoint of cfg.modelEndpoints) {
    const parsed = new URL(endpoint.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Laya endpoint requires HTTP(S)')
    if (cfg.modelEndpoints.filter(item => item.provider === endpoint.provider && item.model === endpoint.model).length !== 1) {
      throw new Error(`Duplicate Laya endpoint for ${endpoint.provider}/${endpoint.model}`)
    }
  }
  // One definition per store. Another instance (the host-level `projection` row, or another session's pass)
  // may own it; when that owner is disposed this instance registers it again before it next needs it.
  const ensureProjection = (): void => {
    if (!ctx.sessions.messageProjections.includes(layaRewriteProjection)) ctx.sessions.registerMessageProjection(layaRewriteProjection)
  }
  ensureProjection()
  if (cfg.mode === 'projection') return

  async function prune(agent: Agent, turn: number, signal: AbortSignal, pending: readonly UserMessage[]): Promise<void> {
    const session = agent.session
    const header = session.requestHeader()?.config
    if (header === undefined || header.provider.length === 0 || header.model.length === 0) return
    const info = await ctx.llm.resolveModelInfo(header.provider, header.model, signal)
    const contextWindow = info.context?.contextWindow
    if (contextWindow === undefined) return
    // compaction-basic's trigger: min(ratio x window, window - reserved output - headroom).
    const reserved = header.maxTokens ?? info.defaultMaxTokens ?? 0
    const threshold = Math.floor(Math.min(contextWindow * cfg.thresholdRatio, contextWindow - reserved - cfg.headroomTokens))
    const tokensBefore = ctx.tokenMeter.measure(session).totalTokens
    if (tokensBefore < threshold) return

    ensureProjection()
    const pruneId = randomUUID()
    const t0 = Date.now()
    session.append('laya-pruner/start', { pruneId, turn, tokensBefore, contextWindow })
    const finish = (data: Omit<SessionEventMapEnd, 'pruneId' | 'turn' | 'ms'>): void => {
      session.append('laya-pruner/end', { pruneId, turn, ms: Date.now() - t0, ...data })
    }
    const empty = { kept: 0, truncated: 0, dropped: 0, items: [] }

    const snap = snapshot(session, pending)
    let items: ServiceItem[]
    try {
      const endpoint = cfg.modelEndpoints.find(item => item.provider === header.provider && item.model === header.model)
      const response = await fetch(endpoint?.url ?? `${url}/compact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: snap.events,
          target_tokens: Math.floor(contextWindow * cfg.targetRatio),
          fixed_tokens: Math.max(0, tokensBefore - Math.round(snap.chars / CHARS_PER_TOKEN)),
          min_budget_tokens: Math.floor(contextWindow * cfg.minBudgetRatio),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]),
      })
      if (!response.ok) throw new Error(`laya service HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
      items = parseItems(await readLayaResponse(response, (phase) => {
        session.append('laya-pruner/progress', { pruneId, turn, phase })
      }))
    } catch (error: unknown) {
      finish({ outcome: 'fallback', tokensBefore, tokensAfter: tokensBefore, ...empty, error: error instanceof Error ? error.message : String(error) })
      return
    }

    // The latest call of each pinned tool keeps its result, so its step (and the call arguments) is never removed.
    const latestPinned = new Map<string, string>()
    for (const ev of snap.events) {
      for (const use of ev.tool_uses as Array<{ id: string; name: string }>) {
        if (cfg.pinnedTools.includes(use.name)) latestPinned.set(use.name, use.id)
      }
    }
    const pinnedCalls = new Set(latestPinned.values())
    const pinned = (it: ServiceItem): boolean => it.kind === 'tool' && pinnedCalls.has(it.id)

    // Index decisions by tool-call id and by message event index ("m<index>" ids from the service).
    const toolDecision = new Map<string, ServiceItem>()
    const messageDecision = new Map<number, ServiceItem>()
    for (const it of items) {
      if (pinned(it)) continue
      if (it.kind === 'tool') toolDecision.set(it.id, it)
      else if (it.id.startsWith('m')) messageDecision.set(Number(it.id.slice(1)), it)
    }

    // Spans to remove: dropped user messages; dropped assistant messages together with their tool calls'
    // results when every one of those outputs is dropped too; and call-only assistant steps whose outputs
    // are all dropped (the call no longer matters either).
    const removeSeqs = new Set<SessionSeq>()
    snap.events.forEach((ev, index) => {
      const msg = snap.messages.get(index)
      const decision = messageDecision.get(index)
      if (ev.role === 'user' && msg !== undefined && decision?.action === 'DROP') {
        removeSeqs.add(msg.seq)
        return
      }
      if (ev.role !== 'assistant') return
      const calls = snap.callIds[index] ?? []
      const outputs = calls.map(id => snap.tools.get(id))
      const allDropped = calls.length > 0 && calls.every(id => snap.tools.has(id) && toolDecision.get(id)?.action === 'DROP')
      const text = ev.text as string
      const textless = text.trim().length === 0 || (msg !== undefined && decision === undefined && text.length < 200)
      const textDropped = msg !== undefined && decision?.action === 'DROP'
      if ((calls.length === 0 && textDropped) || (calls.length > 0 && allDropped && (textDropped || textless))) {
        const first = snap.eventSeqs[index]?.[0]
        if (first !== undefined) removeSeqs.add(first)
        for (const node of outputs) if (node !== undefined) removeSeqs.add(node.seq)
      }
    })

    // Past agent reasoning is resent to the model on every request and never judged; it is dropped in the same
    // pass. Kept: only the latest agent message's reasoning (`last`), or the whole open turn (`open-turn`).
    const latestAgent = snap.events.findLastIndex(ev => ev.role === 'assistant')
    const keepFrom = cfg.keepReasoning === 'open-turn' ? (snap.latestRequest ?? 0) : latestAgent
    const closedReasoning = (): SessionSeq[] => [...snap.reasoning].filter(([index, seq]) =>
      index < keepFrom && !removeSeqs.has(seq) && session.surface.nodes.includes(seq)).map(([, seq]) => seq)

    // What the pass really did, per judged node (decisions that could not be applied are reported as KEEP).
    const applied = new Map<SessionSeq, 'TRUNCATE' | 'DROP'>()
    const seqOf = (it: ServiceItem): SessionSeq | undefined =>
      it.kind === 'tool' ? snap.tools.get(it.id)?.seq : snap.messages.get(Number(it.id.slice(1)))?.seq
    const report = (): LayaPrunerItem[] => items.flatMap((it) => {
      const seq = seqOf(it)
      if (seq === undefined) return []
      const action = applied.get(seq) ?? 'KEEP'
      return [{ seq, label: it.label, action, lines: it.lines, keepLines: action === 'TRUNCATE' ? it.keep_lines : action === 'KEEP' ? [[1, it.lines]] : [],
        tokensBefore: it.tokens_before, tokensAfter: action === 'DROP' ? 0 : action === 'KEEP' ? it.tokens_before : it.tokens_after }]
    })

    // Decisions on unknown or pinned ids are ignored.
    if (items.every(it => it.action === 'KEEP' || pinned(it) || seqOf(it) === undefined)) {
      const reasoning = closedReasoning()
      if (reasoning.length > 0) {
        session.append('laya-pruner/rewrite', { targets: reasoning.map(seq => ({ seq, dropReasoning: true })) })
        const judged = report()
        finish({ outcome: 'pruned', tokensBefore, tokensAfter: ctx.tokenMeter.measure(session).totalTokens, kept: judged.length, truncated: 0, dropped: 0, items: judged })
        return
      }
      const judged = report()
      finish({ outcome: 'fallback', tokensBefore, tokensAfter: tokensBefore, kept: judged.length, truncated: 0, dropped: 0, items: judged,
        error: 'nothing to prune (only pinned recent items)' })
      return
    }

    // 1) Remove whole spans (balanced at both edges, never the system prompt at node 0). A span that cannot be
    //    removed returns to the in-place path below, so its tool outputs are still replaced by drop notes.
    const head = session.surface.nodes[0]
    for (const run of contiguousRuns(session, removeSeqs)) {
      const start = run[0]
      const end = run.at(-1)
      if (start === undefined || end === undefined || start === head
        || !toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
        for (const seq of run) removeSeqs.delete(seq)
        continue
      }
      let price = 0
      let messages = 0
      let calls = 0
      for (const seq of run) {
        // oxlint-disable-next-line typescript/no-deprecated -- same history read as compaction-tool-result-pruner.
        const event = session.eventAt(seq)
        if (event === undefined) continue
        const message = session.deriveEventMessage(event)
        if (message !== null) price += ctx.tokenMeter.estimateMessage(message)
        if (event.type === 'tool/result') calls += 1
        else messages += 1
      }
      const summary = `removed ${messages} earlier message(s) and ${calls} tool output(s) not needed for the current work`
      const placeholder = createUserMessage({
        content: [{
          type: 'text',
          text: `${REMOVED_NOTE_PREFIX} ${messages} earlier message(s) and ${calls} tool output(s) that are no longer relevant to the current task]`,
        }],
        source: { kind: 'laya-pruner', form: 'notice', summary: boundContextSummary(`laya_context_pruner ${summary}`) },
      })
      session.append('compaction/prune', { shadowedRange: { start, end }, shadowedSeqs: [...run], shadowedTokenCount: price })
      session.append('user/message', placeholder, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [...run] })
      for (const seq of run) applied.set(seq, 'DROP')
    }

    // 2) Rewrite the remaining truncated/dropped tool outputs and truncated (or unremovable dropped) user
    //    messages in place; truncated agent messages are collected for one `laya-pruner/rewrite` projection.
    const rewrites: LayaRewriteTargetLocal[] = []
    for (const it of items) {
      if (it.action === 'KEEP' || pinned(it)) continue
      if (it.kind === 'tool') {
        const node = snap.tools.get(it.id)
        if (node === undefined || removeSeqs.has(node.seq) || !session.surface.nodes.includes(node.seq)) continue
        if (node.pruned && it.action === 'TRUNCATE') continue
        const text = it.action === 'DROP' ? `${DROP_NOTE_PREFIX} (${it.lines} lines); re-run the tool if needed]` : keptText(node.text, it.keep_lines)
        if (text === node.text) continue
        const content: ContentBlock[] = [{ type: 'text', text }, ...node.original.content.filter(b => b.type !== 'text')]
        const message = freezeMessage<ToolResultMessage>({ ...node.original, content })
        // Shadow-price protocol (see compaction/prune): the replacement follows synchronously.
        session.append('compaction/prune', {
          shadowedRange: { start: node.seq, end: node.seq },
          shadowedSeqs: [node.seq],
          shadowedTokenCount: ctx.tokenMeter.estimateMessage(node.original),
        })
        session.append('tool/result', { ...node.event.data, message }, {
          surfaceOp: { op: 'replace', startSeq: node.seq, endSeq: node.seq },
          sourceEventSeqs: [node.seq],
        })
        applied.set(node.seq, it.action)
        continue
      }
      const msg = snap.messages.get(Number(it.id.slice(1)))
      if (msg === undefined || removeSeqs.has(msg.seq) || !session.surface.nodes.includes(msg.seq)) continue
      if (msg.pruned && it.action === 'TRUNCATE') continue
      if (msg.role === 'assistant') {
        if (it.action === 'TRUNCATE' && it.keep_lines.length > 0) {
          rewrites.push({ seq: msg.seq, keepLines: it.keep_lines })
          applied.set(msg.seq, 'TRUNCATE')
        }
        continue
      }
      const original = session.deriveEventMessage(msg.event)
      if (original === null) continue
      const text = it.action === 'DROP' || it.keep_lines.length === 0
        ? `${REMOVED_NOTE_PREFIX} an earlier user message (${it.lines} lines) not needed for the current work]`
        : keptText(msg.text, it.keep_lines)
      if (text === msg.text) continue
      const replacement = createUserMessage({
        content: [{ type: 'text', text }, ...original.content.filter(b => b.type !== 'text')],
        source: { kind: 'laya-pruner', form: 'relay' },
      })
      session.append('compaction/prune', {
        shadowedRange: { start: msg.seq, end: msg.seq },
        shadowedSeqs: [msg.seq],
        shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
      })
      session.append('user/message', replacement, { surfaceOp: { op: 'replace', startSeq: msg.seq, endSeq: msg.seq }, sourceEventSeqs: [msg.seq] })
      applied.set(msg.seq, it.action)
    }

    const reasoning = closedReasoning()
    for (const seq of reasoning) {
      const target = rewrites.find(r => r.seq === seq)
      if (target !== undefined) target.dropReasoning = true
      else rewrites.push({ seq, dropReasoning: true })
    }
    if (rewrites.length > 0) session.append('laya-pruner/rewrite', { targets: rewrites })

    const judged = report()
    const counts = {
      kept: judged.filter(j => j.action === 'KEEP').length,
      truncated: judged.filter(j => j.action === 'TRUNCATE').length,
      dropped: judged.filter(j => j.action === 'DROP').length,
    }
    if (applied.size === 0 && reasoning.length === 0) {
      finish({ outcome: 'fallback', tokensBefore, tokensAfter: tokensBefore, ...counts, items: judged, error: 'no decision could be applied' })
      return
    }
    finish({ outcome: 'pruned', tokensBefore, tokensAfter: ctx.tokenMeter.measure(session).totalTokens, ...counts, items: judged })
  }

  ctx.on('agent/pre-step', async ({ agent, turn, signal, messages }, next): Promise<PreStepDecision> => {
    if (!signal.aborted) {
      try {
        await prune(agent, turn, signal, messages)
      } catch (error: unknown) {
        // The regular compaction still runs after next(); log and continue the turn.
        ctx.logger.warn(`laya pruning failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return next()
  }, { prepend: true })
}

type LayaRewriteTargetLocal = import('./projection.ts').LayaRewriteTarget
type SessionEventMapEnd = import('@deepseek-ai/dsh-session/types').SessionEventMap['laya-pruner/end']
