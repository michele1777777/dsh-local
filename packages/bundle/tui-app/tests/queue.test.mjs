import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { backgroundWaits, InterruptRecovery, parkedCount, submitMode, wakeParked } from '../src/queue.ts'
import { applyEvent, emptyTranscript } from '../src/transcript.ts'

test('Enter steers a running turn; the queue gesture and idle prompts take the next turn', () => {
  assert.equal(submitMode(true, 'enter'), 'steer')
  assert.equal(submitMode(true, 'queue'), 'queue')
  assert.equal(submitMode(true, 'interrupt'), 'steer')
  assert.equal(submitMode(false, 'interrupt'), 'queue')
  assert.equal(submitMode(false, 'enter'), 'queue')
  assert.equal(submitMode(false, 'queue'), 'queue')
})

const message = (id, kind = 'user') => Object.freeze({ id, role: 'user', content: [{ type: 'text', text: id }], source: { kind } })
/** An inbox double that records the same remove/send calls the Agent receives. */
function fakeAgent({ status = 'idle', nextTurn = [], nextStep = [] } = {}) {
  const lists = { 'next-turn': [...nextTurn], 'next-step': [...nextStep] }, calls = []
  return {
    calls, lists, status,
    inbox: {
      get nextTurn() { return lists['next-turn'] }, get nextStep() { return lists['next-step'] },
      remove(id) {
        calls.push(['remove', id])
        for (const list of Object.values(lists)) { const at = list.findIndex(value => value.id === id); if (at >= 0) { list.splice(at, 1); return true } }
        return false
      },
    },
    send(value, target, wakeup) { calls.push(['send', value.id, target, wakeup]); lists[target].push(value) },
  }
}

test('parked input wakes by re-delivering the tail, so every message keeps its place', () => {
  const agent = fakeAgent({ nextTurn: [message('a'), message('b'), message('c')], nextStep: [message('s')] })
  assert.equal(parkedCount(agent), 4)
  assert.equal(wakeParked(agent), 4)
  assert.deepEqual(agent.calls, [['remove', 'c'], ['send', 'c', 'next-turn', true]])
  assert.deepEqual(agent.lists['next-turn'].map(value => value.id), ['a', 'b', 'c'])
  assert.deepEqual(agent.lists['next-step'].map(value => value.id), ['s'])
})

test('parked steering alone wakes from its own list', () => {
  const agent = fakeAgent({ nextStep: [message('s1'), message('s2')] })
  assert.equal(wakeParked(agent), 2)
  assert.deepEqual(agent.calls, [['remove', 's2'], ['send', 's2', 'next-step', true]])
})

test('nothing is woken while running, without human input, or after the row was consumed', () => {
  assert.equal(wakeParked(fakeAgent({ status: 'running', nextTurn: [message('a')] })), 0)
  const context = fakeAgent({ nextStep: [message('ctx', 'time-context')] })
  assert.equal(wakeParked(context), 0)
  assert.deepEqual(context.calls, [])
  const raced = fakeAgent({ nextTurn: [message('a')] })
  raced.inbox.remove = () => false
  assert.equal(wakeParked(raced), 0)
  assert.deepEqual(raced.calls, [])
})

test('the runner re-delivers held messages but never constructs one', () => {
  const queue = readFileSync(new URL('../src/queue.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(queue, /createUserMessage|\.followup\(|\.steer\(/)
})

/*
 * The real AgentLoop: the stuck-queue root cause and its recovery. A user
 * cancel keeps the inbox (`keepInbox`, as SessionController.cancel does) and
 * wakes nothing, so a prompt queued during the interrupted turn waits for
 * another send; wakeParked starts it.
 */
async function loop(script) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: LlmRuntime, createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const { default: SessionStore, SessionId } = await import('@deepseek-ai/dsh-session')
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const NativeToolExecutor = await import('@deepseek-ai/dsh-tool-executor-native')
  const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent')
  const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
  const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
  const { MockAdapter } = await import('../../../core/agent-loop/tests/mock-adapter.ts')
  const ctx = new Context()
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`tui-queue-${Math.random()}`), { provider: 'mock', model: 'mock' })
  const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const texts = () => agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    .flatMap(event => event.data.content).flatMap(block => block.type === 'text' ? [block.text] : [])
  return { ctx, agent, adapter, user, texts }
}
const textResponse = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

test('AgentLoop: an interrupt parks queued input until wakeParked starts it, in order', async () => {
  const { agent, adapter, user, texts } = await loop(['hang', textResponse('first'), textResponse('second')])
  agent.followup(user('active'))
  await settle()
  agent.followup(user('queued 1')); agent.followup(user('queued 2'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
  // The reported bug: idle, nothing running, both messages still pending.
  assert.equal(agent.status, 'idle')
  assert.equal(agent.inbox.nextTurn.length, 2)
  assert.equal(adapter.requests.length, 1)
  assert.equal(wakeParked(agent), 2)
  await agent.whenIdle()
  assert.deepEqual(texts(), ['active', 'queued 1', 'queued 2'])
  assert.equal(agent.inbox.nextTurn.length + agent.inbox.nextStep.length, 0)
  assert.equal(adapter.requests.length, 3)
})

test('AgentLoop: steering that missed its interrupted step starts the next turn', async () => {
  const { agent, user, texts } = await loop(['hang', textResponse('read it')])
  agent.followup(user('active'))
  await settle()
  agent.steer(user('also check the tests'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
  assert.equal(agent.inbox.nextStep.length, 1)
  assert.equal(wakeParked(agent), 1)
  await agent.whenIdle()
  assert.deepEqual(texts(), ['active', 'also check the tests'])
})

/** Recovery as the runner wires it: status forwarded, reports recorded. */
function recover(ctx) {
  const reports = []
  const recovery = new InterruptRecovery({
    active: () => true, sending: count => reports.push(['sending', count]), kept: count => reports.push(['kept', count]), failed: error => reports.push(['failed', error]),
  })
  ctx.on('agent/status', ({ agent, status }) => { recovery.status(agent, status) })
  return { recovery, reports }
}
const interrupt = (agent, recovery) => {
  const running = agent.status === 'running'
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  return running ? recovery.interrupted(agent) : Promise.resolve()
}

test('interrupt: queued prompts start right after the interrupted turn, in order', async () => {
  const { ctx, agent, user, texts } = await loop(['hang', textResponse('one'), textResponse('two')])
  const { recovery, reports } = recover(ctx)
  agent.followup(user('active'))
  await settle()
  agent.followup(user('queued 1')); agent.followup(user('queued 2'))
  await interrupt(agent, recovery)
  assert.deepEqual(reports, [['sending', 2]])
  await agent.whenIdle()
  assert.deepEqual(texts(), ['active', 'queued 1', 'queued 2'])
  assert.equal(parkedCount(agent), 0)
})

test('interrupt twice before the turn unwinds: nothing starts, the queue is kept', async () => {
  const { ctx, agent, adapter, user } = await loop(['hang-slow', textResponse('never')])
  const { recovery, reports } = recover(ctx)
  agent.followup(user('active'))
  await settle()
  agent.followup(user('queued'))
  const first = interrupt(agent, recovery), second = interrupt(agent, recovery)
  await Promise.all([first, second])
  assert.deepEqual(reports, [['kept', 1]])
  assert.equal(agent.status, 'idle')
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(adapter.requests.length, 1)
})

test('interrupting the released work stops it and keeps the rest; finished work re-arms recovery', async () => {
  const { ctx, agent, user, texts } = await loop(['hang', 'hang', textResponse('later'), 'hang', textResponse('after')])
  const { recovery, reports } = recover(ctx)
  agent.followup(user('active'))
  await settle()
  agent.followup(user('queued 1')); agent.followup(user('queued 2'))
  await interrupt(agent, recovery)
  await settle()
  await interrupt(agent, recovery)
  assert.deepEqual(reports, [['sending', 2], ['kept', 1]])
  assert.deepEqual(texts(), ['active', 'queued 1'])
  assert.equal(agent.inbox.nextTurn.length, 1)
  // An empty Enter sends the rest; that work completes and closes its recovery.
  assert.equal(wakeParked(agent), 1)
  await agent.whenIdle()
  assert.deepEqual(texts(), ['active', 'queued 1', 'queued 2'])
  // A fresh interrupt with a new queue dispatches again.
  agent.followup(user('fresh'))
  await settle()
  agent.followup(user('queued 3'))
  await interrupt(agent, recovery)
  assert.deepEqual(reports.at(-1), ['sending', 1])
  await agent.whenIdle()
  assert.deepEqual(texts(), ['active', 'queued 1', 'queued 2', 'fresh', 'queued 3'])
})


test('explicit delivery during previously released work interrupts and reads the new steering once', async () => {
  const { ctx, agent, user, texts } = await loop(['hang', 'hang-slow', textResponse('corrected')])
  const { recovery, reports } = recover(ctx)
  agent.followup(user('active')); await settle()
  agent.steer(user('first correction'))
  await interrupt(agent, recovery); await settle()
  agent.steer(user('second correction'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await Promise.all([recovery.interrupted(agent, true), recovery.interrupted(agent, true)])
  await agent.whenIdle()
  assert.deepEqual(texts(), ['active', 'first correction', 'second correction'])
  assert.deepEqual(reports, [['sending', 1], ['sending', 1]])
  const transcript = emptyTranscript()
  for (const event of agent.session.snapshotEvents()) applyEvent(transcript, event, { call: name => ({ card: 'generic', title: name }), result: () => undefined }, true)
  const replay = transcript.items.filter(item => item.kind === 'user' || item.kind === 'assistant').map(item => `${item.kind}: ${item.text}`).filter(line => !line.endsWith(': ')).join('\n') + '\n'
  assert.equal(replay, readFileSync(new URL('./fixtures/interrupted-input.txt', import.meta.url), 'utf8'))
})

test('Esc while explicit delivery is unwinding keeps its input parked', async () => {
  const { ctx, agent, adapter, user } = await loop(['hang-slow', textResponse('unused')])
  const { recovery } = recover(ctx)
  agent.followup(user('active')); await settle()
  agent.steer(user('correction'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  const delivering = recovery.interrupted(agent, true)
  await interrupt(agent, recovery); await delivering
  assert.equal(parkedCount(agent), 1)
  assert.equal(adapter.requests.length, 1)
})

test('forcing steering moves held waits to the background; next-turn input or no waits leaves an interrupt', () => {
  const released = []
  const release = (count) => (owner) => { released.push(owner); return count }
  const steering = { ...fakeAgent({ status: 'running', nextStep: [message('steer')] }), id: 'agent-1' }
  assert.equal(backgroundWaits(steering, release(2)), 2)
  assert.deepEqual(released, ['agent-1'])
  assert.equal(backgroundWaits(steering, release(0)), 0)
  const queued = { ...fakeAgent({ status: 'running', nextTurn: [message('later')], nextStep: [message('notice', 'system')] }), id: 'agent-2' }
  assert.equal(backgroundWaits(queued, release(3)), 0)
  assert.deepEqual(released, ['agent-1', 'agent-1'])
})
