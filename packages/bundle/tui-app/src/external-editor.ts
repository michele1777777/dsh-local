/** Local draft editing, never message submission. Uses Ink's suspendTerminal at the call site. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { powershellArgs } from './local-process.ts'
/** Overrides for the platform, environment and cancellation used to launch the editor; defaults are the current process. */
export interface EditorEnvironment { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
/**
 * Parse quoted executable/arguments without a shell. Backslashes in Windows paths are literal.
 * @param value - the VISUAL/EDITOR value.
 * @returns the executable followed by its arguments.
 * @throws Error when a quote is unclosed or no executable is named.
 */
export function editorWords(value: string): string[] {
  const words: string[] = []; let text = '', quote = '', started = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === undefined) continue
    if (quote !== '') {
      if (char === quote) quote = ''
      else text += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (/\s/u.test(char)) { if (started) { words.push(text); text = ''; started = false }; continue }
    if (char === '\\' && /\s/u.test(value[i + 1] ?? 'x')) { text += value[i + 1] ?? ''; i++; started = true; continue }
    text += char; started = true
  }
  if (quote !== '') throw new Error('Unclosed quote in VISUAL/EDITOR. Quote the executable path and pass arguments separately.')
  if (started) words.push(text)
  if (words.length === 0 || words[0] === '') throw new Error('VISUAL/EDITOR must name an executable.')
  return words
}
/**
 * Build argv with no prompt text in command arguments or a shell command.
 * @param path - the draft file, appended as the last argument.
 * @param options - platform and environment; VISUAL, then EDITOR, then `notepad.exe`/`vi`.
 * @returns the command, arguments and environment to spawn; Windows `.cmd`/`.bat` editors run
 *   through PowerShell with argv in `DSH_TUI_EDITOR_ARGV`.
 * @throws Error when the configured editor fails {@link editorWords}.
 */
export function editorCommand(path: string, options: EditorEnvironment = {}): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = { ...(options.env ?? process.env) }, platform = options.platform ?? process.platform
  const configured = env.VISUAL?.trim() || env.EDITOR?.trim() || (platform === 'win32' ? 'notepad.exe' : 'vi')
  // A bare existing Windows path is accepted even when it contains spaces.
  const words = /^[a-z]:\\[^"\r\n]+\.(?:exe|cmd|bat)$/iu.test(configured) ? [configured] : editorWords(configured)
  // `editorWords` rejects an empty list, so the executable is always present.
  const [first = '', ...args] = words
  let command = first
  const executable = basename(command.replace(/\\/gu, '/')).replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase()
  const guiLauncher = ['code', 'code-insiders', 'codium', 'cursor', 'subl'].includes(executable)
  if (guiLauncher && !args.includes('--wait') && !args.includes('-w')) args.push('--wait')
  // Only known GUI launchers need PATHEXT's .cmd shim. Do not rewrite an
  // arbitrary configured executable or recursively parse quoted arguments.
  if (platform === 'win32' && guiLauncher && !/[\\/]/u.test(command) && !/\.[a-z\d]+$/iu.test(command)) command += '.cmd'
  args.push(path)
  if (platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)) {
    // Windows cannot spawn .cmd directly. Script source is fixed; paths/argv
    // travel via a JSON environment variable, not string-interpolated commands.
    env.DSH_TUI_EDITOR_ARGV = JSON.stringify([command, ...args])
    const script = "$ErrorActionPreference='Stop'; $a=ConvertFrom-Json $env:DSH_TUI_EDITOR_ARGV; $exe=$a[0]; $rest=@(); if($a.Count -gt 1){$rest=$a[1..($a.Count-1)]}; & $exe @rest; if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}"
    return { command: 'powershell.exe', args: powershellArgs(script).filter(arg => arg !== '-NonInteractive'), env }
  }
  return { command, args, env }
}
/**
 * Edit a draft in the external editor. Always delete the private temp file.
 * Failed launch/exit leaves the caller's original draft intact.
 * @param text - the current draft.
 * @param options - platform, environment and an abort signal; SIGINT or abort kills the editor.
 * @returns the edited draft once the editor exits with code 0.
 * @throws Error when the editor fails to launch, exits non-zero, is interrupted, or the draft exceeds 8 MiB.
 */
export async function editDraft(text: string, options: EditorEnvironment = {}): Promise<string> {
  options.signal?.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-draft-')), path = join(directory, 'prompt.md')
  try {
    await writeFile(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const request = editorCommand(path, options)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(request.command, request.args, { env: request.env, shell: false, stdio: 'inherit' })
      let finished = false, failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
      const cancel = (): void => {
        if (finished || failure !== undefined) return
        failure = new Error('Editor interrupted. The original draft was retained.')
        child.kill()
        killTimer = setTimeout(() => { child.kill('SIGKILL') }, 250).unref()
      }
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true
        process.removeListener('SIGINT', cancel)
        options.signal?.removeEventListener('abort', cancel)
        if (killTimer !== undefined) clearTimeout(killTimer)
        const cause = error ?? failure
        if (cause !== undefined) reject(cause)
        else resolve()
      }
      // While Ink lends the terminal to a cooked-mode editor, Ctrl+C must not
      // terminate DSH and lose the session. Wait for the child to close before
      // restoring the UI or deleting its draft file.
      process.on('SIGINT', cancel)
      options.signal?.addEventListener('abort', cancel, { once: true })
      if (options.signal?.aborted) cancel()
      child.once('error', (error) => { finish(error) })
      child.once('close', (code, signal) => { finish(code === 0 ? undefined : new Error(`Editor closed without accepting the draft (${signal ?? `exit ${code}`}). The original draft was retained.`)) })
    })
    options.signal?.throwIfAborted()
    if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error('Edited draft exceeds 8 MiB; the original draft was retained.')
    return await readFile(path, 'utf8')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
