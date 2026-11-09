import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDshArgs, profileDirectoryExists, type ProfileLookup } from '../src/args.ts'

/** The suite's $DSH_HOME holds one initialized custom profile, `custom`. */
const customOnly: ProfileLookup = name => name === 'custom'

const parse = (argv: string[], manageDesktopProfile = false, profileExists: ProfileLookup = customOnly) =>
  parseDshArgs(argv, '1.2.3', manageDesktopProfile, profileExists)

/** Capture the process exit code while muting Commander's output. */
function exitCode(argv: string[], manageDesktopProfile = false): number {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    parse(argv, manageDesktopProfile)
    throw new Error(`expected ${JSON.stringify(argv)} to exit`)
  } catch {
    return exit.mock.calls.at(-1)?.[0] as number
  } finally {
    vi.restoreAllMocks()
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('parseDshArgs', () => {
  it('routes profile boots and shorthand, handing the rest to the app', () => {
    expect(parse(['--profile', 'tui'])).toEqual({ mode: 'profile', profile: 'tui', patches: [], args: [] })
    expect(parse(['--profile', 'tui', '--patch', 'a.yml', '--patch', 'b.yml']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: ['a.yml', 'b.yml'], args: [] })
    expect(parse(['--profile', 'rescue', '--from-default-profile', 'web']))
      .toEqual({ mode: 'profile', profile: 'rescue', fromDefaultProfile: 'web', patches: [], args: [] })
    expect(parse(['web'])).toEqual({ mode: 'profile', profile: 'web', patches: [], args: [] })
    expect(parse(['web', '--patch', 'web.yml']))
      .toEqual({ mode: 'profile', profile: 'web', patches: ['web.yml'], args: [] })
  })

  it('ends the launcher flags at the first token it does not own', () => {
    // App flags, including its -h, and positionals reach the app verbatim.
    expect(parse(['--profile', 'tui', '--resume', 'abc']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: [], args: ['--resume', 'abc'] })
    expect(parse(['--profile', 'web', '-h']))
      .toEqual({ mode: 'profile', profile: 'web', patches: [], args: ['-h'] })
    expect(parse(['web', '--host', '127.0.0.1', '--port', '8080', '--no-open', '--future-web-flag']))
      .toEqual({ mode: 'profile', profile: 'web', patches: [], args: ['--host', '127.0.0.1', '--port', '8080', '--no-open', '--future-web-flag'] })
    expect(parse(['--profile', 'headless', 'run', 'the', 'tests']))
      .toEqual({ mode: 'profile', profile: 'headless', patches: [], args: ['run', 'the', 'tests'] })
    // Launcher flags placed after that boundary belong to the app too.
    expect(parse(['--profile', 'tui', '--patch', 'a.yml', '--resume', 'b', '--patch', 'late.yml']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: ['a.yml'], args: ['--resume', 'b', '--patch', 'late.yml'] })
    expect(parse(['--profile', 'rescue', '--resume', 'abc', '--from-default-profile', 'web']))
      .toEqual({
        mode: 'profile',
        profile: 'rescue',
        patches: [],
        args: ['--resume', 'abc', '--from-default-profile', 'web'],
      })
    expect(parse(['web', '--from-default-profile', 'web']))
      .toEqual({ mode: 'profile', profile: 'web', fromDefaultProfile: 'web', patches: [], args: [] })
  })

  it.each(['web', 'headless', 'sdk', 'sdk-minimal', 'acp', 'tui'])('expands shipped %s without looking up profiles', (profile) => {
    const noLookup: ProfileLookup = (name) => { throw new Error(`looked up ${name}`) }
    for (const args of [
      [], ['task', 'words'], ['--help'], ['-h'], ['web'],
      ['--patch', 'a.yml', '--patch', 'b.yml'],
      ['--dump-config'], ['--', '--', 'task'], ['plugin'],
    ]) {
      expect(parse([profile, ...args], false, noLookup)).toEqual(parse(['--profile', profile, ...args], false, noLookup))
    }
  })

  // Upstream expanded every leading word; here only words that name a profile
  // do, so `custom` is an initialized profile and `run`/`help` (no such
  // profile) become the chat's prompt unless a launcher flag follows them.
  it.each(['custom', 'run', 'help'])('expands %s like --profile when it names a profile', (profile) => {
    const lookup: ProfileLookup = name => name === profile
    for (const args of [
      [], ['task', 'words'], ['--help'], ['-h'], ['web'],
      ['--patch', 'a.yml', '--patch', 'b.yml'],
      ['--from-default-profile', 'web', '--help'],
      ['--dump-config'], ['--dump-default-config'], ['--dump-config-schema'],
      ['--patch', 'a.yml', '--resume', 'id', '--patch', 'late.yml'],
      ['--', '--help'], ['--', '--', 'task'],
      ['plugin'], ['--', 'plugin'],
    ]) {
      expect(parse([profile, ...args], false, lookup)).toEqual(parse(['--profile', profile, ...args], false, lookup))
    }
  })

  it.each(['run', 'help', 'fix the failing tests', 'resume', 'continue', 'Web', 'node_modules', '..'])('hands non-profile word %j to the terminal chat', (word) => {
    const none: ProfileLookup = () => false
    expect(parse([word], false, none)).toEqual({ mode: 'profile', profile: 'tui', patches: [], args: [word] })
    expect(parse([word, 'more', '--words', '-V'], false, none))
      .toEqual({ mode: 'profile', profile: 'tui', patches: [], args: [word, 'more', '--words', '-V'] })
    // A launcher flag after the word makes it a profile name.
    expect(parse([word, '--patch', 'a.yml'], false, none)).toMatchObject({ profile: word, patches: ['a.yml'] })
    expect(parse([word, '--dump-default-config'], false, none)).toMatchObject({ mode: 'dump-config', profile: word })
  })

  it('boots the terminal chat when no profile is named', () => {
    const tui = { mode: 'profile', profile: 'tui', patches: [] }
    expect(parse([])).toEqual({ ...tui, args: [] })
    expect(parse(['fix the failing tests'])).toEqual({ ...tui, args: ['fix the failing tests'] })
    expect(parse(['fix', 'the', 'tests'])).toEqual({ ...tui, args: ['fix', 'the', 'tests'] })
    expect(parse(['--continue'])).toEqual({ ...tui, args: ['--continue'] })
    expect(parse(['-c', 'and then'])).toEqual({ ...tui, args: ['-c', 'and then'] })
    expect(parse(['--resume'])).toEqual({ ...tui, args: ['--resume'] })
    expect(parse(['--resume', 'session-1'])).toEqual({ ...tui, args: ['--resume', 'session-1'] })
    expect(parse(['-r', 'session-1', 'next step'])).toEqual({ ...tui, args: ['-r', 'session-1', 'next step'] })
    expect(parse(['resume', '--last'])).toEqual({ ...tui, args: ['resume', '--last'] })
    expect(parse(['-m', 'deepseek/chat', 'hi'])).toEqual({ ...tui, args: ['-m', 'deepseek/chat', 'hi'] })
    // `--` keeps a prompt that is also a profile name for the chat.
    expect(parse(['--', 'web'])).toEqual({ ...tui, args: ['web'] })
    expect(parse(['--', 'custom', '--patch', 'x.yml'])).toEqual({ ...tui, args: ['custom', '--patch', 'x.yml'] })
    // Launcher flags still apply to the chat profile.
    expect(parse(['--patch', 'a.yml', 'hello'])).toEqual({ ...tui, patches: ['a.yml'], args: ['hello'] })
    expect(parse(['--patch', 'a.yml', 'tui'])).toEqual({ ...tui, patches: ['a.yml'], args: ['tui'] })
    expect(parse(['--dump-config'])).toEqual({ mode: 'dump-config', profile: 'tui', defaultOnly: false, patches: [] })
    expect(parse(['--dump-default-config'])).toEqual({ mode: 'dump-config', profile: 'tui', defaultOnly: true, patches: [] })
    expect(parse(['--dump-config-schema'])).toEqual({ mode: 'dump-config-schema', profile: 'tui', patches: [] })
    // Flags the launcher no longer owns reach the chat, which rejects what it does not know.
    expect(parse(['--config', 'c.yml'])).toEqual({ ...tui, args: ['--config', 'c.yml'] })
    expect(parse(['-p', 'task'])).toEqual({ ...tui, args: ['-p', 'task'] })
    expect(parse(['--bogus'])).toEqual({ ...tui, args: ['--bogus'] })
  })

  it.each([['--web'], ['-web']])('spells the web profile as a leading %s', (flag) => {
    expect(parse([flag])).toEqual(parse(['web']))
    expect(parse([flag, '--port', '8080', '--no-open']))
      .toEqual({ mode: 'profile', profile: 'web', patches: [], args: ['--port', '8080', '--no-open'] })
    expect(parse([flag, '--patch', 'w.yml', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: false, patches: ['w.yml'] })
    // Only the leading token is the launcher's; later it belongs to the app.
    expect(parse(['tui', flag])).toMatchObject({ profile: 'tui', args: [flag] })
    expect(parse(['--patch', 'a.yml', flag])).toMatchObject({ profile: 'tui', args: [flag] })
    expect(exitCode([flag, '--profile', 'tui'])).toBe(1)
  })

  it('looks custom profiles up under $DSH_HOME/profiles', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-args-home-'))
    try {
      mkdirSync(join(home, 'profiles', 'mine'), { recursive: true })
      vi.stubEnv('DSH_HOME', home)
      expect(profileDirectoryExists('mine')).toBe(true)
      expect(profileDirectoryExists('other')).toBe(false)
      expect(profileDirectoryExists('..')).toBe(false)
      expect(profileDirectoryExists('a/b')).toBe(false)
      expect(parseDshArgs(['mine', 'task'], '1.2.3')).toEqual({ mode: 'profile', profile: 'mine', patches: [], args: ['task'] })
      expect(parseDshArgs(['other', 'task'], '1.2.3')).toEqual({ mode: 'profile', profile: 'tui', patches: [], args: ['other', 'task'] })
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reserves leading plugin for management and forwards later command names', () => {
    expect(parse(['--profile', 'plugin'])).toMatchObject({ mode: 'profile', profile: 'plugin' })
    expect(parse(['--profile', 'x', 'plugin', 'add', 'y']))
      .toMatchObject({ mode: 'profile', profile: 'x', args: ['plugin', 'add', 'y'] })
    expect(parse(['headless', 'web'])).toMatchObject({ profile: 'headless', args: ['web'] })
    // After launcher flags or `--`, a profile name is the chat's prompt.
    expect(parse(['--patch', 'a.yml', 'tui'])).toMatchObject({ profile: 'tui', args: ['tui'] })
    expect(parse(['--', 'plugin'])).toMatchObject({ profile: 'tui', args: ['plugin'] })
  })

  it.each([
    [''], ['desktop'], ['Desktop'], ['DESKTOP'],
    ['custom', '--patch='], ['custom', '--from-default-profile='],
    ['custom', '--dump-config', '--dump-default-config'],
    ['custom', '--dump-default-config', '--patch', 'a.yml'],
    ['custom', '--dump-config', 'task'],
  ])('rejects invalid shorthand %j', (...argv: string[]) => {
    expect(exitCode(argv)).toBe(1)
  })

  it.each(['-V', '--version'])('prints the launcher version for shorthand %s', (flag) => {
    expect(exitCode(['custom', flag])).toBe(0)
    expect(parse(['custom', 'task', flag])).toMatchObject({ args: ['task', flag] })
  })

  it.each([
    ['web', '--profile', 'tui'],
    ['--profile', 'web', '--profile', 'tui'],
    ['--profile=web', '--profile=web'],
    ['plugin', '--profile', 'web', '--profile', 'tui', 'add', 'x'],
  ])('rejects repeated profile selection %j', (...argv: string[]) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(exitCode(argv)).toBe(1)
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('select a profile only once')
  })

  it('forwards late profile options to the application', () => {
    expect(parse(['web', 'task', '--profile', 'tui']))
      .toMatchObject({ profile: 'web', args: ['task', '--profile', 'tui'] })
  })

  it('routes the plugin pnpm forwarder', () => {
    expect(parse(['plugin', '--profile', 'tui', 'add', 'turtle-ui']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', 'turtle-ui'] })
    expect(parse(['plugin', '--profile', 'tui', 'remove', 'turtle-ui']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['remove', 'turtle-ui'] })
    expect(parse(['plugin', '--profile', 'tui', 'why', '@deepseek-ai/cordis']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['why', '@deepseek-ai/cordis'] })
    // Unknown pnpm flags forward verbatim.
    expect(parse(['plugin', '--profile', 'tui', 'add', '--save-dev', 'x']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', '--save-dev', 'x'] })
    // Options after the pnpm command belong to pnpm, including the forwarder's own names.
    expect(parse(['plugin', '--profile', 'tui', 'add', '--help']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', '--help'] })
    expect(parse(['plugin', '--profile', 'tui', 'add', '-h', '--profile', 'x']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', '-h', '--profile', 'x'] })
    // A leading pnpm option starts the forwarded arguments before the pnpm command.
    expect(parse(['plugin', '--profile', 'tui', '--filter', 'x', '--profile', 'y', 'add', 'z']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['--filter', 'x', '--profile', 'y', 'add', 'z'] })
    expect(exitCode(['plugin', 'add', 'x', '--profile', 'tui'])).toBe(1)
    expect(exitCode(['plugin', '--filter', 'x', 'add', '--profile', 'tui'])).toBe(1)
  })

  it.each([
    ['plugin', '--help'], ['plugin', '-h'], ['plugin', '--profile', 'tui', '--help'],
    ['plugin', '--profile', 'tui', '--filter', 'x', 'add', '--help'],
  ])('prints the plugin forwarder help for %j', (...argv: string[]) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(exitCode(argv)).toBe(0)
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Usage: dsh plugin [options] [args...]')
  })

  it.each(['desktop', 'Desktop', 'DESKTOP'])('permits installed Desktop plugin commands for %s', (profile) => {
    expect(parse(['plugin', '--profile', profile, 'add', 'example-plugin'], true))
      .toEqual({ mode: 'plugin', profile: 'desktop', args: ['add', 'example-plugin'] })
    expect(exitCode(['plugin', '--profile', profile, 'add', 'example-plugin'])).toBe(1)
  })

  it.each([
    ['desktop'], ['--profile', 'Desktop'],
    ['desktop', '--dump-config'], ['DESKTOP', '--dump-default-config'],
    ['desktop', '--dump-config-schema'],
  ])('keeps Desktop boot and inspection reserved in its installed CLI: %j', (...argv: string[]) => {
    expect(exitCode(argv, true)).toBe(1)
  })

  it('routes profile and web config dumps', () => {
    expect(parse(['--profile', 'web', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: false, patches: [] })
    expect(parse(['--profile', 'web', '--dump-default-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: true, patches: [] })
    expect(parse(['--profile', 'rescue', '--from-default-profile', 'web', '--dump-config']))
      .toEqual({
        mode: 'dump-config',
        profile: 'rescue',
        fromDefaultProfile: 'web',
        defaultOnly: false,
        patches: [],
      })
    expect(parse(['--profile', 'tui', '--dump-config', '--patch', 'x.yml']))
      .toEqual({ mode: 'dump-config', profile: 'tui', defaultOnly: false, patches: ['x.yml'] })
    expect(parse(['web', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: false, patches: [] })
    expect(parse(['web', '--dump-default-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: true, patches: [] })
  })

  it('routes schema dumps with ordered overlays and explicit initialization', () => {
    expect(parse(['--profile', 'web', '--dump-config-schema']))
      .toEqual({ mode: 'dump-config-schema', profile: 'web', patches: [] })
    expect(parse(['rescue', '--from-default-profile', 'web', '--patch', 'first.yml', '--dump-config-schema', '--patch', 'second.json']))
      .toEqual({
        mode: 'dump-config-schema',
        profile: 'rescue',
        fromDefaultProfile: 'web',
        patches: ['first.yml', 'second.json'],
      })
    expect(parse(['web', '--port', '8080', '--dump-config-schema']))
      .toMatchObject({ mode: 'profile', args: ['--port', '8080', '--dump-config-schema'] })
  })

  it.each([
    ['--dump-config', '--dump-default-config'],
    ['--dump-config', '--dump-config-schema'],
    ['--dump-default-config', '--dump-config-schema'],
    ['--dump-config', '--dump-default-config', '--dump-config-schema'],
  ])('rejects competing dump flags %j', (...flags: string[]) => {
    expect(exitCode(['web', ...flags])).toBe(1)
    expect(exitCode(['--profile', 'web', ...flags.toReversed()])).toBe(1)
  })

  it.each([
    ['desktop', '--dump-config-schema'],
    ['--profile', 'Desktop', '--dump-config-schema'],
    ['web', '--dump-config-schema', 'task'],
    ['web', '--dump-config-schema', '--port', '8080'],
    ['web', '--dump-config-schema', '--help'],
    ['web', '--dump-config-schema', '--', '--patch', 'late.yml'],
    ['web', '--dump-config-schema', '--patch='],
    ['rescue', '--dump-config-schema', '--from-default-profile='],
  ])('rejects invalid schema dump inputs %j', (...argv: string[]) => {
    expect(exitCode(argv)).toBe(1)
  })

  it('rejects invalid profile selection and contradictory inputs', () => {
    expect(exitCode(['--profile', ''])).toBe(1)
    expect(exitCode(['--from-default-profile', 'web'])).toBe(1) // no target to create
    expect(exitCode(['--patch', 'a.yml', '--from-default-profile', 'web', 'task'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--from-default-profile='])).toBe(1)
    expect(exitCode(['--profile', 'x', '--from-default-profile'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--patch='])).toBe(1)
    expect(exitCode(['--profile', 'x', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['--dump-config', 'task'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--dump-default-config', '--patch', 'p.yml'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--dump-config', 'task'])).toBe(1)
    expect(exitCode(['web', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['web', '--dump-default-config', '--patch', 'w.yml'])).toBe(1)
    expect(exitCode(['web', '--patch='])).toBe(1)
    // A dump never runs app command-line providers, so it cannot show what
    // those flags would decide; printing a tree that differs from the same
    // invocation's boot would mislead.
    expect(exitCode(['web', '--dump-config', '--port', '8080'])).toBe(1)
    expect(exitCode(['--profile', 'web', '--dump-config', '-h'])).toBe(1)
    expect(exitCode(['plugin', 'add', 'x'])).toBe(1) // --profile required
    expect(exitCode(['plugin', '--profile', 'tui'])).toBe(1) // nothing to forward
    expect(exitCode(['plugin', '--profile', ''])).toBe(1)
    expect(exitCode(['--profile', 'desktop'])).toBe(1)
    expect(exitCode(['--profile', 'Desktop'])).toBe(1)
    expect(exitCode(['--profile', 'DESKTOP'])).toBe(1)
    expect(exitCode(['--profile', 'desktop', '--dump-config'])).toBe(1)
    expect(exitCode(['plugin', '--profile', 'desktop', 'add', 'x'])).toBe(1)
    expect(exitCode(['plugin', '--profile', 'Desktop', 'add', 'x'])).toBe(1)
    expect(exitCode(['--from-default-profile', 'web', 'plugin', '--profile', 'x', 'add', 'y'])).toBe(1)
  })

  it('keeps its own help for an invocation with no app to hand it to', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(exitCode(['--help'])).toBe(0)
    const help = stdout.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(help).not.toContain('help [command]')
    for (const usage of ['Usage: dsh [options] [chat-args...]', 'dsh --continue', 'dsh --resume [session]', 'dsh --web', 'dsh -- web']) {
      expect(help).toContain(usage)
    }
    // Without a named profile, -h/--help prints the launcher's help; the chat's is `dsh tui --help`.
    expect(exitCode(['--continue', '--help'])).toBe(0)
    expect(parse(['tui', '--help'])).toMatchObject({ profile: 'tui', args: ['--help'] })
    expect(exitCode(['-h'])).toBe(0)
    expect(exitCode(['--version'])).toBe(0)
  })
})
