import { describe, it, expect, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as prechat from '../src/index.ts'
import { parsePrechat, PRECHAT_MAX_BYTES } from '../src/text.ts'
const route = { provider: 'ds4-v41-flash', model: 'deepseek-v4.1-flash' }
const transcript = 'USER: Explain indexes.\nASSISTANT: Indexes speed up lookups.\nUSER: Be concise.\nASSISTANT: Understood.'
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Ready.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ready.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function harness() {
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(UserQuestions)
  const plugin = await ctx.plugin(prechat, { routes: [route] })
  const loop = await mountAgentLoopTestHarness(ctx)
  const adapter = new Adapter(); ctx.llm.registerAdapter([route.provider, 'cloud'], adapter)
  const agent = await loop.create(SessionId('original'), route)
  const run = (text: string, signal = new AbortController().signal) => ctx.commands.execute(agent, `/prechat ${text}`, [], signal)
  return { ctx, agent, adapter, plugin, run }
}
describe('prepared conversation import', () => {
  it('preserves multiline content, Unicode, BOM and Windows line endings', () => {
    expect(parsePrechat('\uFEFFUSER: Caffè\r\nsecond line\r\nASSISTANT: Sì.\r\n')).toEqual([
      { role: 'user', text: 'Caffè\nsecond line' }, { role: 'assistant', text: 'Sì.' },
    ])
  })
  for (const input of ['', 'USER: question', 'ASSISTANT: answer', 'USER: q\nUSER: q', 'USER: \nASSISTANT: a', 'USER: q\0\nASSISTANT: a']) {
    it(`rejects malformed input ${JSON.stringify(input)}`, () =>{  expect(() => parsePrechat(input)).toThrow() })
  }
  it('bounds UTF-8 bytes rather than JavaScript characters', () => {
    expect(() => parsePrechat(`USER: ${'é'.repeat(PRECHAT_MAX_BYTES / 2)}\nASSISTANT: a`)).toThrow(/256 KiB/u)
  })
  it('creates persisted role messages without inference and preserves the original chat', async () => {
    const { ctx,agent,adapter,run } = await harness()
    const result = await run(`--apply\n${transcript}`)
    expect(result?.result.kind).toBe('success')
    if (result?.result.kind !== 'success' || result.result.sessionId === undefined) throw new Error('missing new session')
    const imported = ctx.agents.get(result.result.sessionId)!
    expect(imported.id).not.toBe(agent.id)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.deriveMessages()).toHaveLength(0)
    const messages = imported.session.deriveMessages()
    expect(messages.map(message => ({ role:message.role,text:message.content[0] }))).toMatchInlineSnapshot(`
      [
        {
          "role": "user",
          "text": {
            "text": "Explain indexes.",
            "type": "text",
          },
        },
        {
          "role": "assistant",
          "text": {
            "text": "Indexes speed up lookups.",
            "type": "text",
          },
        },
        {
          "role": "user",
          "text": {
            "text": "Be concise.",
            "type": "text",
          },
        },
        {
          "role": "assistant",
          "text": {
            "text": "Understood.",
            "type": "text",
          },
        },
      ]
    `)
    const replay = Session.create(SessionId('replayed'), imported.session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(messages)
    expect(ctx.sessionProjections.snapshot(imported.session, ['prechat']).values.prechat).toBe(4)
    imported.followup(createUserMessage({ content:[{ type:'text',text:'Now explain B-trees.' }],source:{ kind:'user' } }))
    await imported.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.messages.filter(message=>message.role!=='system').slice(0,4)).toEqual(messages)
  })
  it('hides and rejects the command for every other route, including the official model', async () => {
    const { ctx,agent,run } = await harness()
    agent.session.append('model/selection',{ provider:'cloud',model:route.model })
    expect(ctx.commands.list(agent).some(item=>item.name==='prechat')).toBe(false)
    await expect(run(`--apply\n${transcript}`)).rejects.toThrow(/unavailable/u)
  })
  it('rechecks the route after the user reviews the preview', async () => {
    const { ctx,agent,run } = await harness()
    ctx.on('user-questions/request', async (request) => {
      agent.session.append('model/selection',{ provider:'cloud',model:route.model })
      return { answers:[{ id:request.questions[0]!.id,selected:['Apply'] }] }
    })
    await expect(run(transcript)).rejects.toThrow(/only with ds4-v41-flash\/deepseek-v4\.1-flash/u)
    expect(ctx.agents.list()).toHaveLength(1)
  })
  it('reads a quoted file path, shows its full preview, and applies only after confirmation', async () => {
    const { ctx,run } = await harness()
    const dir = await mkdtemp(join(tmpdir(),'prechat-'))
    try {
      const path = join(dir,'my conversation.txt'); await writeFile(path,transcript)
      ctx.on('user-questions/request',async (request)=>{
        expect(request.questions[0]!.detail).toContain('Indexes speed up lookups.')
        return { answers:[{ id:'prechat-preview',selected:['Apply'] }] }
      })
      const result = await run(JSON.stringify(path))
      expect(result?.result.kind).toBe('success')
    } finally { await rm(dir,{ recursive:true,force:true }) }
  })
  it('cancel creates no new session or model work', async () => {
    const { ctx,adapter,run }=await harness()
    ctx.on('user-questions/request',async()=>({ answers:[{ id:'prechat-preview',selected:['Cancel'] }] }))
    await run(transcript)
    expect(ctx.agents.list()).toHaveLength(1);expect(adapter.requests).toHaveLength(0)
  })
  it('rejects a malformed direct apply without creating a session',async()=>{
    const { ctx,run }=await harness();await expect(run('--apply\nUSER: unfinished')).rejects.toThrow(/ASSISTANT/u);expect(ctx.agents.list()).toHaveLength(1)
  })
  it('unregisters both command and projection on disposal',async()=>{
    const { ctx,agent,plugin }=await harness();await plugin.dispose();expect(ctx.commands.list(agent).some(item=>item.name==='prechat')).toBe(false)
  })
})
