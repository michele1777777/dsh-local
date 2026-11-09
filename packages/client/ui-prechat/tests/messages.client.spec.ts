/** Imported human turns remain visible outside completed-turn disclosures. */
import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationNodeAssembler } from '../../ui-conversation/src/client/conversation/assembler.ts'
import { messageDefinition } from '../../ui-chat/src/client/conversation-nodes/message.ts'
import { isAtOrOutside } from '../../ui-chat/src/client/contract/group-tree.ts'
import { importedUserDefinition } from '../src/client/messages.tsx'

describe('imported human messages', () => {
  it('claims imported input once and keeps it outside the folded process', () => {
    let chat: readonly ConversationViewNode[] = []
    const assembler = new ConversationNodeAssembler(
      { entries: () => [messageDefinition, importedUserDefinition], fallbackEntry: () => undefined },
      { entries: () => [{ target: 'chat', create: () => ({
        empty: chat,
        replace: ({ nodes }) => (chat = nodes),
        apply: ({ upserts }) => (chat = [...chat, ...upserts]),
      }) }] },
    )
    assembler.activateTarget('chat')
    assembler.replaceWindow([{ type: 'event', event: {
      type: 'user/message', seq: SessionSeq(3), time: 1, surfaceOp: 'append',
      data: { id: 'imported-user', role: 'user', source: { kind: 'prechat' }, content: [{ type: 'text', text: 'Studiamo le frazioni.' }] },
    } as never }], false)
    assembler.flush()
    expect(chat).toHaveLength(1)
    expect(chat[0]).toMatchObject({ kind: 'prechat-user', visibility: 'visible', data: { text: 'Studiamo le frazioni.' } })
    expect(isAtOrOutside(chat[0] as never, 'turn')).toBe(true)
    expect(isAtOrOutside(chat[0] as never, 'input')).toBe(true)
  })
})
