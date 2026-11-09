/** Deterministic vetoes. No shell command is auto-granted by a name/prefix match. */

import { posix, win32 } from 'node:path'
import type { ReviewDecision } from './protocol.ts'

/** Complete, already materialized operation submitted for review. */
export interface ReviewAction {
  name: string
  arguments: unknown
  cwd: string
}

/** Deployment-specific, exact-name tool restrictions. */
export interface PolicyOptions {
  deniedTools: readonly string[]
  humanOnlyTools: readonly string[]
}

/**
 * Read a JSON object without trusting model-supplied fields.
 * @param value - a parsed JSON value.
 * @returns the value as a record when it is a non-array object, otherwise `undefined`.
 */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Whether a declared path lexically escapes its workspace; the real sandbox still enforces access. */
function outsideWorkspace(path: string, cwd: string): boolean {
  if (path.startsWith('~') || path.includes('\0') || path.startsWith('\\\\') || path.startsWith('//')) return true
  const paths = /^[a-z]:[\\/]/i.test(cwd) ? win32 : posix
  // A Windows drive on a POSIX host or a drive-relative Windows path is ambiguous.
  if (/^[a-z]:/i.test(path) && (!/^[a-z]:[\\/]/i.test(cwd) || !/^[a-z]:[\\/]/i.test(path))) return true
  const relative = paths.relative(paths.resolve(cwd), paths.resolve(cwd, path))
  return relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)
}

const SENSITIVE = new RegExp(String.raw`(?:^|[\\/\s"'=])(?:\.env(?:\.[\w-]+)?|\.ssh|\.aws|\.azure|\.kube|\.gnupg|credentials|id_rsa|id_ed25519)(?:$|[\\/\s"'])|(?:password|secret|private[_ -]?key|access[_ -]?token|credential|authorization)`, 'i')
const HUMAN_COMMAND = new RegExp(String.raw`(?:^|[\s;&|()])(?:sudo|doas|su|rm|rmdir|del|erase|remove-item|clear-content|format-volume|format|diskpart|reg|icacls|takeown|chmod|chown|set-acl|ssh|scp|sftp|rsync|curl|wget|invoke-restmethod|invoke-webrequest|aws|az|gcloud|kubectl|terraform)(?:\s|$)|\bgit\s+(?:push|reset|clean|rebase|checkout|restore)\b|\b(?:-enc(?:odedcommand)?|iex|invoke-expression|start-process|runas)\b`, 'i')
const OPAQUE_SHELL = new RegExp('[\\n\\r;&|<>`]|\\$\\(|\\$\\{|\\beval\\b|\\bexec\\b|\\b(?:bash|sh|zsh|cmd|powershell|pwsh)\\s+(?:-[ce]|\\/c)\\b', 'i')

/**
 * Apply explicit denies and conservative human-only checks before any LLM call.
 * @param action - exact tool identity, full arguments, and workspace.
 * @param options - host-owned exact tool restrictions.
 * @returns a final deny/ask, or undefined when isolated review is eligible.
 */
export function staticDecision(action: ReviewAction, options: PolicyOptions): ReviewDecision | undefined {
  if (options.deniedTools.includes(action.name)) {
    return { decision: 'deny', risk: 'high', reason: 'This tool is denied by the host Smart approval policy.' }
  }
  if (options.humanOnlyTools.includes(action.name)) {
    return { decision: 'ask', risk: 'medium', reason: 'This tool requires a human decision under the host policy.' }
  }
  const args = recordOf(action.arguments)
  if (args === undefined) return { decision: 'ask', risk: 'medium', reason: 'The operation has no complete structured arguments.' }
  const text = JSON.stringify(args)
  if (SENSITIVE.test(text)) {
    return { decision: 'ask', risk: 'high', reason: 'The operation may involve credentials or sensitive data.' }
  }
  for (const field of ['path', 'file_path', 'filePath', 'cwd', 'directory', 'target', 'destination']) {
    const value = args[field]
    if (typeof value === 'string' && outsideWorkspace(value, action.cwd)) {
      return { decision: 'ask', risk: 'medium', reason: 'A declared path is outside the workspace or cannot be resolved safely.' }
    }
  }
  const command = typeof args['command'] === 'string' ? args['command'] : undefined
  if (command !== undefined && (HUMAN_COMMAND.test(command) || OPAQUE_SHELL.test(command))) {
    return { decision: 'ask', risk: 'medium', reason: 'This command needs human review: sensitive, destructive, external, privileged, or compound effects.' }
  }
  return undefined
}
