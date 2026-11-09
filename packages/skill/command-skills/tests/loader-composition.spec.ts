import { unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandSkills from '@deepseek-ai/dsh-command-skills'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Fixed-directory collaborator so the command resolves the temp project root. */
const workingDirectoryFixture = {
  name: 'test-working-directory',
  apply(ctx: Context): void {
    const directory = join(root ?? tmpdir(), 'project')
    ctx.provide('workingDirectory', {
      defaultDirectory: directory,
      get: () => directory,
      ensure: () => Promise.resolve(directory),
    })
  },
}

describe('command-skills real Loader composition', () => {
  it('discovers and executes /skills over skills discovered from disk', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-skills-loader-'))
    const home = join(root, '.dsh')
    const skillDir = join(home, 'skills', 'demo-skill')
    const projectDir = join(root, 'project')
    await mkdir(skillDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), [
      '---',
      'name: demo-skill',
      'description: Lists the demo workflow for the loader composition test.',
      '---',
      'Demo body.',
      '',
    ].join('\n'))

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@deepseek-ai/dsh-skill'",
      "- name: '@deepseek-ai/dsh-skill-filesystem'",
      '  config:',
      `    dshHome: ${JSON.stringify(home)}`,
      `    agentsHome: ${JSON.stringify(join(root, '.agents'))}`,
      '    watch: false',
      "- name: '@test/working-directory'",
      "- name: '@deepseek-ai/dsh-command-skills'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-skill', SkillRegistry],
      ['@deepseek-ai/dsh-skill-filesystem', skillFileSystem],
      ['@test/working-directory', workingDirectoryFixture],
      ['@deepseek-ai/dsh-command-skills', commandSkills],
    ])
    // The Loader resolves plugins through `import` only; every other member fails loudly if it is ever reached.
    const unused = (member: string) => (): never => {
      throw new Error(`unexpected Loader internal call: ${member}`)
    }
    const internal: ModuleLoaderV2 = {
      version: 'v2',
      loadCache: Object.assign(new Map(), { get: unused('loadCache.get'), set: unused('loadCache.set'), has: unused('loadCache.has') }),
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
      register: unused('register'),
      getOrCreateModuleJob: unused('getOrCreateModuleJob'),
      resolveSync: unused('resolveSync'),
      load: unused('load'),
    }
    context.loader.internal = internal
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const id = SessionId('loader-command-skills')
    const session = Session.create(id)
    const agent: Agent = {
      id, model: unsupportedModel(), options: {}, session, inbox: unsupportedInbox(),
      status: 'idle', ctx: context,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    expect(context.commands.list(agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-skills',
      name: 'skills',
      description: 'List installed skills',
    })

    const execution = await context.commands.execute(agent, '/skills', [], new AbortController().signal)
    if (execution === undefined) throw new Error('Loader composition did not resolve /skills')
    const text = [
      '1 installed skills:',
      '- demo-skill — Lists the demo workflow for the loader composition test. [user-dsh]',
    ].join('\n')
    expect(execution.result).toEqual({ kind: 'success', text })

    const rejected = await context.commands.execute(agent, '/skills extra', [], new AbortController().signal)
    expect(rejected?.result).toEqual({ kind: 'error', text: 'Usage: /skills (no arguments)' })

    expect(session.snapshotEvents().map(event => ({ type: event.type, data: event.data }))).toEqual([
      {
        type: 'command/run',
        data: { commandId: execution.commandId, name: 'skills', args: '', source: { kind: 'user' } },
      },
      {
        type: 'command/done',
        data: { commandId: execution.commandId, kind: 'success', text },
      },
      {
        type: 'command/run',
        data: { commandId: rejected!.commandId, name: 'skills', args: ' extra', source: { kind: 'user' } },
      },
      {
        type: 'command/done',
        data: { commandId: rejected!.commandId, kind: 'error', text: 'Usage: /skills (no arguments)' },
      },
    ])
    expect(session.surface.nodes).toEqual([])
    expect(session.deriveMessages()).toEqual([])
  })
})
