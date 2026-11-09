/** Plain-text conversation import shared by terminal, browser and Host validation. */
export interface PrechatMessage { readonly role: 'user' | 'assistant'; readonly text: string }
/** Import failures carry a line number so the draft can be corrected. */
export class PrechatTextError extends Error {}
/** Maximum UTF-8 input size, including role markers. */
export const PRECHAT_MAX_BYTES = 256 * 1024
/**
 * Parse complete USER:/ASSISTANT: pairs without changing message contents.
 * @param text - UTF-8 decoded transcript; role markers must begin a line.
 * @returns ordered messages, ending with an assistant response.
 */
export function parsePrechat(text: string): PrechatMessage[] {
  if (new TextEncoder().encode(text).length > PRECHAT_MAX_BYTES) throw new PrechatTextError('Conversation exceeds 256 KiB. Use a shorter transcript.')
  if (text.includes('\0')) throw new PrechatTextError('Conversation contains a NUL character. Use a plain-text file.')
  const lines = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n')
  const messages: PrechatMessage[] = []
  let role: PrechatMessage['role'] | undefined
  let body: string[] = []
  let start = 1
  const finish = (): void => {
    if (role === undefined) return
    const value = body.join('\n').replace(/\n$/u, '')
    if (value.trim() === '') throw new PrechatTextError(`Line ${start}: empty ${role === 'user' ? 'USER' : 'ASSISTANT'} message.`)
    messages.push({ role, text: value })
  }
  for (const [index, line] of lines.entries()) {
    const marker = /^(USER|ASSISTANT):[ \t]?(.*)$/u.exec(line)
    if (marker !== null) {
      finish()
      const expected = messages.length % 2 === 0 ? 'USER' : 'ASSISTANT'
      if (marker[1] !== expected) throw new PrechatTextError(`Line ${index + 1}: expected ${expected}:`)
      role = marker[1] === 'USER' ? 'user' : 'assistant'
      body = [marker[2] ?? '']; start = index + 1
    } else if (role !== undefined) body.push(line)
    else if (line.trim() !== '') throw new PrechatTextError(`Line ${index + 1}: expected USER:`)
  }
  finish()
  if (messages.length === 0) throw new PrechatTextError('Add at least one USER: / ASSISTANT: pair.')
  if (messages.length % 2 !== 0) throw new PrechatTextError('The last message must be ASSISTANT:.')
  return messages
}

/** A provider/model pair that accepts imported conversations. */
export interface PrechatRoute {
  /** Provider id of the route, as configured on the LLM adapter. */
  provider: string
  /** Model id within that provider. */
  model: string
}

/**
 * Match a route against the configured prechat routes.
 * @param route - effective provider and model.
 * @param routes - the routes the deployment allows.
 * @returns whether conversation import is supported on the route.
 */
export function isPrechatRoute(route: PrechatRoute, routes: readonly PrechatRoute[]): boolean {
  return routes.some(allowed => allowed.provider === route.provider && allowed.model === route.model)
}

/**
 * Name the allowed routes for user-facing messages.
 * @param routes - the routes the deployment allows.
 * @returns a comma-separated `provider/model` list, or a notice that none is configured.
 */
export function prechatRouteLabel(routes: readonly PrechatRoute[]): string {
  return routes.length === 0 ? 'no configured model' : routes.map(route => `${route.provider}/${route.model}`).join(', ')
}
