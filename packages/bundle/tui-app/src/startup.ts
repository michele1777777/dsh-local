/** CLI startup provider. Both `dsh resume` and the -r/-c forms use one parser. */
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
/** Cordis service name under which the parsed startup values are provided. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'
/** Parsed launch request: opening task, resume target or picker, and new-session model, effort and preset. */
export interface TuiStartupValues {
  task: string | undefined
  resumeId: string | undefined
  pick: boolean
  continueLast: boolean
  all: boolean
  model: string | undefined
  effort: string | undefined
  preset: string | undefined
}
interface Options {
  resume?: string | boolean
  continue?: boolean
  all?: boolean
  last?: boolean
  model?: string
  effort?: string
  preset?: string
}
/**
 * Build the `dsh` command with the `resume` and `continue` subcommands. Conflicting flags fail through commander's `error`.
 * @param provide - receives the values once a command action runs.
 * @returns the configured command, not yet parsed.
 */
export function tuiCommand(provide: (value: TuiStartupValues) => void): Command {
  const program = new Command().name('dsh').description('DeepSeek Harness · interactive terminal workspace')
    .helpOption('-h, --help', 'show terminal help')
    .option('-r, --resume [id]', 'resume ID/title, or open a searchable picker')
    .option('-c, --continue', 'continue the latest active session in this directory')
    .option('--all', 'include sessions from other directories in the picker')
    .option('-m, --model <provider/model>', 'select the model through the Web model controller')
    .option('--effort <effort>', 'select an adapter-supported reasoning effort')
    .option('--preset <name>', 'agent preset for a NEW session')
    .argument('[prompt...]', 'opening prompt; quote multiline prompts')
  const finish = (args: readonly string[], options: Options): void => {
    if (options.resume !== undefined && options.continue === true) program.error('--resume and --continue are mutually exclusive')
    const resumeId = typeof options.resume === 'string' ? options.resume.trim() : undefined
    if (resumeId === '') program.error('--resume requires a non-empty session ID')
    if (options.preset !== undefined && (options.resume !== undefined || options.continue === true)) program.error('--preset only applies to a new session')
    const task = args.join(' ')
    provide({ task: task.trim() === '' ? undefined : task, resumeId, pick: options.resume === true,
      continueLast: options.continue === true, all: options.all === true,
      model: options.model, effort: options.effort, preset: options.preset })
  }
  program.action((args: string[], options: Options) => { finish(args, options) })
  program.command('resume [id] [prompt...]').description('resume a saved session; no ID opens the picker')
    .option('--last', 'continue the most recently active session')
    .option('--all', 'show sessions from all directories')
    .action((id: string | undefined, prompt: string[], _options: Options, command: Command) => {
      const options = command.optsWithGlobals<Options>()
      if (options.last === true && id !== undefined) command.error('resume accepts an ID or --last, not both')
      if (options.resume !== undefined || options.continue === true) command.error('do not combine resume with -r or -c')
      finish(prompt, { ...options, ...(options.last === true ? { continue: true } : { resume: id ?? true }) })
    })
  program.command('continue [prompt...]').description('continue the latest session in this directory')
    .action((prompt: string[], _options: Options, command: Command) => {
      finish(prompt, { ...command.optsWithGlobals<Options>(), continue: true })
    })
  program.addHelpText('after', `
Examples:
  dsh                          New chat
  dsh "fix the failing tests"   New chat with an opening prompt
  dsh resume                   Searchable saved-session picker
  dsh resume --last            Continue latest activity in this directory
  dsh resume --all             Browse sessions from every directory
  dsh resume session-<uuid>    Resume exactly that session and its preset
  dsh -c                      Same as dsh continue
  dsh -r session-<uuid>        Same as dsh resume session-<uuid>

Inside the chat: /help · /resume · /model · /compact · /queue
Enter sends · Alt+Enter / Ctrl+J inserts a newline · Esc cancels
`)
  return program
}
export function apply(ctx: Context): void {
  parseCmdline(ctx, tuiCommand((value) => { ctx.provide(TUI_STARTUP_SERVICE, value) }))
}
