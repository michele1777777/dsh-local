/**
 * Escape terminal control payloads at the display boundary, not in model input.
 * @param text - text to display.
 * @returns the text without OSC, CSI, DCS/PM/APC sequences, C0/C1 controls (except tab and newline) and bidi overrides.
 */
export function safeText(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
}
/**
 * Unicode-aware one-line abbreviation for labels and status metadata.
 * @param text - text to abbreviate; it is sanitized and whitespace runs collapse to one space.
 * @param length - maximum code points, including the trailing ellipsis.
 * @returns the text, or its prefix ending in `…` when longer than `length`.
 */
export function shorten(text: string, length = 72): string {
  const chars = Array.from(safeText(text).replace(/\s+/gu, ' ').trim())
  return chars.length <= length ? chars.join('') : `${chars.slice(0, Math.max(0, length - 1)).join('')}…`
}
/**
 * Compact token count for status lines.
 * @param value - token count.
 * @returns the rounded count below 1000, otherwise thousands with a `k` suffix (one decimal below 10k).
 */
export function tokens(value: number): string {
  return value < 1000 ? String(Math.round(value)) : `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
}
/**
 * JSON text for a display value, or undefined for `undefined`, functions and symbols, which
 * `JSON.stringify` returns although its declared type omits it.
 * @param value - any value to show.
 * @param space - indentation, as for `JSON.stringify`.
 * @returns the JSON text, or undefined when the value has none.
 */
export function jsonText(value: unknown, space?: number): string | undefined {
  return JSON.stringify(value, null, space)
}
/**
 * Sanitize a detached presentation tree; never pass this back to a service.
 * @param value - value whose strings, at any array or plain-object depth, pass through {@link safeText}.
 * @returns a sanitized copy; non-string leaves are kept as is.
 */
export function displayTree<T>(value: T): T {
  if (typeof value === 'string') return safeText(value) as T
  if (Array.isArray(value)) return value.map((entry: unknown) => displayTree(entry)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]: [string, unknown]) => [key, displayTree(entry)])) as T
  }
  return value
}

/**
 * Readable queue labels without dumping inline image bytes or file receipts.
 * @param content - prompt content blocks.
 * @returns text blocks verbatim and other blocks as `[type: name]`, one per line.
 */
export function contentSummary(content: readonly unknown[]): string {
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return '[content]'
    const value = block as { type?: string; text?: string; name?: string }
    if (value.type === 'text' && typeof value.text === 'string') return value.text
    return `[${value.type ?? 'attachment'}${typeof value.name === 'string' ? `: ${value.name}` : ''}]`
  }).join('\n')
}
