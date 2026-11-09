/** Browser plugin for laya_context_pruner Conversation Nodes. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LayaPrunerPanel } from './LayaPrunerPanel.tsx'
import { de, en, es, fr, ja, NS, pt, ru, type LayaPrunerKey, zh } from './locales.ts'
import { layaPrunerDefinition } from './laya-definition.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** laya_context_pruner node copy. */
    layaPruner: LayaPrunerKey
  }
}

/** Required services for the Definition, the keyed renderer, and copy. */
export const inject = ['uiConversation', 'slots', 'locale']

/** Register the Definition, dictionaries, and keyed Chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(layaPrunerDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-laya-pruner: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'laya-pruner',
    locale: NS,
  }, LayaPrunerPanel))
}
