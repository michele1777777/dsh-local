/** Clipboard adapters for the user's terminal host, not tools available to the agent. */
import { powershellArgs, runProcess, type ProcessRequest, type ProcessRunner } from './local-process.ts'
/** Injectable host facts and effects; each omitted field falls back to the current process. */
export interface ClipboardEnvironment {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: ProcessRunner
  write?: (value: string) => void
  signal?: AbortSignal
}
/** Copy outcome; `confirmed` is false when only an unacknowledged OSC 52 request was written. */
export interface CopyResult { confirmed: boolean; transport: string }
const remote = (env: NodeJS.ProcessEnv): boolean => Boolean(env.SSH_CONNECTION || env.SSH_TTY)
const windowsClipboard = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean => platform === 'win32' || Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)
/** PowerShell script that sets the Windows clipboard from base64 UTF-8 on stdin; empty text clears it. */
export const COPY_SCRIPT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); if($s.Length -eq 0){[Windows.Forms.Clipboard]::Clear()}else{[Windows.Forms.Clipboard]::SetText($s)}"
/**
 * Native adapters in priority order; all preserve text without executing it.
 * @param text - text to copy.
 * @param platform - host platform.
 * @param env - host environment; SSH sessions yield no adapters.
 * @returns process requests to try in order; empty when no native adapter applies.
 */
export function copyRequests(text: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ProcessRequest[] {
  if (remote(env)) return []
  if (windowsClipboard(platform, env)) return [{ command: 'powershell.exe', args: powershellArgs(COPY_SCRIPT), input: Buffer.from(text, 'utf8').toString('base64') }]
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [], input: text }]
  return [...(env.WAYLAND_DISPLAY ? [{ command: 'wl-copy', args: ['--type', 'text/plain;charset=utf-8'], input: text }] : []),
    ...(env.DISPLAY ? [{ command: 'xclip', args: ['-selection', 'clipboard', '-in'], input: text }, { command: 'xsel', args: ['--clipboard', '--input'], input: text }] : [])]
}
/**
 * OSC 52 is a request, not an acknowledgement that the clipboard changed.
 * @param text - text to copy.
 * @param tmux - wrap the sequence in a tmux passthrough.
 * @returns the escape sequence.
 * @throws when the text exceeds 100,000 UTF-8 bytes.
 */
export function osc52(text: string, tmux = false): string {
  if (Buffer.byteLength(text, 'utf8') > 100_000) throw new Error('This block is too large for the terminal clipboard fallback. Use a native clipboard helper or /export.')
  const sequence = `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
  return tmux ? `\x1bPtmux;${sequence.replace(/\x1b/gu, '\x1b\x1b')}\x1b\\` : sequence
}
/**
 * Copy text by `DSH_TUI_CLIPBOARD` mode (`auto`, `native`, `osc52`, `off`): native adapters first, then OSC 52 when `write` is given.
 * @param text - text to copy.
 * @param options - host overrides and cancellation.
 * @returns which transport accepted the text.
 * @throws on an invalid or `off` mode, abort, or when no transport is available.
 */
export async function copyText(text: string, options: ClipboardEnvironment = {}): Promise<CopyResult> {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform, run = options.run ?? runProcess
  const mode = env.DSH_TUI_CLIPBOARD ?? 'auto'
  if (!['auto', 'native', 'osc52', 'off'].includes(mode)) throw new Error('DSH_TUI_CLIPBOARD must be auto, native, osc52 or off.')
  if (mode === 'off') throw new Error('Clipboard disabled by DSH_TUI_CLIPBOARD=off. Use terminal selection or /export.')
  options.signal?.throwIfAborted()
  let lastError: unknown
  if (mode !== 'osc52') for (const request of copyRequests(text, platform, env)) {
    const cancel = options.signal === undefined ? {} : { signal: options.signal }
    try { await run({ ...request, captureOutput: false, env, ...cancel }); return { confirmed: true, transport: request.command } }
    catch (error) { options.signal?.throwIfAborted(); lastError = error }
  }
  if (mode !== 'native' && options.write !== undefined) {
    options.write(osc52(text, Boolean(env.TMUX)))
    return { confirmed: false, transport: 'OSC 52' }
  }
  throw new Error(`Clipboard unavailable. ${lastError instanceof Error ? lastError.message : 'Install wl-copy (Wayland), xclip/xsel (X11), or use a terminal with OSC 52 support.'}`)
}
/** PNG read from the local clipboard with dimensions from its IHDR chunk. */
export interface ClipboardImage { data: Buffer; mediaType: 'image/png'; width: number; height: number }
const MAC_IMAGE_SCRIPT = `ObjC.import('AppKit'); ObjC.import('Foundation');
var p=$.NSPasteboard.generalPasteboard; var d=p.dataForType($.NSPasteboardTypePNG);
if(!d || d.isNil()){var i=$.NSImage.alloc.initWithPasteboard(p); if(!i || i.isNil()) throw Error('No image in clipboard');
var b=$.NSBitmapImageRep.imageRepWithData(i.TIFFRepresentation); d=b.representationUsingTypeProperties(4,$.NSDictionary.dictionary);}
if(!d || d.isNil()) throw Error('No PNG image in clipboard');
if(Number(d.length)>Number(ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('DSH_TUI_IMAGE_LIMIT')))) throw Error('Image exceeds the configured Web admission limit');
ObjC.unwrap(d.base64EncodedStringWithOptions(0));`
/**
 * Read only on an explicit paste action. Remote clipboard reads are never attempted.
 * @param maxBytes - largest accepted PNG size in bytes.
 * @param options - host overrides and cancellation.
 * @returns the clipboard PNG.
 * @throws over SSH, on abort, on an invalid limit, or when no adapter yields a PNG within the limit.
 */
export async function readClipboardImage(maxBytes: number, options: ClipboardEnvironment = {}): Promise<ClipboardImage> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid Web image admission limit')
  const env = options.env ?? process.env, platform = options.platform ?? process.platform, run = options.run ?? runProcess
  if (remote(env)) throw new Error('Clipboard image paste is not available over SSH. Save the image on the session host and use /image path.')
  options.signal?.throwIfAborted()
  const requests: { request: ProcessRequest; base64: boolean }[] = []
  if (windowsClipboard(platform, env)) {
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i=[Windows.Forms.Clipboard]::GetImage(); if($null -eq $i){throw 'No image in clipboard'}; $m=New-Object IO.MemoryStream; try{$i.Save($m,[Drawing.Imaging.ImageFormat]::Png); if($m.Length -gt ${maxBytes}){throw 'Image exceeds the configured Web admission limit'}; [Console]::Out.Write([Convert]::ToBase64String($m.ToArray()))}finally{$m.Dispose();$i.Dispose()}`
    requests.push({ request: { command: 'powershell.exe', args: powershellArgs(script) }, base64: true })
  } else if (platform === 'darwin') requests.push({ request: { command: 'osascript', args: ['-l', 'JavaScript', '-e', MAC_IMAGE_SCRIPT] }, base64: true })
  else {
    if (env.WAYLAND_DISPLAY) requests.push({ request: { command: 'wl-paste', args: ['--no-newline', '--type', 'image/png'] }, base64: false })
    if (env.DISPLAY) requests.push({ request: { command: 'xclip', args: ['-selection', 'clipboard', '-target', 'image/png', '-out'] }, base64: false })
  }
  let lastError: unknown
  for (const { request, base64 } of requests) {
    try {
      const bytes = await run({ ...request, maxBytes: base64 ? Math.ceil(maxBytes / 3) * 4 + 16 : maxBytes,
        env: { ...env, DSH_TUI_IMAGE_LIMIT: String(maxBytes) }, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      const data = base64 ? Buffer.from(bytes.toString('ascii').trim(), 'base64') : bytes
      if (data.length > maxBytes) throw new Error('Image exceeds the configured Web admission limit')
      if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Clipboard does not contain a PNG image')
      return { data, mediaType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
    } catch (error) { options.signal?.throwIfAborted(); lastError = error }
  }
  throw new Error(`Cannot paste an image: ${lastError instanceof Error ? lastError.message : 'no local image clipboard adapter; use /image path instead.'}`)
}
