import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedModel, provideWorkingDirectoryFixture, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandSkills from '@deepseek-ai/dsh-command-skills'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly dispose: () => Promise<void>
}

async function harness(config: commandSkills.Config = {}): Promise<Harness> {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillRegistry)
  const plugin = await ctx.plugin(commandSkills, config)
  const id = SessionId('command-skills')
  const agent: Agent = {
    id, model: unsupportedModel(), options: {}, session: Session.create(id), inbox: unsupportedInbox(),
    status: 'idle', ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { ctx, agent, dispose: () => plugin.dispose() }
}

async function run(
  test: Harness,
  suffix = '',
  controller = new AbortController(),
): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>> {
  const execution = await test.ctx.commands.execute(test.agent, `/skills${suffix}`, [], controller.signal)
  if (execution === undefined) throw new Error('skills command was not registered')
  return execution
}

function result(execution: { readonly result: CommandResult }): string {
  if (execution.result.kind !== 'success') throw new Error(`expected success, got ${execution.result.kind}`)
  return execution.result.text ?? ''
}

describe('dsh-command-skills', () => {
  it('lists installed skills with descriptions and discovery sources', async () => {
    const test = await harness()
    test.ctx.skills.register({ name: 'zeta-skill', description: 'Zeta description', source: 'user-dsh', content: 'z' })
    test.ctx.skills.register({ name: 'alpha-skill', description: 'Alpha   description', source: 'project-dsh', content: 'a' })

    const execution = await run(test)

    expect(result(execution)).toEqual(
      [
        '2 installed skills:',
        '- alpha-skill — Alpha description [project-dsh]',
        '- zeta-skill — Zeta description [user-dsh]',
      ].join('\n'),
    )
  })

  it('lists skills a model cannot load', async () => {
    const test = await harness()
    test.ctx.skills.register({
      name: 'human-only-skill',
      description: 'Human-only skill.',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'user-agents',
      content: 'body',
    })

    expect(result(await run(test))).toEqual(
      ['1 installed skills:', '- human-only-skill — Human-only skill. [user-agents]'].join('\n'),
    )
  })

  it('truncates descriptions to the configured maximum', async () => {
    const test = await harness({ descriptionMaxLength: 20 })
    test.ctx.skills.register({ name: 'long-skill', description: 'First sentence. Second sentence.', source: 'custom', content: 'body' })

    expect(result(await run(test))).toEqual(
      ['1 installed skills:', '- long-skill — First sentence. S... [custom]'].join('\n'),
    )
  })

  it('reports an empty catalog', async () => {
    const test = await harness()

    expect(result(await run(test))).toEqual('No skills are installed for this session.')
  })

  it('rejects arguments with the usage line', async () => {
    const test = await harness()

    const execution = await run(test, ' extra')

    expect(execution.result).toEqual({ kind: 'error', text: 'Usage: /skills (no arguments)' })
  })

  it('records the command lifecycle pair outside model history', async () => {
    const test = await harness()
    test.ctx.skills.register({ name: 'logged-skill', description: 'Logged.', source: 'user-dsh', content: 'body' })

    const execution = await run(test)
    const events = test.agent.session.snapshotEvents()

    expect(events.map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(events[0]?.data).toEqual({
      commandId: execution.commandId,
      name: 'skills',
      args: '',
      source: { kind: 'user' },
    })
    expect(events[1]?.data).toEqual({
      commandId: execution.commandId,
      kind: 'success',
      text: result(execution),
    })
    expect(test.agent.session.surface.nodes).toEqual([])
    expect(test.agent.session.deriveMessages()).toEqual([])
  })

  it('removes /skills when the plugin fiber is disposed', async () => {
    const test = await harness()
    test.ctx.skills.register({ name: 'disposed-skill', description: 'Disposed.', source: 'user-dsh', content: 'body' })
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-skills',
      name: 'skills',
      description: 'List installed skills',
    })

    await test.dispose()

    expect(test.ctx.commands.list(test.agent).map(command => command.name)).not.toContain('skills')
    expect(await test.ctx.commands.execute(test.agent, '/skills', [], new AbortController().signal)).toBeUndefined()
  })
})
