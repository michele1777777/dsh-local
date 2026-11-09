/** Exact execution facts and bounded, authority-labelled session input for Smart review. */

import type {} from '@deepseek-ai/dsh-agent-instructions'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { recordOf } from './policy.ts'

/** Frozen route and JSON input of one auxiliary LLM call. */
export interface ReviewInput {
  provider: string
  model: string
  text: string
}

interface Instruction {
  role: 'human-instruction' | 'direct-parent-instruction' | 'constraint' | 'checkpoint'
  text: string
}

/** Read a required current-session record without materializing a second full event array. */
function eventAt(agent: Agent, index: number): SessionEvent | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- Exact tool identity and sourced input have no equivalent public projection.
  return agent.session.eventAt(SessionSeq(index))
}

/** Verify a live call against its durable start in the currently open step. */
function verifyExecution(agent: Agent, exec: ToolExecution): void {
  let matched = false
  let opened = false
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    const event = eventAt(agent, index)
    if (event?.type === 'step/end' || event?.type === 'turn/end') break
    if (event?.type === 'step/start') {
      opened = true
      break
    }
    if (exec.parent === undefined && event?.type === 'tool/call' && event.data.callId === exec.callId) {
      const args: unknown = event.data.arguments === '' ? {} : JSON.parse(event.data.arguments)
      if (matched || event.data.name !== exec.name || JSON.stringify(args) !== JSON.stringify(exec.arguments)) {
        throw new Error('The live native call does not match its logged arguments')
      }
      matched = true
    }
    if (exec.parent !== undefined && event?.type === 'tool/ptc-dispatch-start' && event.data.subCallId === exec.callId) {
      if (matched || event.data.name !== exec.name || event.data.rootCallId !== exec.rootCallId
        || JSON.stringify(event.data.arguments) !== JSON.stringify(exec.arguments)) {
        throw new Error('The live PTC call does not match its logged arguments')
      }
      matched = true
    }
  }
  if (!opened || !matched) throw new Error('No unique pending execution exists in the current step')
}

/** Identify an in-process child's original delegation using its durable descriptor. */
function initialDelegation(agent: Agent): number | undefined {
  if (agent.session.header.origin !== 'subagent' || agent.session.header.parentSession === undefined) return undefined
  let descriptor = false
  for (let index = 0; index < agent.session.seq; index += 1) {
    const event = eventAt(agent, index)
    if (event === undefined || !agent.session.isOwnSeq(event.seq)) continue
    if (event.type === 'subagent/descriptor') descriptor = true
    if (descriptor && event.type === 'user/message' && event.data.source.kind === 'user'
      && typeof (event.data.source as { rpcId?: unknown }).rpcId !== 'string') return index
  }
  return undefined
}

/**
 * Recognize only the built-in sandbox-escalation question. Explicit hook asks and unknown questions remain human-owned.
 * @param request - question already accepted by ApprovalService.
 * @param exec - registry-owned live execution, or absent for an untracked question.
 * @param escalatingTools - exact tool names whose every call requests `danger-full-access` without a `sandbox_permissions` argument.
 * @returns whether the question names that execution and its exact requested escalation.
 */
export function eligibleRequest(
  request: ApprovalRequest, exec: ToolExecution | undefined, escalatingTools: readonly string[],
): exec is ToolExecution {
  if (exec === undefined || request.callId !== exec.callId || request.toolName !== exec.name || request.agent !== exec.agent) return false
  const mode = escalatingTools.includes(exec.name) ? 'danger-full-access' : recordOf(exec.arguments)?.['sandbox_permissions']
  return (mode === 'workspace-write' || mode === 'danger-full-access')
    && request.reason?.startsWith(`escalate sandbox to ${mode}: `) === true
}

/**
 * Build a complete bounded review input without adding, truncating, or compacting agent messages.
 * @param agent - owner of the accepted permission question.
 * @param exec - immutable execution captured from the shared tool registry.
 * @param request - exact sandbox-escalation question.
 * @param maxChars - complete serialized input cap, excluding the fixed reviewer policy.
 * @returns the current provider/model and authority-labelled JSON input.
 */
export function buildReviewInput(agent: Agent, exec: ToolExecution, request: ApprovalRequest, maxChars: number): ReviewInput {
  verifyExecution(agent, exec)
  const header = agent.session.requestHeader()
  const cwd = agent.session.header.cwd
  if (header === undefined || header.config.provider === '' || header.config.model === '' || cwd === undefined || cwd === '') {
    throw new Error('Current model route or workspace is unavailable')
  }
  const candidates = header.tools?.filter(tool => tool.name === exec.name) ?? []
  const schema = exec.parent === undefined ? (candidates.length === 1 ? candidates[0] : undefined) : exec.schema
  if (schema === undefined || schema.name !== exec.name) throw new Error('The pending tool schema is unavailable')
  const instructions: Instruction[] = []
  const delegatedSeq = initialDelegation(agent)
  let authenticated = false
  let inputChars = 0
  for (const seq of agent.session.surface.nodes) {
    const event = eventAt(agent, seq)
    if (event?.type === 'system/message') {
      for (const block of event.data.message.content) {
        if (block.type !== 'text') continue
        inputChars += block.text.length
        if (inputChars > maxChars) throw new Error('Retained constraints exceed the review input limit')
        instructions.push({ role: 'constraint', text: block.text })
      }
      continue
    }
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    // Producer-declared kinds outside this package's dependency graph: runtime
    // context (agent-loop) and compaction checkpoints (dsh-compaction).
    const kind: string = source.kind
    let role: Instruction['role'] | undefined
    if (source.kind === 'user' && typeof (source as { rpcId?: unknown }).rpcId === 'string') role = 'human-instruction'
    else if (seq === delegatedSeq || (source.kind === 'agent-message'
      && agent.session.header.parentSession !== undefined
      && (source as { senderSessionId?: unknown }).senderSessionId === agent.session.header.parentSession)) role = 'direct-parent-instruction'
    else if (kind === 'agent-instructions' || kind === 'runtime-context') role = 'constraint'
    else if (kind === 'compact-checkpoint') role = 'checkpoint'
    if (role === undefined) continue
    for (const block of event.data.content) {
      if (block.type !== 'text') {
        if (role === 'human-instruction' || role === 'direct-parent-instruction') throw new Error('The reviewer cannot interpret attached non-text instructions')
        continue
      }
      inputChars += block.text.length
      if (inputChars > maxChars) throw new Error('Retained instructions exceed the review input limit')
      instructions.push({ role, text: block.text })
      if (role === 'human-instruction' || role === 'direct-parent-instruction') authenticated = true
    }
  }
  if (!authenticated) throw new Error('No retained authenticated user or parent instruction is available')
  const text = JSON.stringify({
    environment: { cwd, sandbox: 'workspace-write', approval: 'ask' },
    instructions,
    pendingAction: { name: exec.name, description: schema.description, parameters: schema.parameters, arguments: exec.arguments },
    requestedPermission: request.reason,
  })
  if (text.length > maxChars) throw new Error('Complete review input exceeds the configured limit')
  return { provider: header.config.provider, model: header.config.model, text }
}
