/**
 * `laya-pruner/rewrite`: pure text helpers, atomic validation, and live/replayed
 * Session projection of agent-message rewrites (what `dsh --resume` relies on).
 */

import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { keepLinesText, LAYA_GAP_NOTE, layaRewriteProjection, rewriteMessageText } from '../src/projection.ts'

const gap = (n: number): string => `[... ${n} ${LAYA_GAP_NOTE}`

function createSession(...args: Parameters<typeof Session.create>): Session {
  args[4] = [layaRewriteProjection]
  return Session.create(...args)
}

function assistant(session: Session, content: ContentBlock[]) {
  return session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ content, source: { provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
}

function user(session: Session, text: string) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

const CALL: ContentBlock = { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{"cmd":"ls"}' }
const REASONING: ContentBlock = { type: 'reasoning', text: 'private chain of thought' }

function agentContent(): ContentBlock[] {
  return [REASONING, { type: 'text', text: 'one\ntwo\nthree' }, CALL, { type: 'text', text: 'four\nfive' }]
}

function texts(message: Message | null | undefined): string[] {
  return (message?.content ?? []).flatMap(b => (b.type === 'text' ? [b.text] : []))
}

function types(message: Message | null | undefined): string[] {
  return (message?.content ?? []).map(b => b.type)
}

describe('keepLinesText', () => {
  it('keeps chosen 1-indexed inclusive lines and replaces each removed run with one note', () => {
    const text = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
    expect(keepLinesText(text, [[2, 3], [6, 6]])).toBe(['[... 1 lines pruned by laya_context_pruner ...]', 'b', 'c', gap(2), 'f', gap(1)].join('\n'))
    expect(keepLinesText(text, [[1, 7]])).toBe(text)
    expect(keepLinesText(text, [[1, 1], [7, 7]])).toBe(['a', gap(5), 'g'].join('\n'))
  })

  it('merges overlapping or unordered ranges and ignores lines past the end', () => {
    const text = 'a\nb\nc\nd'
    expect(keepLinesText(text, [[3, 9], [1, 1], [3, 3]])).toBe(['a', gap(1), 'c', 'd'].join('\n'))
  })

  it('reduces fully removed text to a single note', () => {
    expect(keepLinesText('a\nb\nc', [])).toBe(gap(3))
    expect(keepLinesText('', [])).toBe(gap(1))
  })
})

describe('rewriteMessageText', () => {
  it('joins text blocks, places the kept text at the first text position, and keeps other blocks in order', () => {
    const message = createAssistantMessage({ content: agentContent(), source: { provider: 'mock', model: 'mock' } })
    const rewritten = rewriteMessageText(message, [[1, 1], [4, 5]])
    expect(rewritten.content).toEqual([REASONING, { type: 'text', text: ['one', gap(2), 'four', 'five'].join('\n') }, CALL])
    expect(rewritten.id).toBe(message.id)
    expect(rewritten.source).toBe(message.source)
    expect(Object.isFrozen(rewritten)).toBe(true)
    expect(Object.isFrozen(rewritten.content)).toBe(true)
    // The input is never mutated.
    expect(message.content).toEqual(agentContent())
  })

  it('drops only the reasoning when no ranges are given', () => {
    const message = createAssistantMessage({ content: agentContent(), source: { provider: 'mock', model: 'mock' } })
    const rewritten = rewriteMessageText(message, undefined, true)
    expect(rewritten.content).toEqual(agentContent().slice(1))
    expect(rewritten.id).toBe(message.id)
  })

  it('truncates text and drops reasoning together', () => {
    const message = createAssistantMessage({ content: agentContent(), source: { provider: 'mock', model: 'mock' } })
    expect(rewriteMessageText(message, [[2, 2]], true).content).toEqual([
      { type: 'text', text: [gap(1), 'two', gap(3)].join('\n') }, CALL,
    ])
  })

  it('keeps reasoning by default (keepLines-only targets written before dropReasoning existed)', () => {
    const message = createAssistantMessage({ content: agentContent(), source: { provider: 'mock', model: 'mock' } })
    const rewritten = rewriteMessageText(message, [[1, 5]])
    expect(types(rewritten)).toEqual(['reasoning', 'text', 'tool-call'])
    expect(texts(rewritten)).toEqual(['one\ntwo\nthree\nfour\nfive'])
  })

  it('returns an equal frozen copy when neither text nor reasoning changes', () => {
    const message = createAssistantMessage({ content: agentContent(), source: { provider: 'mock', model: 'mock' } })
    const copy = rewriteMessageText(message, undefined)
    expect(copy).toEqual(message)
    expect(copy).not.toBe(message)
    expect(Object.isFrozen(copy)).toBe(true)
  })

  it('handles a message without text blocks', () => {
    const message = createAssistantMessage({ content: [REASONING, CALL], source: { provider: 'mock', model: 'mock' } })
    expect(rewriteMessageText(message, [[1, 1]], true).content).toEqual([CALL])
  })
})

describe('layaRewriteProjection in a Session', () => {
  it('rewrites the target in deriveEventMessage/deriveMessages while preserving identity and the raw event', () => {
    const session = createSession(SessionId('rewrite'))
    const first = assistant(session, agentContent())
    const other = assistant(session, [REASONING, { type: 'text', text: 'untouched' }])
    const before = session.deriveMessages()

    session.append('laya-pruner/rewrite', { targets: [{ seq: first.seq, keepLines: [[2, 3]], dropReasoning: true }] })

    const derived = session.deriveEventMessage(first)
    expect(derived?.content).toEqual([{ type: 'text', text: [gap(1), 'two', 'three', gap(2)].join('\n') }, CALL])
    expect(derived?.id).toBe(first.data.message.id)
    expect(Object.isFrozen(derived)).toBe(true)
    const after = session.deriveMessages()
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(derived)
    expect(after[0]?.id).toBe(before[0]?.id)
    // Non-targets keep their reasoning and their derived identity.
    expect(after[1]).toBe(before[1])
    expect(types(session.deriveEventMessage(other))).toEqual(['reasoning', 'text'])
    // The durable event and earlier derived snapshots are untouched.
    expect(first.data.message.content).toEqual(agentContent())
    expect(before[0]?.content).toEqual(agentContent())
    expect(session.surface.nodes).toEqual([first.seq, other.seq])
    expect(session.surface.replaceGeneration).toBe(0)
    expect(session.surface.contentGeneration).toBe(1)
    expect(session.deriveEventMessage(session.snapshotEvents().at(-1)!)).toBeNull()
  })

  it('applies later rewrites on top of earlier ones (keepLines refer to the current text)', () => {
    const session = createSession(SessionId('stacked'))
    const target = assistant(session, agentContent())
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, dropReasoning: true }] })
    expect(types(session.deriveEventMessage(target))).toEqual(['text', 'tool-call', 'text'])
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, keepLines: [[5, 5]] }] })
    expect(session.deriveEventMessage(target)?.content).toEqual([{ type: 'text', text: [gap(4), 'five'].join('\n') }, CALL])
    expect(session.surface.contentGeneration).toBe(2)
  })

  it('keeps reasoning for keepLines-only targets', () => {
    const session = createSession(SessionId('legacy'))
    const target = assistant(session, agentContent())
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, keepLines: [[1, 1]] }] })
    expect(session.deriveEventMessage(target)?.content).toEqual([REASONING, { type: 'text', text: ['one', gap(4)].join('\n') }, CALL])
  })

  it('replays stored events identically through Session.create, foldSurface, restore, and fork', () => {
    const session = createSession(SessionId('source'))
    user(session, 'request')
    const first = assistant(session, agentContent())
    const second = assistant(session, [REASONING, { type: 'text', text: 'a\nb\nc' }])
    const before = session.snapshotEvents()
    session.append('laya-pruner/rewrite', {
      targets: [{ seq: first.seq, dropReasoning: true }, { seq: second.seq, keepLines: [[3, 3]], dropReasoning: false }],
    })
    const events = session.snapshotEvents()
    const live = session.deriveMessages()

    const resumed = createSession(SessionId('resume'), events)
    expect(resumed.deriveMessages()).toEqual(live)
    expect(resumed.deriveMessages().map(m => m.id)).toEqual(live.map(m => m.id))
    expect(createSession(SessionId('before'), before).deriveMessages().map(types)).toEqual([
      ['text'], ['reasoning', 'text', 'tool-call', 'text'], ['reasoning', 'text'],
    ])

    const fold = foldSurface(events, [layaRewriteProjection])
    expect(fold.nodes).toEqual(session.surface.nodes)
    expect(deriveEventMessage(first, fold.projectedMessages)).toEqual(live[1])
    expect(deriveEventMessage(second, fold.projectedMessages)).toEqual(live[2])
    expect(types(deriveEventMessage(second, fold.projectedMessages))).toEqual(['reasoning', 'text'])

    const restored = Session.fromRestore(session.id, events, session.header, SessionLogOffset(0), 'shared-frozen', [layaRewriteProjection])
    expect(restored.deriveMessages()).toEqual(live)
    const childId = SessionId('child')
    const child = createSession(childId, events, {
      ...session.header, id: childId, parentSession: session.id, isSeeded: true,
    }, SessionLogOffset(events.length))
    expect(child.deriveMessages()).toEqual(live)
  })

  it('refuses to replay a rewrite without its projection definition', () => {
    const session = createSession(SessionId('needs-definition'))
    const target = assistant(session, agentContent())
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, dropReasoning: true }] })
    const events = session.snapshotEvents()
    expect(() => Session.create(SessionId('missing'), events)).toThrow(/requires a message projection/)
    expect(() => foldSurface(events)).toThrow(/requires a message projection/)
  })

  it.each<[string, unknown]>([
    ['null data', null],
    ['no targets', {}],
    ['empty targets', { targets: [] }],
    ['non-array targets', { targets: 'bad' }],
    ['null target', { targets: [null] }],
    ['negative seq', { targets: [{ seq: -1, dropReasoning: true }] }],
    ['fractional seq', { targets: [{ seq: 0.5, dropReasoning: true }] }],
    ['string seq', { targets: [{ seq: '0', dropReasoning: true }] }],
    ['neither keepLines nor dropReasoning', { targets: [{ seq: 0 }] }],
    ['dropReasoning false alone', { targets: [{ seq: 0, dropReasoning: false }] }],
    ['non-boolean dropReasoning', { targets: [{ seq: 0, keepLines: [[1, 1]], dropReasoning: 'yes' }] }],
    ['truthy non-boolean dropReasoning alone', { targets: [{ seq: 0, dropReasoning: 1 }] }],
    ['non-array keepLines', { targets: [{ seq: 0, keepLines: 'x' }] }],
    ['range starting at 0', { targets: [{ seq: 0, keepLines: [[0, 1]] }] }],
    ['reversed range', { targets: [{ seq: 0, keepLines: [[3, 2]] }] }],
    ['short range', { targets: [{ seq: 0, keepLines: [[1]] }] }],
    ['long range', { targets: [{ seq: 0, keepLines: [[1, 2, 3]] }] }],
    ['fractional range', { targets: [{ seq: 0, keepLines: [[1.5, 2]] }] }],
    ['string range', { targets: [{ seq: 0, keepLines: [['1', '2']] }] }],
    ['range not an array', { targets: [{ seq: 0, keepLines: [1] }] }],
    ['duplicate target', { targets: [{ seq: 0, dropReasoning: true }, { seq: 0, keepLines: [[1, 1]] }] }],
    ['unknown seq', { targets: [{ seq: 7, dropReasoning: true }] }],
    ['user-message target', { targets: [{ seq: 1, keepLines: [[1, 1]] }] }],
    ['valid target followed by an invalid one', { targets: [{ seq: 0, dropReasoning: true }, { seq: 1, dropReasoning: true }] }],
  ])('rejects %s at append and replay without partial application', (_name, data) => {
    const session = createSession(SessionId('invalid'))
    assistant(session, agentContent())
    user(session, 'not an agent message')
    const events = session.snapshotEvents()
    const live = session.deriveMessages()
    const candidate = { type: 'laya-pruner/rewrite', seq: SessionSeq(events.length), time: 0, data } as SessionEvent
    expect(() => session.append('laya-pruner/rewrite', data as SessionEventMap['laya-pruner/rewrite'])).toThrow(/laya-pruner\/rewrite/)
    expect(() => createSession(SessionId('seed'), [...events, candidate])).toThrow(/laya-pruner\/rewrite/)
    expect(() => foldSurface([...events, candidate], [layaRewriteProjection])).toThrow(/laya-pruner\/rewrite/)
    expect(session.snapshotEvents()).toEqual(events)
    expect(session.deriveMessages()).toEqual(live)
    expect(session.surface.contentGeneration).toBe(0)
    // The session stays usable for a valid rewrite afterwards.
    session.append('laya-pruner/rewrite', { targets: [{ seq: SessionSeq(0), dropReasoning: true }] })
    expect(types(session.deriveMessages()[0])).toEqual(['text', 'tool-call', 'text'])
  })

  it('names the failing rule in its error', () => {
    const session = createSession(SessionId('messages'))
    const target = assistant(session, agentContent())
    const request = user(session, 'request')
    const append = (data: unknown) => () => session.append('laya-pruner/rewrite', data as SessionEventMap['laya-pruner/rewrite'])
    expect(append({ targets: [] })).toThrow(/nonempty targets array/)
    expect(append({ targets: [{ seq: target.seq }] })).toThrow(/keepLines and\/or dropReasoning: true/)
    expect(append({ targets: [{ seq: target.seq, keepLines: [[2, 1]] }] })).toThrow(/1 <= start <= end/)
    const twice = { seq: target.seq, dropReasoning: true }
    expect(append({ targets: [twice, twice] })).toThrow(/duplicate target seq 0/)
    expect(append({ targets: [{ seq: request.seq, dropReasoning: true }] })).toThrow(/must be assistant\/message/)
    expect(append({ targets: [{ seq: 99, dropReasoning: true }] })).toThrow(/not a current surface node/)
  })

  it('rejects targets that are no longer current surface nodes', () => {
    const session = createSession(SessionId('shadowed'))
    const target = assistant(session, agentContent())
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq }, sourceEventSeqs: [target.seq],
    })
    expect(() => session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, dropReasoning: true }] })).toThrow(/not a current surface node/)
  })

  it('accepts a tool-call-only agent message and leaves its calls intact', () => {
    const session = createSession(SessionId('calls'))
    const target = assistant(session, [REASONING, CALL])
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, dropReasoning: true }] })
    expect(session.deriveEventMessage(target)?.content).toEqual([CALL])
  })
})
