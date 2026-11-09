// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {} from '../src/client/index.ts'
import { LayaPrunerPanel } from '../src/client/LayaPrunerPanel.tsx'
import type { LayaPrunerPanelProps } from '../src/client/LayaPrunerPanel.tsx'
import { layaPrunerDefinition } from '../src/client/laya-definition.ts'
import { en } from '../src/client/locales.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ConversationStartMatch, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChatSnapshotBuilder } from '../../ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { ProcessState } from '../../ui-chat/src/client/conversation-nodes/process-groups.ts'
import type { LayaPhase } from '@deepseek-ai/dsh-compaction-laya-pruner'

afterEach(cleanup)

const turn: TurnLocation = {
  turn: 1, status: 'open', steps: [], end: undefined,
  start: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } },
  data: { get: () => undefined, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
}
const start: ConversationStartMatch = {
  role: 'start', location: { kind: 'turn', turn },
  event: { type: 'laya-pruner/start', seq: SessionSeq(2), time: 2,
    data: { pruneId: 'p', turn: 1, tokensBefore: 140000, contextWindow: 184320 } },
}
function context() {
  return {
    key: 'laya:p', kind: 'laya-pruner', id: 'p', matches: [start], start, current: new Map(),
    state: { status: 'running' as const, tokensBefore: 140000, items: [] },
  }
}
function node(phase?: LayaPhase): LayaPrunerPanelProps['node'] {
  const ctx = context()
  return layaPrunerDefinition.buildViewNode!({ ...ctx, state: { ...ctx.state, ...phase === undefined ? {} : { phase } } }) as LayaPrunerPanelProps['node']
}

describe('temporary Laya progress', () => {
  it.each([
    ['release', 'DS4 · freeing cache memory'], ['start', 'Starting Laya'],
    ['prune', 'Pruning context · 140k tokens'], ['stop', 'Stopping Laya'],
    ['restore', 'DS4 · restoring cache capacity'],
  ] as const)('announces %s while the existing activity animation runs', (phase: LayaPhase, label) => {
    // This renderer only consumes node and t; the Slot runtime owns the remaining props.
    const props: Pick<LayaPrunerPanelProps, 'node' | 't'> = {
      node: node(phase),
      t: (key, values) => {
        let text = key in en ? en[key as keyof typeof en] : key
        for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, String(value))
        return text
      },
    }
    render(<LayaPrunerPanel {...props as LayaPrunerPanelProps} />)
    expect(screen.getByRole('status').textContent).toBe(label)
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  })

  it('keeps pruning progress visible outside collapsed process groups', () => {
    const laya = node('restore')
    const builder = new ChatSnapshotBuilder()
    builder.replace({ nodes: [laya], timeline: { turnOrder: [1], turns: new Map([[1, turn]]) } })
    const groups = new ProcessState()
    groups.accept(builder.groupInput())
    expect(groups.output()?.entries).toEqual([{ kind: 'node', key: laya.key }])
  })

  it('matches progress to the same node and ignores late updates after settlement', () => {
    const match = { event: { type: 'laya-pruner/progress', data: { pruneId: 'p', turn: 1, phase: 'restore' } } } as Parameters<typeof layaPrunerDefinition.update>[1]
    expect(layaPrunerDefinition.match(match.event)).toEqual({ id: 'p', role: 'update' })
    const ctx = context()
    expect(layaPrunerDefinition.update(ctx, match)).toMatchObject({ phase: 'restore' })
    const settled = { ...ctx, state: { ...ctx.state, status: 'fallback' as const } }
    expect(layaPrunerDefinition.update(settled, match)).toBe(settled.state)
  })
})
