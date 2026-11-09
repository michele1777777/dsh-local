/** Production services through a test-only Loader composition; only provider and shell effects are external fixtures. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import * as SmartApproval from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

class ReviewAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = '{"decision":"allow","risk":"low","reason":"Requested scoped inspection"}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The real shell transport is not invoked; the fixture records authorized external effects. */
function shellFixture(ctx: Context): void {
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('No external shell transport in this composition') },
    run() { throw new Error('No external shell transport in this composition') },
    start() { throw new Error('No external shell transport in this composition') },
  })
}

async function loadComposition(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-smart-loader-'))
  directories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@fixture/shell-transport', shellFixture],
    ['@deepseek-ai/dsh-user-approval', ApprovalService],
    ['@deepseek-ai/dsh-permission-presets', PermissionPresets],
    ['@deepseek-ai/dsh-smart-approval', SmartApproval],
  ])
  // The Loader only calls `import`; the remaining Node loader hooks are never reached here.
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  const config = join(root, 'cordis.yml')
  await writeFile(config, [...modules.keys()].map(name => `- name: '${name}'`).join('\n') + '\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  return ctx
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Smart approval Loader composition', () => {
  it('keeps manual as default, grants an exact call with shared services and records no extra agent message', async () => {
    const ctx = await loadComposition()
    expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
    const adapter = new ReviewAdapter()
    ctx.llm.registerAdapter(['review'], adapter)
    let executions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'Fixture shell transport: inspect repository status',
      parameters: { command: { type: 'string' }, sandbox_permissions: { type: 'string' } },
      async execute(_args, exec) {
        if (exec.agent === undefined) throw new Error('Missing owning agent')
        const outcome = await ctx.approval.request({
          agent: exec.agent,
          toolName: 'bash',
          callId: exec.callId,
          reason: 'escalate sandbox to danger-full-access: Inspect status',
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') throw new Error(`Permission result: ${outcome}`)
        executions += 1
        return [{ type: 'text', text: 'clean working tree' }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('smart-loader'), { provider: 'review', model: 'same-model' }, { cwd: '/workspace' })
    const session = agent.session
    expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
    ctx.permissionPresets.set(session, 'smart')
    expect(ctx.permissionPresets.resolve('smart')).toMatchObject({ sandbox: 'workspace-write', approval: 'ask' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Inspect the repository status only.' }],
      source: { kind: 'user', rpcId: 'fixture-human' },
    }), { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'review', model: 'same-model' }, tools: [{
        name: 'bash', description: 'Fixture shell transport: inspect repository status', parameters: { type: 'object' },
      }] },
      reason: 'initial',
    })
    session.append('step/start', { turn: 1, step: 1 })
    const callId = ToolCallId('smart-loader-call')
    const args = { command: 'git status', sandbox_permissions: 'danger-full-access' }
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify(args) })
    const before = session.deriveMessages()
    const result = await executeToolFixture(ctx, { agent, callId, name: 'bash', arguments: args, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(executions).toBe(1)
    expect(session.deriveMessages()).toEqual(before)
    expect(ctx.permissionPresets.current(session)).toBe('smart')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'review', model: 'same-model', tools: [] })
    expect(adapter.requests[0]).not.toHaveProperty('sessionId')
    expect(adapter.requests[0]?.messages).toHaveLength(1)
    const decision = session.snapshotEvents().find(event => event.type === 'approval/decided')
    expect(decision?.data).toMatchObject({ outcome: 'allowed-once', review: { source: 'reviewer', decision: 'allow' } })
  })
})
