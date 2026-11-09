/** Lightweight lexical highlighting. Unknown languages remain verbatim text. */
import { span, type Span } from './rich-text.ts'
const languageNames = 'js|jsx|javascript|ts|tsx|typescript|json|jsonc|py|python|rs|rust|go|java|c|cpp|cs'
  + '|csharp|sh|bash|zsh|fish|yaml|yml|toml|sql|css'
const languages = new RegExp(`^(?:${languageNames})$`, 'iu')
const keywords = new Set('as async await break case catch class const continue def del do elif else enum except export extends false finally fn for from function if impl import in interface let match mod new None null of pass private pub public raise return self static struct super switch this throw trait true try type typeof undefined use var void while with yield True False'.split(' '))
/**
 * Language hint for a file path, taken from its extension.
 * @param path - file path.
 * @returns the lowercased last dot-separated segment.
 */
export function languageOf(path: string): string { return path.split('.').at(-1)?.toLowerCase() ?? '' }
/**
 * Tokenize one code fragment into toned spans. A line comment colors the rest of the text.
 * @param text - source text.
 * @param language - fence info or file extension; unknown languages return the text as one plain span.
 * @returns at least one span; the spans concatenate to `text`.
 */
export function highlight(text: string, language: string): Span[] {
  if (/^(?:powershell|pwsh|ps1)$/iu.test(language)) return highlightPowerShell(text)
  if (!languages.test(language)) return [span(text)]
  const hash = /^(?:py|python|sh|bash|zsh|fish|yaml|yml|toml)$/iu.test(language)
  const parts: Span[] = []
  const pattern = /("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?|\/\/.*|#[^\n]*|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*)/gu
  let end = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    if (start > end) parts.push(span(text.slice(end, start)))
    const token = match[0]
    if (token.startsWith('//') || (hash && token.startsWith('#'))) { parts.push(span(text.slice(start), 'comment')); end = text.length; break }
    parts.push(span(token, /^["'`]/u.test(token) ? 'string' : /^\d/u.test(token) ? 'number' : keywords.has(token) ? 'keyword' : 'text'))
    end = start + token.length
  }
  if (end < text.length) parts.push(span(text.slice(end)))
  return parts.length === 0 ? [span('')] : parts
}

/** PowerShell's backtick is an escape/continuation, not a JavaScript string delimiter. */
function highlightPowerShell(text: string): Span[] {
  const parts: Span[] = []
  const pattern = new RegExp([
    '"(?:`.|[^"`])*"?', "'(?:''|[^'])*'?", '#[^\\n]*', '\\$\\{[^}]*\\}', '\\$[\\w:]+',
    '\\b[A-Za-z]+-[A-Za-z][\\w-]*\\b', '-[A-Za-z][\\w-]*', '\\b\\d+(?:\\.\\d+)?\\b', '[A-Za-z_]\\w*',
  ].map(part => `(?:${part})`).join('|'), 'gu')
  let end = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    if (start > end) parts.push(span(text.slice(end, start)))
    const token = match[0]
    if (token.startsWith('#')) { parts.push(span(text.slice(start), 'comment')); end = text.length; break }
    parts.push(span(token, /^["']/u.test(token) ? 'string' : /^\d/u.test(token) ? 'number' : token.startsWith('$') || token.startsWith('-') ? 'accent' : token.includes('-') || keywords.has(token.toLowerCase()) ? 'keyword' : 'text'))
    end = start + token.length
  }
  if (end < text.length) parts.push(span(text.slice(end)))
  return parts.length === 0 ? [span('')] : parts
}
