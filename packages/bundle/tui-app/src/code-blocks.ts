/** Raw fenced-code extraction. Never reconstruct clipboard data from screen rows. */
export interface CodeBlock { language: string; text: string; complete: boolean }
/** An opening or closing fence line: delimiter character, run length and info string. */
export interface Fence { char: string; length: number; language: string }
/**
 * Parse a line as a Markdown code fence of three or more backticks or tildes.
 * @param line - one line without its terminator.
 * @returns the fence, or undefined when the line is not a fence or a backtick info string contains a backtick.
 */
export function fenceMarker(line: string): Fence | undefined {
  const match = /^[ \t]*(`{3,}|~{3,})(.*)$/u.exec(line)
  if (match === null) return undefined
  const delimiter = match[1] ?? '```', info = (match[2] ?? '').trim()
  if (delimiter[0] === '`' && info.includes('`')) return undefined
  return { char: delimiter[0] ?? '`', length: delimiter.length, language: info }
}
/**
 * Whether a marker closes an open fence: same character, at least as long, and no info string.
 * @param open - the opening fence.
 * @param marker - the candidate line's fence, if any.
 * @returns true when the marker closes `open`.
 */
export function closesFence(open: Fence, marker: Fence | undefined): boolean {
  return marker !== undefined && marker.char === open.char && marker.length >= open.length && marker.language === ''
}
/**
 * Extract fenced code blocks. Retains indentation, Unicode, CRLF, backticks and the body's trailing newline.
 * @param text - raw Markdown source.
 * @returns blocks in source order; an unterminated last block is included with `complete: false`.
 */
export function codeBlocks(text: string): CodeBlock[] {
  const result: CodeBlock[] = []
  let open: { fence: Fence; start: number } | undefined
  const lines = /([^\r\n]*)(\r\n|\n|\r|$)/gu
  for (const match of text.matchAll(lines)) {
    if (match[0] === '') break
    const marker = fenceMarker(match[1] ?? '')
    if (open === undefined) {
      if (marker !== undefined) open = { fence: marker, start: match.index + match[0].length }
    } else if (closesFence(open.fence, marker)) {
      result.push({ language: open.fence.language.split(/\s/u)[0] ?? '', text: text.slice(open.start, match.index), complete: true })
      open = undefined
    }
  }
  if (open !== undefined) result.push({ language: open.fence.language.split(/\s/u)[0] ?? '', text: text.slice(open.start), complete: false })
  return result
}
