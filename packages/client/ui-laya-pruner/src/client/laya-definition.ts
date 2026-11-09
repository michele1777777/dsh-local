import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { LayaPhase, LayaPrunerItem } from '@deepseek-ai/dsh-compaction-laya-pruner'

/** Final keyed Chat payload for one laya_context_pruner pass. */
export interface LayaPrunerChatData {
  readonly status: 'running' | 'pruned' | 'fallback'
  readonly phase?: LayaPhase
  readonly tokensBefore: number
  readonly tokensAfter?: number
  readonly ms?: number
  readonly kept?: number
  readonly truncated?: number
  readonly dropped?: number
  readonly error?: string
  readonly items: readonly LayaPrunerItem[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One laya_context_pruner pass: running state, then totals and every judged output. */
    'laya-pruner': LayaPrunerChatData
  }
}

/** laya-pruner/start + laya-pruner/end folded into one keyed Chat node. */
export const layaPrunerDefinition: ConversationNodeDefinition<LayaPrunerChatData> = {
  kind: 'laya-pruner',
  target: 'chat',
  match: (event) => {
    if (event.type === 'laya-pruner/start') return { id: event.data.pruneId, role: 'start' }
    if (event.type === 'laya-pruner/progress') return { id: event.data.pruneId, role: 'update' }
    if (event.type === 'laya-pruner/end') return { id: event.data.pruneId, role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'laya-pruner/start') throw new Error('laya-pruner start requires laya-pruner/start')
    return { status: 'running', tokensBefore: match.event.data.tokensBefore, items: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'laya-pruner/progress') return context.state.status === 'running'
      ? { ...context.state, phase: match.event.data.phase } : context.state
    if (match.event.type !== 'laya-pruner/end') return context.state
    const d = match.event.data
    return {
      status: d.outcome, tokensBefore: d.tokensBefore, tokensAfter: d.tokensAfter, ms: d.ms,
      kept: d.kept, truncated: d.truncated, dropped: d.dropped, items: d.items,
      ...d.error === undefined ? {} : { error: d.error },
    }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'laya-pruner',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      groupTree: 'turn',
      data: context.state,
    }
  },
}
