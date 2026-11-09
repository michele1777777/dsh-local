/** Web /prechat decoration; execution remains in the Host command registry. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-prechat/types'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { importedUserDefinition, ImportedUserMessage } from './messages.tsx'
import { PrechatDialog } from './dialog.ts'
import { PrechatPanel, PrechatNotice } from './PrechatPanel.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'
import type { PrechatInjected } from './slots.ts'
export const inject = ['slots', 'locale', 'commandUi', 'remote', 'remote.commands', 'uiWorkspace', 'sessions', 'uiConversation']
/** Register the importer on each conversation's overlay. */
export function apply(ctx: Context): void {
  const dialogs = new Map<SessionId, PrechatDialog>()
  const dialogFor = (sessionId: SessionId): PrechatDialog => {
    let dialog = dialogs.get(sessionId)
    if (dialog === undefined) {
      dialog = new PrechatDialog(async (text) => {
        const result = await ctx.remote.commands.execute(sessionId, `/prechat --apply\n${text}`, [])
        if (!result.ok) throw new Error(result.error.message)
        const outcome = result.value?.result
        if (outcome === undefined) throw new Error('/prechat is unavailable for the selected model.')
        if (outcome.kind === 'error') throw new Error(outcome.text)
        if (outcome.sessionId !== undefined) ctx.uiWorkspace.openSession(outcome.sessionId)
      })
      const scope = ctx.sessions.scope(sessionId)
      if (scope === undefined) throw new Error(`Unknown session: ${sessionId}`)
      const owned = dialog
      scope.effect(() => () => { owned.dispose(); dialogs.delete(sessionId) }, 'prechat: session draft')
      dialogs.set(sessionId, dialog)
    }
    return dialog
  }
  ctx.effect(() => ctx.locale.register('prechat', { en, zh, ja, es, fr, de, ru, pt }), 'prechat: copy')
  ctx.effect(() => () => { for (const dialog of dialogs.values()) dialog.dispose(); dialogs.clear() }, 'prechat: drafts')
  ctx.effect(() => ctx.commandUi.decorate({ name: 'prechat', available: () => true,
    ui: { kind: 'action', run: (session) =>{  dialogFor(session.sessionId).open() } },
  }), 'prechat: command')
  ctx.uiConversation.events.register(importedUserDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'prechat-user', locale: 'prechat' }, ImportedUserMessage))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'prechat-notice', locale: 'prechat' }, PrechatNotice))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'prechat', locale: 'prechat',
    inject: (sessionId): PrechatInjected => {
      const dialog = dialogFor(sessionId)
      return { hooks: { draft: dialog.state }, edit: (text) =>{  dialog.edit(text) }, close: () =>{  dialog.close() },
        preview: () =>{  dialog.preview() }, load: file => dialog.load(file), submit: () => dialog.submit() }
    },
  }, PrechatPanel))
}
