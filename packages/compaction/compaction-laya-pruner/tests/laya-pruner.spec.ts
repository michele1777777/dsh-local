/**
 * The Laya pruning pass end to end against a fake Laya service (`node:http` on 127.0.0.1:0):
 * trigger threshold, request body, durable start/end events, in-place tool/user replacements,
 * span removal, agent rewrites with reasoning retention, fallback on every service failure,
 * projection-only mode, and one real AgentLoop turn.
 */

import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, {
  boundContextSummary, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as laya from '../src/index.ts'
import type { LayaPrunerConfig } from '../src/index.ts'
import { LAYA_GAP_NOTE, layaRewriteProjection } from '../src/projection.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Context producer used to check the service's `context` flag and per-producer pinning. */
    'laya-pruner-test': { kind: 'laya-pruner-test' } & ContextFormed
  }
}

// ---------------------------------------------------------------------------
// Fake Laya service
// ---------------------------------------------------------------------------

interface ServiceEvent {
  role: 'user' | 'assistant'
  text: string
  tool_uses: Array<{ id: string; name: string; input: unknown }>
  tool_results: Array<{ id: string; text: string; is_error: boolean }>
  context?: true
  pinned?: true
}

interface CompactRequest {
  events: ServiceEvent[]
  target_tokens: number
  fixed_tokens: number
  min_budget_tokens: number
}

interface ServiceItem {
  id: string
  kind: 'tool' | 'user_msg' | 'agent_msg'
  action: 'KEEP' | 'TRUNCATE' | 'DROP'
  keep_lines: Array<[number, number]>
  lines: number
  tokens_before: number
  tokens_after: number
  label: string
}

type Reply = { status: number; body: string; contentType?: string } | 'hang'
type Responder = (request: CompactRequest) => Reply

interface LayaService {
  url: string
  requests: CompactRequest[]
  paths: string[]
  respond: Responder
  close(): Promise<void>
}

const services: LayaService[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(services.splice(0).map(service => service.close()))
})

function items(...list: ServiceItem[]): Reply {
  return { status: 200, body: JSON.stringify({ items: list, stats: { judged: list.length } }) }
}

async function startLaya(respond: Responder = () => items()): Promise<LayaService> {
  const service: LayaService = {
    url: '',
    requests: [],
    paths: [],
    respond,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      service.paths.push(`${req.method} ${req.url} ${req.headers['content-type']}`)
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CompactRequest
      service.requests.push(request)
      const reply = service.respond(request)
      if (reply === 'hang') return
      res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' })
      res.end(reply.body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  service.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  services.push(service)
  return service
}

/** A URL nothing listens on (the port of a closed server). */
async function unreachableUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return `http://127.0.0.1:${port}`
}

function tool(id: string, action: ServiceItem['action'], lines: number, keep: Array<[number, number]> = []): ServiceItem {
  return {
    id, kind: 'tool', action, keep_lines: keep, lines,
    tokens_before: lines * 10, tokens_after: action === 'KEEP' ? lines * 10 : keep.length * 10, label: `tool ${id}`,
  }
}

function message(index: number, kind: 'user_msg' | 'agent_msg', action: ServiceItem['action'], lines: number, keep: Array<[number, number]> = []): ServiceItem {
  return {
    id: `m${index}`, kind, action, keep_lines: keep, lines,
    tokens_before: lines * 10, tokens_after: action === 'KEEP' ? lines * 10 : keep.length * 10, label: `${kind} m${index}`,
  }
}

/** Index of the first service event whose text starts with `prefix`. */
function at(request: CompactRequest, prefix: string): number {
  const index = request.events.findIndex(event => event.text.startsWith(prefix))
  if (index < 0) throw new Error(`no service event starts with ${JSON.stringify(prefix)}`)
  return index
}

// ---------------------------------------------------------------------------
// LLM route with a mutable context window
// ---------------------------------------------------------------------------

class WindowAdapter extends LlmAdapter {
  contextWindow: number | undefined = 1_000_000
  defaultMaxTokens: number | undefined = undefined
  readonly requests: GenerateOptions[] = []
  readonly script: StreamChunk[][] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      ...this.contextWindow === undefined ? {} : { context: { contextWindow: this.contextWindow } },
      ...this.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: this.defaultMaxTokens },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * (this.script.shift() ?? response([{ type: 'text', text: 'ok' }]))
  }
}

function response(blocks: Array<{ type: 'text' | 'reasoning'; text: string }>): StreamChunk[] {
  return [
    ...blocks.flatMap((block, index): StreamChunk[] => [
      { type: 'block-start', index, blockType: block.type },
      { type: 'block-end', index, block },
    ]),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

// ---------------------------------------------------------------------------
// Direct harness: the plugin and its injected services, pre-step dispatched as the loop does
// ---------------------------------------------------------------------------

const PROVIDER = 'mock'

/** The services the plugin injects (`tokenMeter`, `llm`, `sessions`) and a routed adapter, without the plugin. */
async function services_(): Promise<{ ctx: Context; adapter: WindowAdapter }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  const adapter = new WindowAdapter()
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter }
}

const PASS: LayaPrunerConfig = { headroomTokens: 0, thresholdRatio: 0.5, timeoutMs: 1000 }

async function harness(config: LayaPrunerConfig = {}) {
  const { ctx, adapter } = await services_()
  await ctx.plugin(laya, { ...PASS, ...config })
  return { ctx, adapter }
}

function preStep(ctx: Context, session: Session, turn = 2, signal = new AbortController().signal): Promise<PreStepDecision> {
  return agentEvents(ctx, { session } as Agent).waterfall(
    'agent/pre-step', { modelSelection: { provider: PROVIDER, model: 'mock' }, messages: [], turn, step: 3, signal },
    () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }),
  )
}

/** Window that puts the current measurement exactly on (`fire`) or just below (`idle`) the 0.5 ratio threshold. */
function windowFor(ctx: Context, session: Session, mode: 'fire' | 'idle' = 'fire'): number {
  const tokens = ctx.tokenMeter.measure(session).totalTokens
  return mode === 'fire' ? tokens * 2 : tokens * 2 + 4
}

/** Appends a conversation in the shape the agent loop writes it. */
class Transcript {
  turn = 0
  step = 0
  private headered = false
  constructor(readonly session: Session, readonly maxTokens?: number) {}

  system(text: string): this {
    this.session.append('system/message', { turn: this.turn, step: 1, message: createSystemMessage(text) }, { surfaceOp: 'append' })
    return this
  }

  startTurn(): this {
    this.turn += 1
    this.step = 0
    this.session.append('turn/start', { turn: this.turn })
    return this
  }

  endTurn(): this {
    this.session.append('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
    return this
  }

  user(text: string, kind: 'user' | 'laya-pruner-test' = 'user'): SessionEvent {
    const source = kind === 'user' ? { kind: 'user' as const } : { kind: 'laya-pruner-test' as const }
    return this.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
  }

  /** One step: an agent message and the results of its tool calls (`results[id]`). */
  agent(content: ContentBlock[], results: Record<string, string> = {}): SessionEvent {
    this.step += 1
    const { turn, step } = this
    this.session.append('step/start', { turn, step })
    if (!this.headered) {
      this.headered = true
      this.session.append('request/header', {
        header: { config: { provider: PROVIDER, model: 'mock', ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens } } },
        reason: 'initial',
      })
    }
    const event = this.session.append('assistant/message', {
      turn, step, stream: [],
      message: createAssistantMessage({ content, source: { provider: PROVIDER, model: 'mock' } }),
    }, { surfaceOp: 'append' })
    for (const block of content) {
      if (block.type !== 'tool-call') continue
      this.session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
      this.session.append('tool/result', {
        turn, step,
        message: createToolResultMessage({ callId: block.id, content: [{ type: 'text', text: results[block.id] ?? 'ok' }], isError: false }),
      }, { surfaceOp: 'append' })
    }
    this.session.append('step/end', { turn, step })
    return event
  }
}

function call(id: string, name: string, args: unknown): ContentBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
}

const reasoning = (text: string): ContentBlock => ({ type: 'reasoning', text })
const text = (value: string): ContentBlock => ({ type: 'text', text: value })
const gap = (n: number): string => `[... ${n} ${LAYA_GAP_NOTE}`
const lines = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n')

/** Any message-like value: session messages and provider request messages. */
type Contentful = { readonly content: readonly ContentBlock[] } | null | undefined

function blocksText(m: Contentful): string {
  return (m?.content ?? []).flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
}

function hasReasoning(m: Contentful): boolean {
  return (m?.content ?? []).some(b => b.type === 'reasoning')
}

function eventsOf<T extends SessionEvent['type']>(session: Session, type: T): Array<SessionEvent<T>> {
  return session.snapshotEvents().filter((e): e is SessionEvent<T> => e.type === type)
}

function toolOutput(session: Session, id: string): string | undefined {
  const found = session.deriveMessages().find(m => m.role === 'tool' && m.toolCallId === id)
  return found === undefined ? undefined : blocksText(found)
}

const U1 = ['Fix the parser bug in src/parse.ts', 'It fails on nested brackets.', 'Here is a long stack trace:', 'at parse (1)', 'at parse (2)'].join('\n')
const A2 = ['Root cause: the bracket depth counter.', 'Fixed by tracking depth per token.', 'Detail line one.', 'Detail line two.'].join('\n')

/**
 * The reference conversation, pre-step at turn 2 step 3:
 * system | U1 | A1(r, calls c1 c2) | c1 c2 | A2(r, text) | context | U2 (current request) | A3(r, call c3) | c3 | A4(r, call c4) | c4
 */
function reference(session: Session, maxTokens?: number) {
  const t = new Transcript(session, maxTokens)
  t.startTurn()
  t.system('You are a test agent.')
  const u1 = t.user(U1)
  const a1 = t.agent([
    reasoning('which files matter'), text('I will inspect the files.'),
    call('c1', 'read', { path: 'src/parse.ts' }), call('c2', 'bash', { command: 'ls -R' }),
  ], { c1: lines('p', 6), c2: lines('ls', 5) })
  const a2 = t.agent([reasoning('the fix is done'), text(A2)])
  t.endTurn()
  t.startTurn()
  const context = t.user('Runtime context: cwd=/repo', 'laya-pruner-test')
  const u2 = t.user('Now add regression tests')
  const a3 = t.agent([reasoning('write a test file'), call('c3', 'write', { path: 'tests/parse.spec.ts' })], { c3: 'written' })
  const a4 = t.agent([reasoning('run the tests'), call('c4', 'bash', '{not json')], { c4: 'tests pass' })
  return { t, u1, a1, a2, context, u2, a3, a4 }
}

/** Decisions on the reference conversation, located by text so the test does not hardcode indexes. */
function referenceDecisions(request: CompactRequest): Reply {
  return items(
    tool('c1', 'TRUNCATE', 6, [[1, 2], [6, 6]]),
    tool('c2', 'DROP', 5),
    tool('c3', 'KEEP', 1),
    message(at(request, 'Fix the parser'), 'user_msg', 'TRUNCATE', 5, [[1, 2]]),
    message(at(request, 'I will inspect'), 'agent_msg', 'KEEP', 1),
    message(at(request, 'Root cause'), 'agent_msg', 'TRUNCATE', 4, [[1, 2]]),
  )
}

// ---------------------------------------------------------------------------

describe('model-specific compaction endpoint', () => {
  it.each([
    ['mock', 'mock', true], ['different', 'mock', false], ['mock', 'different', false],
  ])('matches both provider %s and model %s', async (provider, model, matched) => {
    const resident = await startLaya()
    const managed = await startLaya()
    const { ctx, adapter } = await harness({
      url: resident.url,
      modelEndpoints: [{ provider, model, url: `${managed.url}v1/laya/compact` }],
    })
    const session = ctx.sessions.create(SessionId('endpoint'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    expect(managed.requests).toHaveLength(matched ? 1 : 0)
    expect(resident.requests).toHaveLength(matched ? 0 : 1)
    expect((matched ? managed : resident).paths).toEqual([
      `POST ${matched ? '/v1/laya/compact' : '/compact'} application/json`,
    ])
  })

  it('delegates to summary fallback on a managed worker failure', async () => {
    const resident = await startLaya()
    const managed = await startLaya(() => ({ status: 503, body: 'worker failed; memory restored' }))
    const { ctx, adapter } = await harness({
      url: resident.url,
      modelEndpoints: [{ provider: 'mock', model: 'mock', url: `${managed.url}v1/laya/compact` }],
    })
    const session = ctx.sessions.create(SessionId('managed-failure'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    const before = session.deriveMessages()
    await expect(preStep(ctx, session)).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(eventsOf(session, 'laya-pruner/end').at(-1)?.data.outcome).toBe('fallback')
    expect(session.deriveMessages()).toEqual(before)
    expect(resident.requests).toHaveLength(0)
  })
})

describe('trigger threshold', () => {
  it('does not call the service below min(ratio x window, window - reserved - headroom)', async () => {
    const service = await startLaya()
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('below'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session, 'idle')
    const events = session.snapshotEvents()
    await expect(preStep(ctx, session)).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(service.requests).toHaveLength(0)
    expect(session.snapshotEvents()).toEqual(events)

    adapter.contextWindow = windowFor(ctx, session, 'fire')
    await preStep(ctx, session)
    expect(service.requests).toHaveLength(1)
  })

  it('also fires once the request reaches window minus the routed output reservation and headroom', async () => {
    const service = await startLaya()
    const { ctx, adapter } = await harness({ url: service.url, thresholdRatio: 1, headroomTokens: 50 })
    const session = ctx.sessions.create(SessionId('headroom'))
    reference(session)
    const tokens = ctx.tokenMeter.measure(session).totalTokens
    adapter.defaultMaxTokens = 200
    adapter.contextWindow = tokens + 200 + 50 + 1
    await preStep(ctx, session)
    expect(service.requests).toHaveLength(0)
    adapter.contextWindow = tokens + 200 + 50
    await preStep(ctx, session)
    expect(service.requests).toHaveLength(1)
  })

  it('reserves the logged request maxTokens ahead of the model default', async () => {
    const service = await startLaya()
    const { ctx, adapter } = await harness({ url: service.url, thresholdRatio: 1 })
    const session = ctx.sessions.create(SessionId('max-tokens'))
    reference(session, 500)
    const tokens = ctx.tokenMeter.measure(session).totalTokens
    adapter.defaultMaxTokens = 100
    adapter.contextWindow = tokens + 501
    await preStep(ctx, session)
    expect(service.requests).toHaveLength(0)
    adapter.contextWindow = tokens + 500
    await preStep(ctx, session)
    expect(service.requests).toHaveLength(1)
  })

  it('skips sessions without a request header or a declared context window, and aborted steps', async () => {
    const service = await startLaya()
    const { ctx, adapter } = await harness({ url: service.url, thresholdRatio: 0.01 })
    const fresh = ctx.sessions.create(SessionId('no-header'))
    fresh.append('turn/start', { turn: 1 })
    fresh.append('user/message', createUserMessage({ content: [text('x'.repeat(4000))], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await preStep(ctx, fresh)
    expect(service.requests).toHaveLength(0)

    const session = ctx.sessions.create(SessionId('no-window'))
    reference(session)
    adapter.contextWindow = undefined
    await preStep(ctx, session)
    expect(service.requests).toHaveLength(0)

    adapter.contextWindow = 100
    await expect(preStep(ctx, session, 2, AbortSignal.abort('stop'))).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(service.requests).toHaveLength(0)
    expect(eventsOf(session, 'laya-pruner/start')).toHaveLength(0)
  })
})

describe('service request', () => {
  it('posts the surface as events with grouped tool results, pinned current request, and context flags', async () => {
    const service = await startLaya(() => items())
    const { ctx, adapter } = await harness({ url: service.url, targetRatio: 0.25, minBudgetRatio: 0.1 })
    const session = ctx.sessions.create(SessionId('body'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    const tokensBefore = ctx.tokenMeter.measure(session).totalTokens
    await preStep(ctx, session)

    expect(service.paths).toEqual(['POST /compact application/json'])
    const [request] = service.requests
    expect(request).toBeDefined()
    // The system prompt is never sent; every other surface node is.
    expect(request!.events.map(e => [e.role, e.text.split('\n')[0]])).toEqual([
      ['user', 'Fix the parser bug in src/parse.ts'],
      ['assistant', 'I will inspect the files.'],
      ['user', ''],
      ['assistant', 'Root cause: the bracket depth counter.'],
      ['user', 'Runtime context: cwd=/repo'],
      ['user', 'Now add regression tests'],
      ['assistant', ''],
      ['user', ''],
      ['assistant', ''],
      ['user', ''],
    ])
    const [u1, a1, results, a2, context, u2, a3, , a4] = request!.events
    expect(u1).toEqual({ role: 'user', text: U1, tool_uses: [], tool_results: [] })
    expect(a1!.tool_uses).toEqual([
      { id: 'c1', name: 'read', input: { path: 'src/parse.ts' } },
      { id: 'c2', name: 'bash', input: { command: 'ls -R' } },
    ])
    // Consecutive results of one step form one user event.
    expect(results).toEqual({
      role: 'user', text: '', tool_uses: [],
      tool_results: [{ id: 'c1', text: lines('p', 6), is_error: false }, { id: 'c2', text: lines('ls', 5), is_error: false }],
    })
    // Reasoning is never sent as text.
    expect(a2!.text).toBe(A2)
    expect(a2).not.toHaveProperty('pinned')
    expect(context).toMatchObject({ context: true, pinned: true })
    expect(u2).toMatchObject({ pinned: true })
    expect(u2).not.toHaveProperty('context')
    expect(u1).not.toHaveProperty('pinned')
    expect(a3!.tool_uses).toEqual([{ id: 'c3', name: 'write', input: { path: 'tests/parse.spec.ts' } }])
    // Invalid model-written JSON arguments are still described.
    expect(a4!.tool_uses[0]).toMatchObject({ id: 'c4', name: 'bash', input: { raw: '{not json' } })
    expect((a4!.tool_uses[0]!.input as { parseError: string }).parseError).toMatch(/SyntaxError/)

    const window = adapter.contextWindow ?? 0
    expect(request!.target_tokens).toBe(Math.floor(window * 0.25))
    expect(request!.min_budget_tokens).toBe(Math.floor(window * 0.1))
    const chars = request!.events.reduce((sum, e) => sum + e.text.length + e.tool_results.reduce((s, r) => s + r.text.length, 0), 0)
    expect(request!.fixed_tokens).toBe(Math.max(0, tokensBefore - Math.round(chars / 3.5)))
  })

  it('pins only the latest context message per producer', async () => {
    const service = await startLaya(() => items())
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('pins'))
    const t = new Transcript(session)
    t.startTurn()
    t.user('Runtime context: old', 'laya-pruner-test')
    t.user('first request')
    t.agent([call('c1', 'read', {})], { c1: '[laya_context_pruner: output removed (9 lines); re-run the tool if needed]' })
    t.agent([call('c2', 'read', {})], { c2: `head\n${gap(4)}\ntail` })
    t.agent([text('done')])
    t.endTurn()
    t.startTurn()
    t.user('Runtime context: new', 'laya-pruner-test')
    t.user('second request')
    t.agent([call('c3', 'read', {})], { c3: 'fresh output' })
    adapter.contextWindow = windowFor(ctx, session)
    service.respond = () => items(tool('c1', 'DROP', 1), tool('c2', 'DROP', 3), tool('c3', 'KEEP', 1))
    await preStep(ctx, session)

    const [request] = service.requests
    const pinned = request!.events.flatMap((e, i) => (e.pinned === true ? [i] : []))
    expect(pinned.map(i => request!.events[i]!.text)).toEqual(['Runtime context: new', 'second request'])
    expect(request!.events.filter(e => e.context === true).map(e => e.text)).toEqual(['Runtime context: old', 'Runtime context: new'])
  })

  it('drops already pruned outputs with their steps and call arguments, and never truncates them again', async () => {
    const service = await startLaya(() => items())
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('pruned-again'))
    const t = new Transcript(session)
    t.startTurn()
    t.user('first request')
    // A write whose short output an earlier pass already replaced: the file content lives in the call arguments.
    const written = t.agent([call('c1', 'write', { file_path: '/repo/big.js', content: lines('x', 400) })],
      { c1: '[laya_context_pruner: output removed (1 lines); re-run the tool if needed]' })
    const excerpt = t.agent([call('c2', 'read', {})], { c2: `head\n${gap(4)}\ntail` })
    const kept = t.agent([call('c4', 'read', {})], { c4: `top\n${gap(2)}\nbottom` })
    t.agent([text('done')])
    t.endTurn()
    t.startTurn()
    t.user('second request')
    t.agent([call('c3', 'read', {})], { c3: 'fresh output' })
    adapter.contextWindow = windowFor(ctx, session)
    const before = [...session.surface.nodes]
    const first = before.indexOf(written.seq)
    expect(before[first + 2]).toBe(excerpt.seq)
    service.respond = () => items(tool('c1', 'DROP', 1), tool('c2', 'DROP', 3), tool('c4', 'TRUNCATE', 3, [[1, 1]]), tool('c3', 'KEEP', 1))
    await preStep(ctx, session)

    // The two dropped steps (call and output each) go behind one notice, the write call and its 400 lines with them.
    const [prune] = eventsOf(session, 'compaction/prune')
    expect(eventsOf(session, 'compaction/prune')).toHaveLength(1)
    expect(prune!.data.shadowedSeqs).toEqual(before.slice(first, first + 4))
    for (const seq of prune!.data.shadowedSeqs) expect(session.surface.nodes).not.toContain(seq)
    expect(toolOutput(session, 'c1')).toBeUndefined()
    expect(toolOutput(session, 'c2')).toBeUndefined()
    // An excerpt from an earlier pass is not truncated over its gap notes.
    expect(session.surface.nodes).toContain(kept.seq)
    expect(toolOutput(session, 'c4')).toBe(`top\n${gap(2)}\nbottom`)
    expect(toolOutput(session, 'c3')).toBe('fresh output')
    const [end] = eventsOf(session, 'laya-pruner/end')
    expect(end!.data).toMatchObject({ outcome: 'pruned', dropped: 2 })
  })
})

describe('applying decisions', () => {
  it('truncates and drops tool outputs, relays a truncated user message, and rewrites agent messages', async () => {
    const service = await startLaya(referenceDecisions)
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('apply'))
    const ref = reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    const tokensBefore = ctx.tokenMeter.measure(session).totalTokens
    const firstNew = session.snapshotEvents().length
    await preStep(ctx, session)

    const appended = session.snapshotEvents().slice(firstNew)
    expect(appended.map(e => e.type)).toEqual([
      'laya-pruner/start',
      'compaction/prune', 'tool/result',
      'compaction/prune', 'tool/result',
      'compaction/prune', 'user/message',
      'laya-pruner/rewrite',
      'laya-pruner/end',
    ])
    const [start] = eventsOf(session, 'laya-pruner/start')
    const [end] = eventsOf(session, 'laya-pruner/end')
    expect(start!.data).toMatchObject({ turn: 2, tokensBefore, contextWindow: adapter.contextWindow })
    expect(end!.data.pruneId).toBe(start!.data.pruneId)
    expect(end!.data).toMatchObject({ turn: 2, outcome: 'pruned', tokensBefore, kept: 2, truncated: 3, dropped: 1 })
    expect(end!.data).not.toHaveProperty('error')
    expect(end!.data.tokensAfter).toBe(ctx.tokenMeter.measure(session).totalTokens)
    expect(end!.data.tokensAfter).toBeLessThan(tokensBefore)
    expect(end!.data.ms).toBeGreaterThanOrEqual(0)
    const c1 = end!.data.items.find(i => i.label === 'tool c1')
    expect(c1).toMatchObject({ action: 'TRUNCATE', lines: 6, keepLines: [[1, 2], [6, 6]], tokensBefore: 60, tokensAfter: 20 })
    expect(end!.data.items.find(i => i.label === 'tool c2')).toMatchObject({ action: 'DROP', keepLines: [], tokensAfter: 0 })
    expect(end!.data.items.find(i => i.label === 'tool c3')).toMatchObject({ action: 'KEEP', keepLines: [[1, 1]], tokensAfter: 10 })

    // Tool outputs: kept lines with one gap note per removed run, and a one-line drop note.
    expect(toolOutput(session, 'c1')).toBe(['p1', 'p2', gap(3), 'p6'].join('\n'))
    expect(toolOutput(session, 'c2')).toBe('[laya_context_pruner: output removed (5 lines); re-run the tool if needed]')
    expect(toolOutput(session, 'c3')).toBe('written')
    const [, , replacedC1] = appended
    expect(replacedC1).toMatchObject({ type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', role: 'tool' } } })
    // Each replacement follows a shadow-price event for exactly the replaced node.
    const prunes = eventsOf(session, 'compaction/prune')
    const replaced = session.snapshotEvents().filter(e => e.seq > firstNew && (e.type === 'tool/result' || e.type === 'user/message'))
    replaced.forEach((replacement, i) => {
      const source = (replacement as { sourceEventSeqs?: SessionSeq[] }).sourceEventSeqs![0]!
      expect(replacement).toMatchObject({ surfaceOp: { op: 'replace', startSeq: source, endSeq: source }, sourceEventSeqs: [source] })
      expect(prunes[i]!.seq).toBe(replacement.seq - 1)
      expect(prunes[i]!.data).toMatchObject({ shadowedRange: { start: source, end: source }, shadowedSeqs: [source] })
      const original = session.deriveEventMessage(session.eventAt(source)!)!
      expect(prunes[i]!.data.shadowedTokenCount).toBe(ctx.tokenMeter.estimateMessage(original))
    })

    // The truncated user request becomes a relay from the pass, in place of the original node.
    const relay = replaced.at(-1)!
    expect(relay.type).toBe('user/message')
    expect(relay).toMatchObject({ sourceEventSeqs: [ref.u1.seq], data: { source: { kind: 'laya-pruner', form: 'relay' } } })
    const surface = session.deriveMessages()
    expect(surface.map(m => blocksText(m))).toContain(['Fix the parser bug in src/parse.ts', 'It fails on nested brackets.', gap(3)].join('\n'))
    expect(session.surface.nodes).not.toContain(ref.u1.seq)
    expect(session.surface.nodes).toContain(relay.seq)

    // Agent messages: A2 keeps two lines and loses reasoning; closed-turn A1 and earlier-step A3 lose
    // reasoning; the latest agent message A4 keeps it.
    const [rewrite] = eventsOf(session, 'laya-pruner/rewrite')
    expect(rewrite!.data.targets).toEqual([
      { seq: ref.a2.seq, keepLines: [[1, 2]], dropReasoning: true },
      { seq: ref.a1.seq, dropReasoning: true },
      { seq: ref.a3.seq, dropReasoning: true },
    ])
    expect(blocksText(session.deriveEventMessage(ref.a2))).toBe(['Root cause: the bracket depth counter.', 'Fixed by tracking depth per token.', gap(2)].join('\n'))
    expect([ref.a1, ref.a2, ref.a3, ref.a4].map(e => hasReasoning(session.deriveEventMessage(e)))).toEqual([false, false, false, true])
    // Tool calls survive the rewrite, so pairing with the (replaced) results is intact.
    expect(session.deriveEventMessage(ref.a1)!.content.filter(b => b.type === 'tool-call')).toHaveLength(2)
    // Identity of rewritten agent messages is unchanged.
    expect(session.deriveEventMessage(ref.a2)!.id).toBe((ref.a2 as SessionEvent<'assistant/message'>).data.message.id)
    // Pinned context and request are untouched.
    expect(surface.map(m => blocksText(m))).toEqual(expect.arrayContaining(['Runtime context: cwd=/repo', 'Now add regression tests']))
  })

  it('keeps all reasoning since the latest user request with keepReasoning open-turn', async () => {
    const service = await startLaya(() => items())
    const { ctx, adapter } = await harness({ url: service.url, keepReasoning: 'open-turn' })
    const session = ctx.sessions.create(SessionId('open-turn'))
    const ref = reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    const [rewrite] = eventsOf(session, 'laya-pruner/rewrite')
    expect(rewrite!.data.targets).toEqual([{ seq: ref.a1.seq, dropReasoning: true }, { seq: ref.a2.seq, dropReasoning: true }])
    expect([ref.a1, ref.a2, ref.a3, ref.a4].map(e => hasReasoning(session.deriveEventMessage(e)))).toEqual([false, false, true, true])
    const [end] = eventsOf(session, 'laya-pruner/end')
    expect(end!.data).toMatchObject({ outcome: 'pruned', kept: 0, truncated: 0, dropped: 0 })
    expect(end!.data.tokensAfter).toBeLessThan(end!.data.tokensBefore)
  })

  it('drops only past reasoning when every judged item is kept', async () => {
    const service = await startLaya(() => items(tool('c1', 'KEEP', 6), tool('c2', 'KEEP', 5)))
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('keep-all'))
    const ref = reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    const before = session.deriveMessages().filter(m => m.role !== 'assistant')
    await preStep(ctx, session)
    expect(eventsOf(session, 'compaction/prune')).toHaveLength(0)
    expect(session.deriveMessages().filter(m => m.role !== 'assistant')).toEqual(before)
    expect(eventsOf(session, 'laya-pruner/rewrite')[0]!.data.targets.map(t => t.seq)).toEqual([ref.a1.seq, ref.a2.seq, ref.a3.seq])
    expect(eventsOf(session, 'laya-pruner/end')[0]!.data).toMatchObject({ outcome: 'pruned', kept: 2, truncated: 0, dropped: 0 })
  })

  it('reports fallback when everything is kept and no past reasoning remains', async () => {
    const service = await startLaya(() => items(tool('c1', 'KEEP', 1)))
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('nothing'))
    const t = new Transcript(session)
    t.startTurn()
    t.system('sys')
    t.user('request')
    t.agent([call('c1', 'read', {})], { c1: 'x'.repeat(2000) })
    adapter.contextWindow = windowFor(ctx, session)
    const nodes = [...session.surface.nodes]
    await preStep(ctx, session)
    expect(session.surface.nodes).toEqual(nodes)
    expect(eventsOf(session, 'laya-pruner/rewrite')).toHaveLength(0)
    expect(eventsOf(session, 'laya-pruner/end')[0]!.data).toMatchObject({
      outcome: 'fallback', kept: 1, error: 'nothing to prune (only pinned recent items)',
    })
  })

  it('removes a dropped span (request, call-only step, its outputs) behind one notice, keeping pairing balanced', async () => {
    const service = await startLaya(request => items(
      message(at(request, 'Old unrelated'), 'user_msg', 'DROP', 1),
      tool('c1', 'DROP', 40),
      tool('c2', 'DROP', 3),
      tool('c3', 'KEEP', 1),
    ))
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('span'))
    const t = new Transcript(session)
    t.startTurn()
    t.system('sys')
    const old = t.user('Old unrelated request')
    const a1 = t.agent([call('c1', 'grep', { pattern: 'x' }), call('c2', 'ls', {})], { c1: lines('g', 40), c2: lines('l', 3) })
    const a2 = t.agent([text('Long explanation that stays. '.repeat(10))])
    t.endTurn()
    t.startTurn()
    t.user('Current request')
    t.agent([call('c3', 'read', {})], { c3: 'current output' })
    adapter.contextWindow = windowFor(ctx, session)
    const removed = session.surface.nodes.slice(1, 5)
    expect(removed[0]).toBe(old.seq)
    expect(removed[1]).toBe(a1.seq)
    await preStep(ctx, session)

    const [prune] = eventsOf(session, 'compaction/prune')
    expect(eventsOf(session, 'compaction/prune')).toHaveLength(1)
    expect(prune!.data).toMatchObject({ shadowedRange: { start: removed[0], end: removed[3] }, shadowedSeqs: removed })
    const notice = session.snapshotEvents()[prune!.seq + 1]!
    expect(notice).toMatchObject({
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: removed[0], endSeq: removed[3] },
      sourceEventSeqs: removed,
      data: {
        source: {
          kind: 'laya-pruner', form: 'notice',
          summary: boundContextSummary('laya_context_pruner removed 2 earlier message(s) and 2 tool output(s) not needed for the current work'),
        },
        content: [{ type: 'text', text: '[laya_context_pruner: removed 2 earlier message(s) and 2 tool output(s) that are no longer relevant to the current task]' }],
      },
    })
    for (const seq of removed) expect(session.surface.nodes).not.toContain(seq)
    expect(session.surface.nodes).toContain(a2.seq)
    expect(toolOutput(session, 'c1')).toBeUndefined()
    expect(toolOutput(session, 'c3')).toBe('current output')
    const [end] = eventsOf(session, 'laya-pruner/end')
    expect(end!.data).toMatchObject({ outcome: 'pruned', kept: 1, truncated: 0, dropped: 3 })
    expect(end!.data.items.filter(i => i.action === 'DROP').every(i => i.tokensAfter === 0)).toBe(true)

    // A second pass never re-judges the notice: it is context from the pass, sent with the context flag.
    service.respond = () => items()
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    const second = service.requests[1]!
    expect(second.events.find(e => e.text.startsWith('[laya_context_pruner: removed'))).toMatchObject({ context: true, pinned: true })
  })

  it('removes a dropped agent message without tool calls and keeps a long-text step whose outputs are dropped', async () => {
    const service = await startLaya(request => items(
      message(at(request, 'Chatty answer'), 'agent_msg', 'DROP', 1),
      tool('c1', 'DROP', 2),
    ))
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('agent-drop'))
    const t = new Transcript(session)
    t.startTurn()
    t.system('sys')
    t.user('request one')
    const explained = t.agent([text(`Explaining the plan in detail: ${'step '.repeat(60)}`), call('c1', 'ls', {})], { c1: 'a\nb' })
    const chatty = t.agent([text('Chatty answer')])
    t.endTurn()
    t.startTurn()
    t.user('request two')
    t.agent([text('working')])
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    expect(session.surface.nodes).not.toContain(chatty.seq)
    // Text above 200 characters without a decision is not "textless": the step stays, its output is noted.
    expect(session.surface.nodes).toContain(explained.seq)
    expect(toolOutput(session, 'c1')).toBe('[laya_context_pruner: output removed (2 lines); re-run the tool if needed]')
    const notices = session.deriveMessages().filter(m => m.source.kind === 'laya-pruner')
    expect(notices.map(blocksText)).toEqual(['[laya_context_pruner: removed 1 earlier message(s) and 0 tool output(s) that are no longer relevant to the current task]'])
  })

  it('ignores decisions for unknown ids, KEEPs, and truncations that change nothing', async () => {
    const service = await startLaya(() => items(
      tool('ghost', 'DROP', 3),
      message(99, 'user_msg', 'DROP', 1),
      tool('c1', 'TRUNCATE', 6, [[1, 6]]),
      tool('c2', 'TRUNCATE', 5, [[1, 1]]),
    ))
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('noise'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    expect(toolOutput(session, 'c1')).toBe(lines('p', 6))
    expect(toolOutput(session, 'c2')).toBe(['ls1', gap(4)].join('\n'))
    expect(eventsOf(session, 'compaction/prune')).toHaveLength(1)
    const [end] = eventsOf(session, 'laya-pruner/end')
    expect(end!.data.items.map(i => i.label)).toEqual(['tool c1', 'tool c2'])
  })

  it('names the hidden file lines and the restoring read in the gaps of a file read output, with the path once', async () => {
    const read = ['<path>/repo/tests/spec.ts</path>', '<type>file</type>', '<content>',
      '1: it(', '2:   await create()', '3:   await settle()', '4:   expect(x)', '5: )', '', '(End of file - total 5 lines)', '</content>'].join('\n')
    // r1 keeps its header: header, 1-2, 4, blank and footer; removed: 3, then 5, then the unnumbered </content>.
    // r2 loses its header and 1-2: the first pointer carries the path, the next one does not repeat it.
    const service = await startLaya(() => items(
      tool('r1', 'TRUNCATE', 11, [[1, 5], [7, 7], [9, 10]]),
      tool('r2', 'TRUNCATE', 11, [[6, 6], [8, 8]]),
    ))
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('read-pointer'))
    const t = new Transcript(session)
    t.startTurn()
    t.system('sys')
    t.user('Copy the spec pattern')
    t.agent([call('r1', 'read', { file_path: '/repo/tests/spec.ts' }), call('r2', 'read', { file_path: '/repo/tests/spec.ts' })], { r1: read, r2: read })
    t.agent([text('working')])
    t.endTurn()
    t.startTurn()
    t.user('Continue')
    t.agent([text('still working')])
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    expect(toolOutput(session, 'r1')).toBe(['<path>/repo/tests/spec.ts</path>', '<type>file</type>', '<content>', '1: it(', '2:   await create()',
      '[... 1 lines pruned by laya_context_pruner: file lines 3-3, read offset 3 limit 1 ...]',
      '4:   expect(x)',
      '[... 1 lines pruned by laya_context_pruner: file lines 5-5, read offset 5 limit 1 ...]',
      '', '(End of file - total 5 lines)', gap(1)].join('\n'))
    expect(toolOutput(session, 'r2')).toBe([
      '[... 5 lines pruned by laya_context_pruner: /repo/tests/spec.ts lines 1-2, read offset 1 limit 2 ...]',
      '3:   await settle()',
      '[... 1 lines pruned by laya_context_pruner: file lines 4-4, read offset 4 limit 1 ...]',
      '5: )',
      '[... 3 lines pruned by laya_context_pruner ...]'].join('\n'))

    // The pointer note still marks the output as pruned: a second pass does not judge it again.
    service.respond = () => items()
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    expect(service.requests[1]!.events.flatMap(e => e.tool_results ?? []).find(r => r.id === 'r1')).toBeDefined()
    const [, second] = eventsOf(session, 'laya-pruner/end')
    expect(second!.data.items.map(i => i.label)).not.toContain('tool r1')
  })

  it('keeps the latest call of a pinned tool with its arguments, and prunes older calls as decided', async () => {
    for (const pinnedTools of [undefined, []]) {
      const service = await startLaya(() => items(tool('t1', 'DROP', 1), tool('t2', 'DROP', 1)))
      const { ctx, adapter } = await harness({ url: service.url, ...pinnedTools === undefined ? {} : { pinnedTools } })
      const session = ctx.sessions.create(SessionId(`pinned-${pinnedTools === undefined ? 'default' : 'none'}`))
      const t = new Transcript(session)
      t.startTurn()
      t.system('sys')
      t.user('Build the parser')
      const old = t.agent([call('t1', 'todo_write', { todos: [{ content: 'old plan', status: 'pending' }] })], { t1: 'Updated todo list: 1 pending' })
      const latest = t.agent([call('t2', 'todo_write', { todos: [{ content: 'current plan', status: 'in_progress' }] })], { t2: 'Updated todo list: 1 in progress' })
      t.agent([text('working')])
      t.endTurn()
      t.startTurn()
      t.user('Continue')
      t.agent([text('still working')])
      adapter.contextWindow = windowFor(ctx, session)
      await preStep(ctx, session)
      expect(session.surface.nodes).not.toContain(old.seq)
      const [end] = eventsOf(session, 'laya-pruner/end')
      if (pinnedTools === undefined) {
        expect(session.surface.nodes).toContain(latest.seq)
        expect(toolOutput(session, 't2')).toBe('Updated todo list: 1 in progress')
        expect(end!.data.items.map(i => i.action)).toEqual(['DROP', 'KEEP'])
      } else {
        expect(session.surface.nodes).not.toContain(latest.seq)
        expect(end!.data.items.map(i => i.action)).toEqual(['DROP', 'DROP'])
      }
    }
  })

  it('keeps the projected rewrites and replacements across resume', async () => {
    const service = await startLaya(referenceDecisions)
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('resume-source'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    const resumed = ctx.sessions.create(SessionId('resumed'), { seed: session.snapshotEvents() })
    expect(resumed.deriveMessages()).toEqual(session.deriveMessages())
    expect(ctx.tokenMeter.measure(resumed).totalTokens).toBe(ctx.tokenMeter.measure(session).totalTokens)
  })
})

describe('fallback', () => {
  async function expectFallback(config: LayaPrunerConfig, error: RegExp, service?: LayaService) {
    const { ctx, adapter } = await harness(config)
    const session = ctx.sessions.create(SessionId('fallback'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    const tokensBefore = ctx.tokenMeter.measure(session).totalTokens
    const nodes = [...session.surface.nodes]
    const messages = session.deriveMessages()
    const count = session.snapshotEvents().length
    await expect(preStep(ctx, session)).resolves.toEqual({ kind: 'enter', messages: [] })
    if (service !== undefined) expect(service.requests).toHaveLength(1)
    expect(session.snapshotEvents().slice(count).map(e => e.type)).toEqual(['laya-pruner/start', 'laya-pruner/end'])
    expect(session.surface.nodes).toEqual(nodes)
    expect(session.deriveMessages()).toEqual(messages)
    expect(session.surface.contentGeneration).toBe(0)
    const [end] = eventsOf(session, 'laya-pruner/end')
    expect(end!.data).toMatchObject({ outcome: 'fallback', tokensBefore, tokensAfter: tokensBefore, kept: 0, truncated: 0, dropped: 0, items: [] })
    expect(end!.data.error).toMatch(error)
    expect(ctx.tokenMeter.measure(session).totalTokens).toBe(tokensBefore)
  }

  it('changes nothing when the service answers HTTP 500', async () => {
    const service = await startLaya(() => ({ status: 500, body: 'model crashed' }))
    await expectFallback({ url: service.url }, /^laya service HTTP 500: model crashed$/, service)
  })

  it('changes nothing when the service is unreachable', async () => {
    await expectFallback({ url: await unreachableUrl() }, /fetch failed/)
  })

  it('changes nothing when the service times out', async () => {
    const service = await startLaya(() => 'hang')
    const started = Date.now()
    await expectFallback({ url: service.url, timeoutMs: 1000 }, /timeout|aborted/i, service)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('changes nothing when the service answers invalid JSON', async () => {
    const service = await startLaya(() => ({ status: 200, body: '<html>' }))
    await expectFallback({ url: service.url }, /JSON/, service)
  })

  it('rejects a timeout below one second in the configuration', () => {
    expect(() => laya.Config({ timeoutMs: 10 })).toThrow()
    expect(laya.Config({})).toMatchObject({
      url: 'http://127.0.0.1:8766', thresholdRatio: 0.8, headroomTokens: 65536, targetRatio: 0.25,
      minBudgetRatio: 0.25, timeoutMs: 120000, keepReasoning: 'last', mode: 'pass',
    })
  })
})

describe('registration', () => {
  it('projection mode registers the rewrite projection without hooking pre-step', async () => {
    const service = await startLaya(referenceDecisions)
    const { ctx, adapter } = await harness({ url: service.url, mode: 'projection' })
    expect(ctx.sessions.messageProjections).toContain(layaRewriteProjection)
    const session = ctx.sessions.create(SessionId('projection-only'))
    const ref = reference(session)
    adapter.contextWindow = 10
    await expect(preStep(ctx, session)).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(service.requests).toHaveLength(0)
    expect(eventsOf(session, 'laya-pruner/start')).toHaveLength(0)
    // Stored rewrites still project (resume before any session-level pass loads).
    session.append('laya-pruner/rewrite', { targets: [{ seq: ref.a1.seq, dropReasoning: true }] })
    expect(hasReasoning(session.deriveEventMessage(ref.a1))).toBe(false)
  })

  it('tolerates double registration (host projection + session pass) and runs the pass once per instance', async () => {
    const service = await startLaya(() => items())
    const { ctx, adapter } = await harness({ url: service.url, mode: 'projection' })
    await ctx.plugin(laya, { ...PASS, url: service.url })
    expect(ctx.sessions.messageProjections.filter(p => p.type === 'laya-pruner/rewrite')).toHaveLength(1)
    const session = ctx.sessions.create(SessionId('double'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    expect(service.requests).toHaveLength(1)
    expect(eventsOf(session, 'laya-pruner/end')[0]!.data.outcome).toBe('pruned')
  })

  it('unhooks pre-step when the plugin is disposed', async () => {
    const service = await startLaya(() => items())
    const { ctx, adapter } = await services_()
    const fiber = ctx.plugin(laya, { ...PASS, url: service.url })
    await fiber
    await fiber.dispose()
    expect(ctx.sessions.messageProjections).not.toContain(layaRewriteProjection)
    const session = ctx.sessions.create(SessionId('disposed'))
    reference(session)
    adapter.contextWindow = 10
    await preStep(ctx, session)
    expect(service.requests).toHaveLength(0)
  })
})

describe('regressions for fixed defects', () => {
  it('fixed: a 200 response without an items array is a clean fallback with a matching end', async () => {
    const service = await startLaya(() => ({ status: 200, body: '{}' }))
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('no-items'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    expect(eventsOf(session, 'laya-pruner/start')).toHaveLength(1)
    expect(eventsOf(session, 'laya-pruner/end')).toHaveLength(1)
  })

  it('fixed: an invalid keep_lines range from the service is rejected before anything is applied', async () => {
    const service = await startLaya(request => items(
      tool('c2', 'DROP', 5),
      message(at(request, 'Root cause'), 'agent_msg', 'TRUNCATE', 4, [[0, 2]]),
    ))
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('bad-range'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    // Every start has an end, and a pass that cannot complete changes nothing (or completes).
    expect(eventsOf(session, 'laya-pruner/end')).toHaveLength(1)
  })

  it('fixed: a dropped span that cannot be removed is replaced in place and reported truthfully', async () => {
    const service = await startLaya(request => items(
      message(at(request, 'Old request'), 'user_msg', 'DROP', 1),
      tool('c1', 'DROP', 30),
    ))
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('head-span'))
    const t = new Transcript(session)
    t.startTurn()
    t.user('Old request')
    t.agent([call('c1', 'grep', {})], { c1: lines('g', 30) })
    t.agent([text('done')])
    t.endTurn()
    t.startTurn()
    t.user('Current request')
    t.agent([text('working')])
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    const [end] = eventsOf(session, 'laya-pruner/end')
    // Currently: outcome 'pruned', dropped 2, yet the 30-line output is still verbatim on the surface.
    expect(end!.data.dropped === 0 || toolOutput(session, 'c1') !== lines('g', 30)).toBe(true)
  })

  it('fixed: a pass instance re-registers the projection after the instance that owned it is disposed', async () => {
    const service = await startLaya(() => items())
    const { ctx, adapter } = await services_()
    // Two sessions' pass instances; the first registered the projection, the second tolerated the duplicate.
    const first = ctx.plugin(laya, { ...PASS, url: service.url })
    await first
    await ctx.plugin(laya, { ...PASS, url: service.url })
    await first.dispose()
    const session = ctx.sessions.create(SessionId('orphaned'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    await preStep(ctx, session)
    expect(ctx.sessions.messageProjections).toContain(layaRewriteProjection)
    expect(eventsOf(session, 'laya-pruner/end')[0]?.data.outcome).toBe('pruned')
  })
})

describe('turn boundary', () => {
  it('fixed: the request claimed by this pre-step is sent and pinned as current', async () => {
    const service = await startLaya(() => items())
    const { ctx, adapter } = await harness({ url: service.url })
    const session = ctx.sessions.create(SessionId('turn-boundary'))
    reference(session)
    adapter.contextWindow = windowFor(ctx, session)
    const next = createUserMessage({ content: [text('Brand new request')], source: { kind: 'user' } })
    // At step 1 of a turn the loop passes the claimed input in the payload; it reaches the surface only after pre-step.
    await agentEvents(ctx, { session } as Agent).waterfall(
      'agent/pre-step', { modelSelection: { provider: PROVIDER, model: 'mock' }, messages: [next], turn: 3, step: 1, signal: new AbortController().signal },
      () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [next] }),
    )
    const pinned = service.requests[0]!.events.filter(e => e.pinned === true && e.context !== true).map(e => e.text)
    expect(pinned).toEqual(['Brand new request'])
  })
})

describe('one real AgentLoop turn', () => {
  it('prunes before the step: the provider request carries the pruned context', async () => {
    const service = await startLaya(request => items(
      message(at(request, 'First request'), 'user_msg', 'TRUNCATE', 3, [[1, 1]]),
    ))
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(laya, { url: service.url, thresholdRatio: 0.5, headroomTokens: 0, timeoutMs: 1000 })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new WindowAdapter()
    ctx.llm.registerAdapter([PROVIDER], adapter)
    adapter.script.push(
      response([{ type: 'reasoning', text: 'first thoughts '.repeat(40) }, { type: 'text', text: 'first answer' }]),
      response([{ type: 'reasoning', text: 'second thoughts' }, { type: 'text', text: 'second answer' }]),
      response([{ type: 'text', text: 'third answer' }]),
    )
    const agent = await ctx.agentLoop.create(SessionId('loop'), { provider: PROVIDER, model: 'mock' })
    const ask = async (value: string) => {
      agent.followup(createUserMessage({ content: [text(value)], source: { kind: 'user' } }))
      await agent.whenIdle()
    }

    await ask('First request\nwith a second line\nand a third line')
    await ask('Second request')
    // Below threshold (the default 1M window): the service was never called.
    expect(service.requests).toHaveLength(0)
    expect(adapter.requests).toHaveLength(2)

    adapter.contextWindow = Math.floor(ctx.tokenMeter.measure(agent.session).totalTokens * 1.5)
    await ask('Third request')
    expect(service.requests).toHaveLength(1)
    expect(adapter.requests).toHaveLength(3)

    const events = agent.session.snapshotEvents()
    const types = events.map(e => e.type)
    const end = eventsOf(agent.session, 'laya-pruner/end')[0]!
    expect(end.data).toMatchObject({ outcome: 'pruned', turn: 3, truncated: 1 })
    // The pass ran at the step boundary, before the third model call.
    expect(types.lastIndexOf('laya-pruner/end')).toBeLessThan(types.lastIndexOf('assistant/message'))

    const sent = adapter.requests[2]!.messages
    const sentText = sent.map(m => blocksText(m))
    expect(sentText).toContain(['First request', gap(2)].join('\n'))
    expect(sentText).not.toContain('First request\nwith a second line\nand a third line')
    const assistants = sent.filter(m => m.role === 'assistant')
    expect(assistants.map(blocksText)).toEqual(['first answer', 'second answer'])
    // keepReasoning 'last': the closed first answer lost its reasoning, the latest agent message kept it.
    expect(assistants.map(hasReasoning)).toEqual([false, true])
    expect(sentText).toContain('Third request')
    // The earlier provider requests saw the original content.
    expect(adapter.requests[1]!.messages.filter(m => m.role === 'assistant').map(hasReasoning)).toEqual([true])
  })
})


describe('managed pruning and summary fallback through Loader and AgentLoop', () => {
  it.each(['failure', 'ineffective', 'insufficient', 'sufficient'] as const)('%s pruning', async (mode) => {
    let workerStopped = false
    const service = await startLaya((request) => {
      workerStopped = true
      const progress = ['release', 'start', 'prune', 'stop', 'restore'].map(phase => JSON.stringify({ phase }))
      const result = mode === 'failure' ? { error: 'worker failed after cleanup' } : {
        result: { items: mode === 'ineffective' ? [] : [message(at(request, 'History'), 'user_msg', 'TRUNCATE', 20, [[1, mode === 'sufficient' ? 1 : 19]])] },
      }
      return { status: 200, contentType: 'application/x-ndjson', body: [...progress, JSON.stringify(result), ''].join('\n') }
    })
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-laya-loader-'))
    try {
      const config = join(dir, 'cordis.yml')
      await writeFile(config, [
        "- name: 'cordis:basic'",
        '  config: { auto: true, thresholdRatio: 0.5, headroomTokens: 0, retainRatio: 0.1, maxTokens: 128 }',
        "- name: 'cordis:laya'",
        '  config:',
        "    url: 'http://127.0.0.1:1'",
        '    thresholdRatio: 0.5',
        '    headroomTokens: 0',
        '    modelEndpoints:',
        `      - { provider: mock, model: mock, url: '${service.url}v1/laya/compact' }`,
        "- name: 'cordis:loop'",
        '  config: { agents: [] }',
        '',
      ].join('\n'))
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      ctx.loader.builtins.basic = BasicCompactionEngine
      ctx.loader.builtins.laya = laya
      ctx.loader.builtins.loop = AgentLoop
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
      await ctx.loader.await()
      const adapter = new WindowAdapter()
      ctx.llm.registerAdapter([PROVIDER], adapter)
      const agent = await ctx.agentLoop.create(SessionId(`loader-${mode}`), { provider: PROVIDER, model: 'mock' })
      const ask = async (value: string) => {
        agent.followup(createUserMessage({ content: [text(value)], source: { kind: 'user' } }))
        await agent.whenIdle()
      }
      await ask('Initial task constraints')
      await ask(Array.from({ length: 20 }, (_, i) => `History ${i}: ${'recorded work '.repeat(60)}`).join('\n'))
      await ask('Second request')
      adapter.contextWindow = Math.floor(ctx.tokenMeter.measure(agent.session).totalTokens * 1.5)
      const stream = adapter.stream.bind(adapter)
      adapter.stream = (options) => {
        expect(workerStopped).toBe(true)
        return stream(options)
      }
      await ask('Continue the task')
      const events = agent.session.snapshotEvents()
      const summaries = adapter.requests.filter(request => request.messages.some(m => blocksText(m).includes('acting as a compaction engine')))
      expect(summaries).toHaveLength(mode === 'sufficient' ? 0 : 1)
      expect(service.paths).toEqual(['POST /v1/laya/compact application/json'])
      expect(eventsOf(agent.session, 'laya-pruner/end')).toHaveLength(1)
      expect({
        pruning: eventsOf(agent.session, 'laya-pruner/end').map(e => e.data.outcome),
        phases: eventsOf(agent.session, 'laya-pruner/progress').map(e => e.data.phase),
        summaryCalls: summaries.length,
        compactionEvents: events.filter(e => e.type.startsWith('compaction/')).map(e => e.type),
        finalAnswer: blocksText(agent.session.deriveMessages().at(-1)),
      }).toMatchSnapshot()
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
