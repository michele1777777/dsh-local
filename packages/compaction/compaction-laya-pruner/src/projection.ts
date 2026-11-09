/** Browser-safe declaration and pure replay of Laya rewrites of agent message text. */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'

/** One agent message rewritten in later model requests. */
export interface LayaRewriteTarget {
  /** Current `assistant/message` surface node. */
  seq: SessionSeq
  /** Kept line ranges of the message text (text blocks joined by newlines), 1-indexed and inclusive; absent: text unchanged. */
  keepLines?: Array<[number, number]>
  /** Remove the message's reasoning blocks (a closed turn's thinking, resent to the model on every request). */
  dropReasoning?: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Keep only the chosen lines of current agent messages' text and/or drop their reasoning blocks in
     * subsequent model requests. Tool calls, message identities, and node order are unchanged; each removed
     * run of lines becomes one note line.
     * @messageProjection
     */
    'laya-pruner/rewrite': { targets: LayaRewriteTarget[] }
  }
}

/** Note line standing for a run of removed lines. */
export const LAYA_GAP_NOTE = 'lines pruned by laya_context_pruner ...]'

/**
 * Join the kept lines in order; every removed run becomes one note line.
 * @param text - original text.
 * @param ranges - kept 1-indexed inclusive line ranges.
 * @returns the rewritten text.
 */
export function keepLinesText(text: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  const lines = text.split('\n')
  const keep = new Set<number>()
  for (const [a, b] of ranges) for (let i = a; i <= b; i += 1) keep.add(i - 1)
  const out: string[] = []
  let gap = 0
  lines.forEach((line, i) => {
    if (keep.has(i)) {
      if (gap > 0) out.push(`[... ${gap} ${LAYA_GAP_NOTE}`)
      gap = 0
      out.push(line)
    } else {
      gap += 1
    }
  })
  if (gap > 0) out.push(`[... ${gap} ${LAYA_GAP_NOTE}`)
  return out.join('\n')
}

/**
 * Rewrite a message's text blocks into one text block at the first text position; other blocks keep order.
 * @param message - current message.
 * @param ranges - kept line ranges of the joined text; undefined keeps the text unchanged.
 * @param dropReasoning - also remove the reasoning blocks.
 * @returns an immutable copy with the same identity.
 */
export function rewriteMessageText(
  message: Message,
  ranges: ReadonlyArray<readonly [number, number]> | undefined,
  dropReasoning = false,
): Message {
  const text = message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
  const rewritten = ranges === undefined ? undefined : keepLinesText(text, ranges)
  const content: ContentBlock[] = []
  let placed = false
  for (const block of message.content) {
    if (block.type === 'reasoning' && dropReasoning) continue
    if (block.type !== 'text' || rewritten === undefined) {
      content.push(block)
    } else if (!placed) {
      content.push({ ...block, text: rewritten })
      placed = true
    }
  }
  return Object.freeze({ ...message, content: Object.freeze(content) as ContentBlock[] })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/** Atomic validation and reconstruction shared by live sessions and detached replay. */
export const layaRewriteProjection: SessionMessageProjection<'laya-pruner/rewrite'> = {
  type: 'laya-pruner/rewrite',
  project(event, context) {
    const data: unknown = event.data
    if (!isRecord(data) || !Array.isArray(data['targets']) || data['targets'].length === 0) {
      throw new Error('laya-pruner/rewrite: data must contain a nonempty targets array')
    }
    const messages = new Map<SessionSeq, Message>()
    const nodes = new Set(context.nodes)
    for (const target of data['targets'] as unknown[]) {
      const hasLines = isRecord(target) && target['keepLines'] !== undefined
      const dropReasoning = isRecord(target) && target['dropReasoning'] === true
      if (!isRecord(target) || !isIndex(target['seq']) || (hasLines && !Array.isArray(target['keepLines']))
        || (!hasLines && !dropReasoning) || (target['dropReasoning'] !== undefined && typeof target['dropReasoning'] !== 'boolean')) {
        throw new Error('laya-pruner/rewrite: each target must contain a seq and keepLines and/or dropReasoning: true')
      }
      const seq = target['seq'] as SessionSeq
      if (messages.has(seq)) throw new Error(`laya-pruner/rewrite: duplicate target seq ${seq}`)
      if (!nodes.has(seq)) throw new Error(`laya-pruner/rewrite: target seq ${seq} is not a current surface node`)
      const source = context.events[seq - context.baseSeq]
      if (source?.type !== 'assistant/message') throw new Error(`laya-pruner/rewrite: target seq ${seq} must be assistant/message`)
      const ranges: Array<[number, number]> | undefined = hasLines ? [] : undefined
      for (const range of (hasLines ? target['keepLines'] : []) as unknown[]) {
        if (
          !Array.isArray(range) || range.length !== 2 || !isIndex(range[0]) || !isIndex(range[1])
          || range[0] < 1 || range[1] < range[0]
        ) {
          throw new Error('laya-pruner/rewrite: keepLines must be [start, end] pairs with 1 <= start <= end')
        }
        ranges?.push([range[0], range[1]])
      }
      const message = context.messages.get(seq) ?? source.data.message
      messages.set(seq, rewriteMessageText(message, ranges, dropReasoning))
    }
    return messages
  },
}
