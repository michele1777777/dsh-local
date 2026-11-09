import { Context, type Fiber } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { GoalId } from '@deepseek-ai/dsh-goal'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as providerPlugin from '@deepseek-ai/dsh-session-title-first-prompt-llm'

const CONFIG = { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 1_000, maxOutputTokens: 32, timeoutMs: 1_000 } as const
const OBJECTIVE = 'Crea un Tetris giocabile nel browser, in TypeScript con Vite.\n\nRequisiti: logica separata dalla grafica.'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly reply: StreamChunk[] | Error) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.reply instanceof Error) throw this.reply
    yield * this.reply
  }
}

async function harness(reply: StreamChunk[] | Error): Promise<{ ctx: Context; adapter: ScriptedAdapter; provider: Fiber }> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  const adapter = new ScriptedAdapter(reply)
  ctx.llm.registerAdapter(['main'], adapter)
  const provider = await ctx.plugin(providerPlugin, CONFIG)
  return { ctx, adapter, provider }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

/** What `/goal <objective>` logs before its first routed request: the goal, then a goal-attributed round. */
function startGoal(session: Session, operation: 'create' | 'edit' = 'create', objective = OBJECTIVE): void {
  session.append('goal/change', {
    kind: 'goal/change',
    version: 1,
    operation,
    goal: { id: GoalId('goal-1'), revision: 1, objective, phase: 'active', maxGoalRounds: 10 },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `<goal_round>\nObjective: ${JSON.stringify(OBJECTIVE)}\n</goal_round>` }],
    source: { kind: 'goal', goalId: GoalId('goal-1'), revision: 1, round: 1 },
  }), { surfaceOp: 'append' })
}

function route(session: Session): void {
  session.append('request/header', { header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial' })
}

const TITLE: StreamChunk[] = [
  { type: 'text-delta', index: 0, text: 'Tetris browser in TypeScript' },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('a session started with /goal', () => {
  it('is titled by the model from the objective once its first turn is routed, as a rename', async () => {
    const { ctx, adapter } = await harness(TITLE)
    const session = ctx.sessions.create(SessionId('goal-title'))
    startGoal(session)
    await settle()
    expect(adapter.requests).toHaveLength(0)

    route(session)
    await settle()

    expect(adapter.requests).toHaveLength(1)
    const content = adapter.requests[0]?.messages[0]?.content[0]
    expect(content?.type === 'text' && content.text).toContain(JSON.stringify(OBJECTIVE).slice(1, 40))
    expect(adapter.requests[0]).toMatchObject({ provider: 'main', model: 'main-model', purpose: 'session-title' })
    // A goal objective is not a citable human message, so no title request or provider title is logged.
    expect(ctx.sessionTitle.get(session)).toMatchObject({ title: 'Tetris browser in TypeScript', messageSeqs: [], source: { kind: 'user' } })
    expect(session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)

    route(session)
    await settle()
    expect(adapter.requests).toHaveLength(1)
  })

  it('falls back to the objective leading words when the title call fails', async () => {
    const { ctx } = await harness(new Error('model unavailable'))
    const session = ctx.sessions.create(SessionId('goal-fallback'))
    startGoal(session)
    route(session)
    await settle()
    expect(ctx.sessionTitle.get(session)).toMatchObject({ title: 'Crea un Tetris giocabile nel', source: { kind: 'user' } })
  })

  it('leaves sessions with a human prompt to the ordinary first-prompt title', async () => {
    const { ctx, adapter } = await harness(TITLE)
    const session = ctx.sessions.create(SessionId('prompt-then-goal'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Set up the project' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    startGoal(session)
    route(session)
    await settle()
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('provider')
    expect(adapter.requests).toHaveLength(1)
  })

  it('ignores goal edits, blank objectives, and malformed goal data', async () => {
    const { ctx, adapter } = await harness(TITLE)
    const edited = ctx.sessions.create(SessionId('goal-edit'))
    startGoal(edited, 'edit')
    const blank = ctx.sessions.create(SessionId('goal-blank'))
    startGoal(blank, 'create', '  \n ')
    const malformed = ctx.sessions.create(SessionId('goal-malformed'))
    // Durable data is validated, not trusted: a creation without a string objective names nothing.
    malformed.append('goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { objective: 42 } } as never)
    for (const session of [edited, blank, malformed]) route(session)
    await settle()
    expect(adapter.requests).toHaveLength(0)
    for (const session of [edited, blank, malformed]) expect(ctx.sessionTitle.get(session)).toBeUndefined()
  })

  it('never titles a fork from the goal it inherits', async () => {
    const { ctx, adapter } = await harness(TITLE)
    const parent = ctx.sessions.create(SessionId('goal-parent'))
    startGoal(parent)
    const child = ctx.sessions.fork(parent, undefined, SessionId('goal-child'))
    route(child)
    await settle()
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.sessionTitle.get(child)).toBeUndefined()
  })

  it('commits nothing when the plugin is disposed during the title call', async () => {
    const { ctx, adapter, provider } = await harness(TITLE)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const original = adapter.stream.bind(adapter)
    adapter.stream = async function * (options) {
      const stopped = new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
      await Promise.race([held, stopped])
      options.signal?.throwIfAborted()
      yield * original(options)
    }
    const session = ctx.sessions.create(SessionId('goal-dispose'))
    startGoal(session)
    route(session)
    await settle()
    expect(adapter.requests).toHaveLength(0)
    await provider.dispose()
    release()
    await settle()
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
  })

  it('keeps a rename the user made while the title call ran', async () => {
    const { ctx, adapter } = await harness(TITLE)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const original = adapter.stream.bind(adapter)
    adapter.stream = async function * (options) {
      await held
      yield * original(options)
    }
    const session = ctx.sessions.create(SessionId('goal-renamed'))
    startGoal(session)
    route(session)
    await settle()
    ctx.sessionTitle.rename(session, 'My Tetris')
    release()
    await settle()
    expect(ctx.sessionTitle.get(session)?.title).toBe('My Tetris')
  })

  it('titles a resumed goal session at its next turn when its route was logged earlier', async () => {
    const { ctx, adapter, provider } = await harness(TITLE)
    const session = ctx.sessions.create(SessionId('goal-resumed'))
    await provider.dispose()
    startGoal(session)
    route(session)
    await ctx.plugin(providerPlugin, CONFIG)
    session.append('turn/start', { turn: 2 })
    await settle()
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.sessionTitle.get(session)?.title).toBe('Tetris browser in TypeScript')
  })
})
