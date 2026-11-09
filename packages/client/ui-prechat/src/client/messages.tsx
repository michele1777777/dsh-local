/** Imported human turns have their own visible Chat node; injected context remains hidden. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-prechat/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import css from './PrechatPanel.module.css'
interface ImportedUser { readonly text: string; readonly seq: number }
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'prechat-user': ImportedUser }
}
/** Claims imported user messages as visible, separately attributed chat nodes. */
export const importedUserDefinition: ConversationNodeDefinition<ImportedUser> = {
  kind: 'prechat-user', target: 'chat',
  match: event => event.type === 'user/message' && isAppendSurfaceEvent(event) && event.data.source.kind === 'prechat'
    ? { id: String(event.data.id), role: 'start', exclusive: true } : null,
  start: (_context, match) => {
    if (match.event.type !== 'user/message') throw new Error('prechat-user requires a user message')
    return { seq: match.event.seq, text: match.event.data.content.filter(block => block.type === 'text').map(block => block.text).join('') }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined ? null : {
    key: context.key, kind: 'prechat-user', id: context.id, target: 'chat', anchorSeq: context.state.seq,
    location: context.start?.location ?? { kind: 'unresolved' }, groupTree: 'exchange', visibility: 'visible', data: context.state,
  },
}
/** Present the complete imported text as a labelled human-authored message.
 * @param props - imported node and localized labels.
 * @returns the visible imported-user bubble.
 */
export function ImportedUserMessage({ node, t }: PropsRuntime<'conversation.chat.node', 'prechat-user'> & PropsLocale<'prechat'>) {
  return <section className={css.importedUser} aria-label={t('importedUser')}><small>{t('importedUser')}</small><p>{node.data.text}</p></section>
}
