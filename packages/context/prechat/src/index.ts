/** Prepared-conversation import for configured routes, exposed through the shared human-command registry. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId, type CommandInvocation, type CommandResult } from '@deepseek-ai/dsh-commands'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId, createMessage, createUserMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-attachment'
import { isPrechatRoute, parsePrechat, PRECHAT_MAX_BYTES, prechatRouteLabel, type PrechatMessage, type PrechatRoute } from './text.ts'
import type {} from './types.ts'
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-workspace'
export const name = 'prechat'
export const inject = ['commands', 'agents', 'sessions', 'sessionProjections', 'userQuestions']

/** Plugin configuration. */
export interface Config {
  /**
   * Provider/model routes that accept imported conversations. Prepared histories are written for one model's
   * turn format, so other routes refuse them; an empty list leaves `/prechat` unavailable.
   */
  routes: PrechatRoute[]
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  routes: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).default([]),
})

/** Read the same pending selection that prompt assembly will consume. */
function selection(agent: Agent) {
  const route = agent.model.current() ?? agent.options
  return { provider: route.provider ?? '', model: route.model ?? '', ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }) }
}
/** Read at most one bounded plain-text file; no shell interpretation of its path. */
async function readText(input: string, cwd: string, signal: AbortSignal): Promise<string> {
  if (/^\s*(?:USER|ASSISTANT):/u.test(input) || input.includes('\n')) return input
  let path = input.trim().replace(/^(['"])(.*)\1$/u, '$2')
  if (path.startsWith('file://')) path = fileURLToPath(path)
  if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2))
  const file = await open(resolve(cwd, path), 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > PRECHAT_MAX_BYTES) throw new Error('Choose a plain-text file of at most 256 KiB.')
    signal.throwIfAborted()
    const data = Buffer.alloc(PRECHAT_MAX_BYTES + 1)
    let size = 0
    while (size < data.length) {
      signal.throwIfAborted()
      const read = await file.read(data, size, data.length - size, null)
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size > PRECHAT_MAX_BYTES) throw new Error('Conversation exceeds 256 KiB.')
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size))
  } finally { await file.close() }
}
/** Build ordinary replayable history before publishing the new Agent. */
function seed(messages: readonly PrechatMessage[], id: SessionId, route: { provider: string; model: string }) {
  const session = Session.create(id)
  const events: SessionEvent[] = [session.append('model/selection', route)]
  messages.forEach((message, index) => {
    const turn = Math.floor(index / 2) + 1
    if (message.role === 'user') {
      events.push(session.append('turn/start', { turn }))
      events.push(session.append('step/start', { turn, step: 1 }))
      if (index === 0) {
        events.push(session.append('system/message', { turn, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' }))
      }
      events.push(session.append('user/message', createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'prechat' } }), { surfaceOp: 'append' }))
    } else {
      events.push(session.append('assistant/message', {
        turn, step: 1,
        stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [], texts: [message.text] }],
        message: createMessage({ role: 'assistant', content: [{ type: 'text', text: message.text }], source: { kind: 'model', provider: 'prechat', model: 'imported' } }),
      }, { surfaceOp: 'append' }))
      events.push(session.append('step/end', { turn, step: 1 }))
      events.push(session.append('turn/end', { turn, reason: { kind: 'completed' } }))
    }
  })
  return events
}

async function execute(ctx: Context, routes: readonly PrechatRoute[], invocation: CommandInvocation): Promise<CommandResult> {
  const { agent, signal } = invocation
  const ensureRoute = (): void => {
    if (!isPrechatRoute(selection(agent), routes)) throw new Error(`/prechat is available only with ${prechatRouteLabel(routes)}.`)
    if (agent.status === 'running') throw new Error('Stop the current response before importing a conversation.')
    signal.throwIfAborted()
  }
  ensureRoute()
  let input = invocation.rawInput.trimStart()
  const applied = input.startsWith('--apply\n')
  if (applied) input = input.slice('--apply\n'.length)
  if (invocation.attachments.length > 0) {
    const attachment = invocation.attachments[0]
    if (input.trim() !== '' || invocation.attachments.length !== 1 || attachment?.type !== 'file') throw new Error('Choose one .txt file or paste the conversation, not both.')
    const storage = ctx.get('attachments')
    if (storage === undefined) throw new Error('File storage is unavailable. Paste the text instead.')
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of storage.readFileStream(attachment.attachment, signal)) {
      bytes += chunk.length
      if (bytes > PRECHAT_MAX_BYTES) throw new Error('Conversation exceeds 256 KiB.')
      chunks.push(chunk)
    }
    input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }
  let messages: PrechatMessage[]
  while (true) {
    if (input.trim() === '') {
      const answer = await ctx.userQuestions.ask({ agent, signal, questions: [{ id: 'prechat-text', header: 'Initial conversation', question: 'Paste USER: / ASSISTANT: turns or the path of a .txt file. Esc cancels.' }] })
      input = answer.answers.find(item => item.id === 'prechat-text')?.custom ?? ''
      if (input.trim() === '') return { kind: 'success', text: 'Import cancelled.' }
    }
    let text: string
    try { text = await readText(input, agent.session.header.cwd ?? process.cwd(), signal); messages = parsePrechat(text) }
    catch (error) {
      if (applied || signal.aborted) throw error
      const answer = await ctx.userQuestions.ask({ agent, signal, questions: [{ id: 'prechat-correct', header: 'Correct the conversation', question: String(error instanceof Error ? error.message : error), detail: 'Paste the corrected text, or press Esc to cancel.' }] })
      input = answer.answers.find(item => item.id === 'prechat-correct')?.custom ?? ''
      if (input.trim() === '') return { kind: 'success', text: 'Import cancelled.' }
      continue
    }
    if (applied) break
    const answer = await ctx.userQuestions.ask({ agent, signal, questions: [{
      id: 'prechat-preview', header: 'Conversation preview',
      question: `${messages.length} messages. Apply creates a new chat without sending a model request.`,
      detail: messages.map(message => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${message.text}`).join('\n\n'),
      options: [{ label: 'Apply' }, { label: 'Edit' }, { label: 'Cancel' }],
    }] })
    const choice = answer.answers.find(item => item.id === 'prechat-preview')?.selected[0]
    if (choice === 'Apply') break
    if (choice !== 'Edit') return { kind: 'success', text: 'Import cancelled.' }
    input = ''
  }
  ensureRoute()
  const route = selection(agent)
  const id = SessionId(`session-${randomUUID()}`)
  const preset = ctx.get('agentPresets')?.presetForSession(agent.session) ?? agent.session.header.agentPreset
  const presets = ctx.get('agentPresets')
  const created = await ctx.agents.create({
    sessionId: id, signal,
    agentOptions: { ...agent.options, ...route },
    meta: {
      ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
      ...(preset === undefined ? {} : { agentPreset: preset }),
    },
    seed: seed(messages, id, route),
    setup: async (scope) => { if (presets !== undefined && preset != null) await presets.mount(scope, preset) },
  })
  await ctx.sessions.flush(created.agent.session)
  const workspace = ctx.get('workspaceRegistry')?.list().find(item => item.sessionIds.includes(agent.id))
  if (workspace !== undefined) await workspace.attachSession(id)
  return { kind: 'success', sessionId: id, text: `Initial conversation: ${messages.length} messages imported. Write your first question.` }
}

/** Register import and enforce its local-only scope at the outgoing request boundary. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const routes = config.routes
  const belongs = `This imported conversation belongs to ${prechatRouteLabel(routes)}. Start a new chat to use another model.`
  const countSchema = z.number().int().nonnegative()
  const projection = await ctx.sessionProjections.register({
    key: 'prechat', stateVersion: 1, stateSchema: countSchema, init: () => 0,
    apply: (count, event) => event.type === 'user/message' && event.data.source.kind === 'prechat' ? count + 2 : count,
    wire: { viewSchema: countSchema, view: count => count },
  } satisfies ProjectionDefinition<'prechat', number>)
  ctx.on('session/model-target', async ({ agent, selected }, next) => {
    const target = await next()
    if (projection.stateOf(target.session) === 0 || isPrechatRoute(selected, routes)) return target
    const api = ctx.get('sessionController')
    if (api === undefined) throw new Error('Start a new chat before changing the model.')
    const workspace = ctx.get('workspaceRegistry')?.list().find(item => item.sessionIds.includes(agent.id))
    const preset = ctx.get('agentPresets')?.presetForSession(agent.session)
    const result = await api.create({
      ...(workspace === undefined ? { cwd: agent.session.header.cwd ?? process.cwd() } : { workspaceId: workspace.id }),
      ...(preset == null ? {} : { agentPreset: preset }),
    })
    const found = await api.resolveAgent(result.sessionId)
    if ('error' in found) throw found.error
    return found.agent
  })
  ctx.on('agent/request', async ({ agent }, next) => {
    const request = await next()
    if (projection.stateOf(agent.session) > 0 && !isPrechatRoute(request, routes)) {
      throw new Error(belongs)
    }
    return request
  })
  ctx.commands.register({
    name: 'prechat', definitionId: CommandDefinitionId('@deepseek-ai/dsh-prechat'),
    description: 'Import a prepared conversation as the start of a new chat',
    input: { hint: '[text or .txt path]', attachments: true }, recordInput: false,
    available: agent => isPrechatRoute(selection(agent), routes),
    handler: invocation => execute(ctx, routes, invocation),
  })
  ctx.on('llm/stream', async function* (request, next) {
    if (request.messages.some(message => message.source?.kind === 'prechat') && !isPrechatRoute(request, routes)) {
      throw new Error(belongs)
    }
    yield* next()
  })
}
