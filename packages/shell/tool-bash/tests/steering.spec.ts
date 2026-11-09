import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedModel, createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as BashEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-steering-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  provideWorkingDirectoryFixture(ctx)
  for (const plugin of [SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 10 })
  await ctx.plugin(ToolJobs)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashEnv)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 50 })
  await ctx.plugin(ToolBash)
  const id = SessionId('steering-owner')
  const notices: unknown[] = []
  const agent: Agent = {
    id, ctx, model: unsupportedModel(), options: {}, status: 'running', inbox: createInboxStub(),
    session: Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: dir, isSeeded: false }),
    send() {}, steer() {}, followup(message) { notices.push(message) }, inject(message) { notices.push(message) },
    cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  const signal = new AbortController().signal
  const call = (name: string, args: unknown) => executeToolFixture(ctx, { name, arguments: args, agent, signal, callId: ToolCallId('steering-call') })
  const input = (target: 'next-step' | 'next-turn') => {
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Please check something else while that runs.' }] })
    agent.inbox.append(target, message)
    emitAgentEvent(ctx, agent, 'agent/inbox/inserted', { message })
  }
  return { ctx, agent, dir, notices, call, input }
}

async function soon<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('the foreground wait was not released')) }, 1500)
    })])
  } finally { clearTimeout(timer) }
}

it('steering alone leaves a foreground bash command attached until it finishes', async () => {
  const { ctx, agent, dir, call, input } = await setup()
  let returned = false
  const pending = call('bash', { command: 'printf ready; while [ ! -f release ]; do sleep 0.01; done; printf finished', description: 'Wait for test release', workdir: dir }).then((result) => { returned = true; return result })
  await expect.poll(() => ctx.jobs.list(agent.id)[0]?.output.total).toBe(5)
  input('next-step')
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(returned).toBe(false)
  writeFileSync(join(dir, 'release'), '')
  const result = await soon(pending)
  expect(result.isError).toBe(false)
  if (!result.isError) expect(result.value).toMatchObject({ kind: 'foreground', exitCode: 0 })
  expect(ctx.jobs.list(agent.id)).toHaveLength(0)
})

it('a forced release backgrounds a foreground bash command and notifies once after it finishes', async () => {
  const { ctx, agent, dir, notices, call, input } = await setup()
  const pending = call('bash', { command: 'printf ready; while [ ! -f release ]; do sleep 0.01; done; printf finished', description: 'Wait for test release', workdir: dir })
  await expect.poll(() => ctx.jobs.list(agent.id)[0]?.output.total).toBe(5)
  const job = ctx.jobs.list(agent.id)[0]!
  input('next-step')
  expect(ctx.jobs.releaseWaits(agent.id)).toBe(1)
  expect(ctx.jobs.releaseWaits(agent.id)).toBe(0)
  const result = await soon(pending)
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected background handle')
  expect(result.value).toMatchObject({ kind: 'background', jobId: job.id })
  expect(ctx.jobs.get(job.id, agent.id).status).toBe('running')
  expect(notices).toHaveLength(0)
  writeFileSync(join(dir, 'release'), '')
  await expect.poll(() => ctx.jobs.get(job.id, agent.id).status).toBe('completed')
  await expect.poll(() => notices.length).toBe(1)
  const collected = await call('job_output', { job_id: job.id })
  expect(JSON.stringify(collected.content)).toContain('readyfinished')
})

it('steering releases job_output wait without killing the job or suppressing completion', async () => {
  const { ctx, agent, notices, call, input } = await setup()
  const finished = Promise.withResolvers<{ status: 'completed' }>()
  const job = ctx.jobs.start({ kind: 'bash', owner: agent.id, label: 'controlled work', run: (handle) => {
    handle.append('partial')
    return { done: finished.promise, cancel: () => { finished.resolve({ status: 'completed' }) } }
  } })
  const pending = call('job_output', { job_id: job, wait: true, timeout_ms: 10000 })
  await new Promise(resolve => setTimeout(resolve, 20))
  input('next-step')
  const result = await soon(pending)
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain('partial')
  expect(ctx.jobs.get(job, agent.id).status).toBe('running')
  finished.resolve({ status: 'completed' })
  await expect.poll(() => notices.length).toBe(1)
})

it('explicitly queued input leaves a foreground command attached', async () => {
  const { ctx, agent, dir, call, input } = await setup()
  let returned = false
  const pending = call('bash', { command: 'printf ready; while [ ! -f release ]; do sleep 0.01; done; printf finished', description: 'Wait for test release', workdir: dir }).then((result) => { returned = true; return result })
  await expect.poll(() => ctx.jobs.list(agent.id)[0]?.output.total).toBe(5)
  input('next-turn')
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(returned).toBe(false)
  writeFileSync(join(dir, 'release'), '')
  const result = await soon(pending)
  expect(result.isError).toBe(false)
  if (!result.isError) expect(result.value).toMatchObject({ kind: 'foreground', exitCode: 0 })
})

it('a human message already waiting releases the next job wait immediately', async () => {
  const { ctx, agent, call, input, notices } = await setup()
  const finished = Promise.withResolvers<{ status: 'completed' }>()
  const id = ctx.jobs.start({ kind: 'bash', owner: agent.id, label: 'pending steering', run: () => ({ done: finished.promise, cancel: () => { finished.resolve({ status: 'completed' }) } }) })
  input('next-step')
  const result = await soon(call('job_output', { job_id: id, wait: true, timeout_ms: 10000 }))
  expect(result.isError).toBe(false)
  expect(ctx.jobs.get(id, agent.id).status).toBe('running')
  finished.resolve({ status: 'completed' })
  await expect.poll(() => notices.length).toBe(1)
})

it('same-tick settlement and steering still deliver completion exactly once', async () => {
  const { ctx, agent, call, input, notices } = await setup()
  const finished = Promise.withResolvers<{ status: 'completed' }>()
  const id = ctx.jobs.start({ kind: 'bash', owner: agent.id, label: 'racing completion', run: (handle) => {
    handle.append('complete result')
    return { done: finished.promise, cancel: () => { finished.resolve({ status: 'completed' }) } }
  } })
  const waiting = call('job_output', { job_id: id, wait: true, timeout_ms: 10000 })
  await new Promise(resolve => setTimeout(resolve, 20))
  finished.resolve({ status: 'completed' })
  input('next-step')
  const result = await soon(waiting)
  expect(JSON.stringify(result.content)).toContain('complete result')
  await expect.poll(() => ctx.jobs.get(id, agent.id).status).toBe('completed')
  expect(notices.length).toBeLessThanOrEqual(1)
})
