// Boots the shipped Web composition and drives one standard-preset session
// under Smart approval through a plugin_manager call: the tool's own
// danger-full-access request must reach the isolated reviewer, not the user.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const PROVIDER = 'shipped-smart-plugin-manager-test'
const MODEL = 'same-route'
const CALL_ID = ToolCallId('smart-plugin-manager-list')
const FINAL_TEXT = 'SMART_PLUGIN_MANAGER_LISTED'

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

let scaffold: WebScaffold | undefined

afterEach(async () => {
  try {
    await scaffold?.close()
  } finally {
    scaffold = undefined
  }
})

async function remote<T>(target: WebScaffold, endpoint: string, args: Readonly<Record<string, unknown>>): Promise<T> {
  const response = await target.hostFetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `smart-plugin-manager-${endpoint}-${randomUUID()}`, method: endpoint, payload: { args } }),
  })
  if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${response.status}: ${await response.text()}`)
  const result = (await response.json() as { result: RpcResult<T> }).result
  if (!result.ok) throw new Error(`${endpoint} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Same-route main model and Smart reviewer: list bundles, then answer once the tool returns. */
class SmartPluginManagerAdapter extends LlmAdapter {
  override async listModels(provider: string) { return [{ provider, id: MODEL, name: MODEL }] }
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000 })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.system?.startsWith('You review ONE permission request') === true) {
      yield* textChunks('{"decision":"allow","risk":"low","reason":"Read-only bundle listing the user asked for"}')
      return
    }
    if (options.messages.some(message => message.role === 'tool')) {
      yield* textChunks(FINAL_TEXT)
      return
    }
    const args = JSON.stringify({ action: 'list_bundles' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: CALL_ID, name: 'plugin_manager', argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CALL_ID, name: 'plugin_manager', arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

it('lets Smart approval review a standard-preset plugin_manager call instead of asking the user', async () => {
  scaffold = await launchWebScaffold({})
  const ctx = scaffold.ctx
  const adapter = new SmartPluginManagerAdapter()
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'Smart plugin_manager same-route adapter')
  const asked: Array<string | undefined> = []
  ctx.effect(() => ctx.on('approval/request', (request) => {
    asked.push(request.reason)
    return Promise.resolve('rejected' as const)
  }), 'human answerer that must not be reached')

  const created = await remote<{ sessionId: string }>(scaffold, 'session/create', { request: { cwd: scaffold.workspaceCwd } })
  const sessionId = SessionId(created.sessionId)
  await remote(scaffold, 'session/selectModel', { request: { sessionId, provider: PROVIDER, model: MODEL } })
  const switched = await remote<{ result: { kind: string } }>(scaffold, 'commands/execute', {
    agentId: sessionId, line: '/auto-approve smart', submittedAttachments: [],
  })
  expect(switched.result.kind).toBe('success')
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('Smart session was not published')
  expect(ctx.permissionPresets.current(agent.session)).toBe('smart')

  const settled = scaffold.whenTurnSettled()
  await remote(scaffold, 'session/prompt', {
    request: { requestId: `smart-plugin-manager-${randomUUID()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: 'List the bundles installed in this profile.' }] },
  })
  expect(await settled).toBe(sessionId)
  await agent.whenIdle()

  const [main, reviewer, final] = adapter.requests
  expect(main?.tools?.some(schema => schema.name === 'plugin_manager')).toBe(true)
  expect(reviewer?.system).toContain('You review ONE permission request')
  expect(JSON.stringify(reviewer?.messages)).toContain('plugin_manager')
  expect(final?.messages.some(message => message.role === 'tool')).toBe(true)
  expect(asked).toEqual([])
  const events = agent.session.snapshotEvents()
  const decided = events.find((event): event is Extract<SessionEvent, { type: 'approval/decided' }> => event.type === 'approval/decided')
  expect(decided?.data).toMatchObject({ outcome: 'allowed-once', review: { decision: 'allow' } })
  const result = events.find((event): event is Extract<SessionEvent, { type: 'tool/result' }> => event.type === 'tool/result' && event.data.message.toolCallId === CALL_ID)
  expect(result?.data.error).toBeUndefined()
}, 120_000)
