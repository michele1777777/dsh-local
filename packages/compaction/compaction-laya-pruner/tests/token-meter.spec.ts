/**
 * Token meter repricing of `laya-pruner/rewrite` targets: request pressure must fall by the
 * removed reasoning/text, live and when a stored session is replayed by a fresh meter.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { layaRewriteProjection } from '../src/projection.ts'

/** Same fixed density as the meter's heuristic (4 chars per token). */
const CHARS_PER_TOKEN = 4

function meter(): TokenMeter {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  return new TokenMeter(ctx)
}

function createSession(id: string, events?: Parameters<typeof Session.create>[1]): Session {
  return Session.create(SessionId(id), events, undefined, undefined, [layaRewriteProjection])
}

function assistant(session: Session, turn: number, content: ContentBlock[]) {
  session.append('step/start', { turn, step: 1 })
  const event = session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createAssistantMessage({ content, source: { provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  return event
}

function conversation(reasoning: string, text: string) {
  const session = createSession('metered')
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const target = assistant(session, 1, [{ type: 'reasoning', text: reasoning }, { type: 'text', text }])
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return { session, target }
}

describe('token meter and laya-pruner/rewrite', () => {
  it('lowers measured pressure by the dropped reasoning', () => {
    const reasoning = 'r'.repeat(4000)
    const { session, target } = conversation(reasoning, 'short answer')
    const tokenMeter = meter()
    const before = tokenMeter.measure(session).totalTokens
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, dropReasoning: true }] })
    const after = tokenMeter.measure(session).totalTokens
    const removed = reasoning.length / CHARS_PER_TOKEN
    expect(before - after).toBeGreaterThanOrEqual(removed)
    expect(before - after).toBeLessThanOrEqual(removed + 16)
    const node = tokenMeter.measure(session).nodes.find(n => n.seq === target.seq)
    expect(node).toBeDefined()
    expect(node!.tokens).toBe(tokenMeter.estimateMessage(session.deriveEventMessage(target)!))
  })

  it('lowers measured pressure by the truncated text lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`)
    const { session, target } = conversation('tiny', lines.join('\n'))
    const tokenMeter = meter()
    const before = tokenMeter.measure(session).totalTokens
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, keepLines: [[1, 10]] }] })
    const after = tokenMeter.measure(session).totalTokens
    const kept = session.deriveEventMessage(target)!.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
    const removed = (lines.join('\n').length - kept.length) / CHARS_PER_TOKEN
    expect(before - after).toBeGreaterThan(removed - 4)
    expect(before - after).toBeLessThan(removed + 4)
    expect(after).toBeLessThan(before / 4)
  })

  it('reprices the same way when the meter first syncs after the rewrite and when a stored session is replayed', () => {
    const { session, target } = conversation('r'.repeat(2000), 'a\nb\nc\n'.repeat(200))
    const live = meter()
    live.measure(session)
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, keepLines: [[1, 1]], dropReasoning: true }] })
    const expected = live.measure(session).totalTokens

    // A fresh meter folds the whole log, rewrite included, in one sync.
    expect(meter().measure(session).totalTokens).toBe(expected)
    // `dsh --resume`: the stored events replayed into a new Session and a new meter.
    const resumed = createSession('resumed', session.snapshotEvents())
    expect(meter().measure(resumed).totalTokens).toBe(expected)
  })

  it('lowers pressure under a provider-usage anchor too', () => {
    const session = createSession('anchored')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    const reasoning = 'r'.repeat(4000)
    const target = session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text: 'done' }], source: { provider: 'mock', model: 'mock' } }),
      usage: { inputTokens: 20_000, outputTokens: 1_500 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    const tokenMeter = meter()
    const before = tokenMeter.measure(session)
    expect(before.baseline.kind).toBe('usage')
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, dropReasoning: true }] })
    const after = tokenMeter.measure(session)
    expect(after.baseline.kind).toBe('usage')
    const removed = reasoning.length / CHARS_PER_TOKEN
    expect(before.totalTokens - after.totalTokens).toBeGreaterThanOrEqual(removed)
    expect(before.totalTokens - after.totalTokens).toBeLessThanOrEqual(removed + 16)
  })

  it('leaves untargeted nodes priced as before', () => {
    const { session, target } = conversation('r'.repeat(400), 'answer')
    const other = assistant(session, 2, [{ type: 'reasoning', text: 'k'.repeat(400) }, { type: 'text', text: 'second' }])
    const tokenMeter = meter()
    const price = (seq: number) => tokenMeter.measure(session).nodes.find(n => n.seq === seq)?.tokens
    const otherBefore = price(other.seq)
    const targetBefore = price(target.seq)
    session.append('laya-pruner/rewrite', { targets: [{ seq: target.seq, dropReasoning: true }] })
    expect(price(other.seq)).toBe(otherBefore)
    expect(price(target.seq)).toBeLessThan(targetBefore! - 90)
  })
})
