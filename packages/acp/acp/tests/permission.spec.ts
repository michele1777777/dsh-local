import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe('ACP permission config option', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('omits the option when no permission service is composed', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(created.configOptions?.some(option => option.id === 'permission')).toBe(false)
    await expect(harness.client.setSessionConfigOption({ sessionId: created.sessionId, configId: 'permission', value: 'auto' }))
      .rejects.toThrow()
  })

  it('lists the live catalog and writes through the preset service', async () => {
    harness = await makeBridgeHarness()
    const current = new Map<Session, string>()
    const writes: string[] = []
    harness.ctx.provide('permissionPresets', {
      catalog: () => ({ options: [
        { value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace.' },
        { value: 'auto', name: 'Auto review' },
      ] }),
      current: (session: Session) => current.get(session) ?? 'workspace-write',
      set: (session: Session, name: string) => { current.set(session, name); writes.push(name) },
    } as never)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(created.configOptions?.find(option => option.id === 'permission')).toMatchObject({
      type: 'select',
      category: 'mode',
      currentValue: 'workspace-write',
      options: [{ value: 'workspace-write' }, { value: 'auto', name: 'Auto review' }],
    })
    const updated = await harness.client.setSessionConfigOption({ sessionId: created.sessionId, configId: 'permission', value: 'auto' })
    expect(writes).toEqual(['auto'])
    expect(updated.configOptions.find(option => option.id === 'permission')).toMatchObject({ currentValue: 'auto' })
    expect(updated.configOptions.some(option => option.id === 'model')).toBe(true)
    await expect(harness.client.setSessionConfigOption({ sessionId: created.sessionId, configId: 'permission', value: 'root' }))
      .rejects.toThrow()
    expect(writes).toEqual(['auto'])
  })
})

describe('ACP prompt attribution', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('records each prompt as a client request so it reads as a human instruction', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('ok'), textResponse('ok again')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'second' }] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const sources = agent.session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .map(event => (event.data as { source: { kind: string; rpcId?: unknown } }).source)
    expect(sources).toHaveLength(2)
    for (const source of sources) {
      expect(source.kind).toBe('user')
      expect(String(source.rpcId)).toMatch(/^acp-[0-9a-f-]{36}$/)
    }
    expect(sources[0]!.rpcId).not.toBe(sources[1]!.rpcId)
  })
})
