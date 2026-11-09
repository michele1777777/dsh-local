/** Isolated same-model approval answerer shared by Web and TUI. Manual remains the default. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands'
// Session-event augmentations for the revision counter below: the sandbox mode
// and the routed model are declared by the packages that own those events.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SMART_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest, ApprovalReview } from '@deepseek-ai/dsh-user-approval'
import { buildReviewInput, eligibleRequest } from './context.ts'
import { staticDecision } from './policy.ts'
import type { ReviewDecision } from './protocol.ts'
import { readDecision, reviewOptions } from './reviewer.ts'

/** Host-configured review limits; none change the main agent's model configuration. */
export interface Config {
  /** Maximum reviewer wall time before human fallback, in milliseconds. */
  timeoutMs?: number
  /** Maximum complete JSON input length in JavaScript characters. */
  maxInputChars?: number
  /** Maximum serialized response length, including reasoning and metadata. */
  maxOutputChars?: number
  /** Provider output-token limit for the independent reviewer. */
  maxOutputTokens?: number
  /** Maximum unsettled reviewer transports in the host process. */
  maxConcurrentReviews?: number
  /** Exact tool names denied only when they request Smart approval. */
  deniedTools?: string[]
  /** Exact tool names whose permission requests remain human-owned. */
  humanOnlyTools?: string[]
  /**
   * Exact tool names whose every call requests `danger-full-access` from inside
   * its body, without a `sandbox_permissions` argument (`plugin_manager`).
   * Their requests are reviewed like any other escalation; absent names stay human-owned.
   */
  escalatingTools?: string[]
}

/** Configuration is local to the host and never read from model-authored files. */
export const Config: z<Config> = z.object({
  timeoutMs: z.natural().min(1).default(20000),
  maxInputChars: z.natural().min(1).default(48000),
  maxOutputChars: z.natural().min(1).default(48000),
  maxOutputTokens: z.natural().min(1).default(4096),
  maxConcurrentReviews: z.natural().min(1).default(2),
  deniedTools: z.array(z.string()).default([]),
  humanOnlyTools: z.array(z.string()).default(['run_code']),
  escalatingTools: z.array(z.string()).default([]),
})

/** Shared plugin identity. */
export const name = 'smart-approval'
/** All services must exist before Smart becomes selectable. */
export const inject = ['approval', 'permissionPresets', 'llm', 'sessions', 'tools']

/** Live status used by terminal presentation; the audit lives in approval/decided. */
export interface ReviewStatus {
  agent: Agent
  toolName: string
  reviewing: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An isolated reviewer started or settled; never a model-facing message.
     * @param status - owning agent, operation, and current review state.
     * @mode emit
     */
    'smart-approval/status'(status: ReviewStatus): void
  }
}

/** Validate direct plugin construction as well as Loader's schema-normalized path. */
function resolveConfig(config: Config): Required<Config> {
  const resolved = {
    timeoutMs: config.timeoutMs ?? 20000,
    maxInputChars: config.maxInputChars ?? 48000,
    maxOutputChars: config.maxOutputChars ?? 48000,
    maxOutputTokens: config.maxOutputTokens ?? 4096,
    maxConcurrentReviews: config.maxConcurrentReviews ?? 2,
    deniedTools: config.deniedTools ?? [],
    humanOnlyTools: config.humanOnlyTools ?? ['run_code'],
    escalatingTools: config.escalatingTools ?? [],
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)) {
      throw new Error(`smart-approval: ${key} must be a positive, bounded integer`)
    }
  }
  return resolved
}

/** Read the bounded tail of the existing permission audit, including machine recommendations. */
function auditText(session: Session): string {
  const rows: string[] = []
  for (let index = session.seq - 1; index >= 0 && rows.length < 20; index -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Machine-review audit fields have no public projection yet.
    const event = session.eventAt(SessionSeq(index))
    if (event?.type !== 'approval/decided' || event.data.review === undefined) continue
    const review = event.data.review
    rows.push(`${new Date(event.time).toISOString()} · ${review.source} · ${review.decision} → ${event.data.outcome} · ${review.durationMs}ms · ${review.reason}`)
  }
  return rows.reverse().join('\n') || 'No Smart approval decisions are recorded in this session.'
}

/**
 * Install an approval answerer without replacing tools, admission, sandboxing, or agent request assembly.
 * @param ctx - shared host context, independent of the UI surface.
 * @param config - host-reviewed limits and exact tool restrictions.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = resolveConfig(config)
  const permissions = ctx.permissionPresets
  const approval = ctx.approval
  const lifetime = new AbortController()
  let accepting = true
  const live = new WeakMap<Agent, Map<string, ToolExecution>>()
  const revisions = new WeakMap<Session, number>()
  const transports = new Set<Promise<ReviewDecision>>()

  // A UI callback cannot turn a failed review into an approval or starve teardown.
  const status = (request: ApprovalRequest, reviewing: boolean): void => {
    try {
      ctx.emit('smart-approval/status', { agent: request.agent, toolName: request.toolName, reviewing })
    } catch (error: unknown) {
      ctx.logger.warn(`smart-approval status listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const answer = async (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    const agent = request.agent
    if (permissions.current(agent.session) !== SMART_PRESET) return next()
    if (!accepting || request.signal?.aborted || lifetime.signal.aborted) return 'cancelled'
    const started = Date.now()
    const revision = revisions.get(agent.session) ?? 0
    const audit = (source: ApprovalReview['source'], decision: ReviewDecision, route?: { provider: string; model: string }): void => {
      approval.recordReview(request, {
        source,
        decision: decision.decision,
        reason: decision.reason,
        durationMs: Math.max(0, Date.now() - started),
        ...route === undefined ? {} : route,
      })
    }
    const human = (reason: string): Promise<ApprovalOutcome> => {
      audit('fallback', { decision: 'ask', risk: 'medium', reason })
      return next()
    }
    if (limits.deniedTools.includes(request.toolName)) {
      audit('policy', { decision: 'deny', risk: 'high', reason: 'This tool is denied by the host Smart approval policy.' })
      return 'rejected'
    }
    const exec = request.callId === undefined ? undefined : live.get(agent)?.get(request.callId)
    // Explicit hook asks, untracked calls and unknown permission semantics stay human-owned.
    if (!eligibleRequest(request, exec, limits.escalatingTools)) return human('This question is not a recognized, exact sandbox-escalation request.')
    const rule = staticDecision({ name: exec.name, arguments: exec.arguments, cwd: agent.session.header.cwd ?? '' }, limits)
    if (rule !== undefined) {
      audit('policy', rule)
      return rule.decision === 'deny' ? 'rejected' : next()
    }
    let input: ReturnType<typeof buildReviewInput>
    try { input = buildReviewInput(agent, exec, request, limits.maxInputChars) }
    catch (_error: unknown) { return human('The complete action, authorized context, or model route could not be safely established within the input limit.') }
    if (transports.size >= limits.maxConcurrentReviews) return human('The isolated reviewer is busy; human confirmation is required.')

    const deadline = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, exec.signal, deadline.signal, ...request.signal === undefined ? [] : [request.signal]])
    const timeout = setTimeout(() => { deadline.abort(new Error('Smart review timed out')) }, limits.timeoutMs)
    const options = reviewOptions(input, limits, signal)
    const transport = Promise.resolve().then(() => readDecision(ctx.llm.stream(options), limits.maxOutputChars, signal))
    transports.add(transport)
    // Timed-out transports retain their concurrency slot until they actually settle.
    void transport.then(() => { transports.delete(transport) }, () => { transports.delete(transport) })
    let onAbort: () => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new Error('Smart review cancelled or timed out')) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    status(request, true)
    let decision: ReviewDecision | undefined
    try {
      const result = await Promise.race([transport, cancelled])
      if (!signal.aborted) decision = result
    } catch (_error: unknown) {
      // An absent validated decision is resolved through the ordinary answerer after cleanup.
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      deadline.abort(new Error('Smart review complete'))
      status(request, false)
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- every signal can abort while the review is awaited.
    if (request.signal?.aborted || exec.signal.aborted || lifetime.signal.aborted || !accepting) return 'cancelled'
    if (decision === undefined) {
      return human('The reviewer failed, timed out, or returned an invalid response; no automatic grant was made.')
    }
    if (permissions.current(agent.session) !== SMART_PRESET || (revisions.get(agent.session) ?? 0) !== revision) {
      return human('Permissions, instructions, or the model changed during review; the machine decision was discarded.')
    }
    audit('reviewer', decision, { provider: input.provider, model: input.model })
    if (decision.decision === 'allow') return 'allowed-once'
    if (decision.decision === 'deny') return 'rejected'
    return next()
  }

  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.agent !== undefined) {
        let calls = live.get(exec.agent)
        if (calls === undefined) {
          calls = new Map()
          live.set(exec.agent, calls)
        }
        calls.set(exec.callId, exec)
      }
      return next()
    }, { prepend: true })
    yield ctx.on('tools/result', (exec) => {
      const calls = exec.agent === undefined ? undefined : live.get(exec.agent)
      if (calls?.get(exec.callId) === exec) calls.delete(exec.callId)
    })
    yield ctx.on('session/event', (session, event) => {
      if (event.type === 'permission/preset' || event.type === 'approval/policy' || event.type === 'sandbox/mode'
        || event.type === 'user/message' || event.type === 'system/message' || event.type === 'command/run'
        || event.type.startsWith('plan/') || event.type.startsWith('goal/')
        || event.type === 'model/selection' || event.type === 'request/header') {
        revisions.set(session, (revisions.get(session) ?? 0) + 1)
      }
    })
    yield ctx.on('approval/request', (request, next) => {
      return answer(request, next)
    }, { prepend: true })
    yield permissions.registerSmart(() => {
      if (!accepting) throw new Error('Smart approval is closing')
    })
    yield async () => {
      accepting = false
      lifetime.abort(new Error('Smart approval disposed'))
      // Never migrate a reviewed session to Full access when removing the reviewer.
      try {
        for (const session of ctx.sessions.list()) {
          if (permissions.current(session) === SMART_PRESET) permissions.set(session, 'workspace-write')
        }
      } finally {
        await Promise.allSettled([...transports])
      }
    }
  }, 'smart-approval lifetime')

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-smart-approval'),
      name: 'auto-approve',
      description: 'Smart approval: isolated same-model review, manual fallback, or explicit full access',
      input: { hint: '[smart|manual|status|history|full --confirm]' },
      handler: ({ agent, rawInput }) => {
        const mode = rawInput.trim().toLowerCase()
        if (mode === 'history') return { kind: 'success', text: auditText(agent.session) }
        if (mode === '' || mode === 'status') return { kind: 'success', text: `Current permission: ${permissions.current(agent.session)}. /auto-approve smart enables isolated same-model review (extra tokens); manual restores normal prompts; history shows decisions. Full access requires: /auto-approve full --confirm.` }
        const target = mode === 'smart' || mode === 'on' ? SMART_PRESET
          : mode === 'manual' || mode === 'off' ? 'workspace-write'
            : mode === 'full --confirm' ? 'danger-full-access' : undefined
        if (target === undefined) return { kind: 'error', text: 'Use smart, manual, status, history, or full --confirm. Full access disables the sandbox; Smart does not.' }
        if (!permissions.names.includes(target)) return { kind: 'error', text: `Permission preset ${target} is unavailable.` }
        permissions.setForAgent(agent, target)
        return { kind: 'success', text: target === SMART_PRESET ? 'Smart approval enabled: workspace sandbox, isolated same-model review, extra token usage, and human fallback. The model can make mistakes.' : `Permission preset: ${target}.` }
      },
    })
  })
}
