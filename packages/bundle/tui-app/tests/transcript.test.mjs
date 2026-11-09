import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyTranscript, applyEvent, applyChunk, endStream, splitSettled } from '../src/transcript.ts'
import { formatItem } from '../src/plain.ts'
const presenters = { call: name => ({ card: 'generic', title: name }), result: () => undefined }
const event = (type, data, extra = {}) => ({ type, data, seq: 0, time: 1, ...extra })
const user = (id, text, surfaceOp = 'append') => event('user/message', { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { surfaceOp })
const answer = (text, extra = {}) => event('assistant/message', { message: { content: [{ type: 'text', text }] }, stream: [], ...extra }, { surfaceOp: 'append' })

test('durable user messages are displayed live exactly once, preserving whitespace', () => {
  const t = emptyTranscript()
  applyEvent(t, user('u1', '  hi\n '), presenters, false)
  applyEvent(t, user('u1', '  hi\n '), presenters, false)
  assert.equal(t.items.length, 1); assert.equal(t.items[0].text, '  hi\n ')
})
test('injected context and compact replacement copies do not become human turns', () => {
  const t = emptyTranscript()
  applyEvent(t, user('u1', 'hi'), presenters, true)
  applyEvent(t, user('replacement', 'hi', { op: 'replace', startSeq: 0, endSeq: 1 }), presenters, true)
  applyEvent(t, event('user/message', { source: { kind: 'context' }, content: [{ type: 'text', text: 'internal' }] }, { surfaceOp: 'append' }), presenters, true)
  assert.equal(t.items.length, 1)
})
test('canonical assistant commit reconciles streamed deltas without duplicate rows', () => {
  const t = emptyTranscript()
  applyChunk(t, { type: 'text-delta', index: 0, text: 'par' })
  applyEvent(t, answer('complete', { usage: { inputTokens: 12, outputTokens: 5 } }), presenters, false)
  endStream(t)
  assert.equal(t.items.length, 1); assert.equal(t.items[0].text, 'complete')
  assert.deepEqual(t.usage, { input: 12, output: 5 })
  assert.equal(splitSettled(t.items).live.length, 0)
})
test('non-streamed responses and resumed usage are still visible', () => {
  const t = emptyTranscript()
  applyEvent(t, answer('final', { usage: { inputTokens: 40, outputTokens: 7 } }), presenters, true)
  assert.equal(t.items[0].text, 'final'); assert.equal(t.usage.output, 7)
})
test('assistant replacement nodes are not duplicate answers', () => {
  const t = emptyTranscript()
  applyEvent(t, { ...answer('model-only copy'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }, presenters, true)
  assert.equal(t.items.length, 0)
})
test('failed attempts replay packed text and settle with an explicit notice', () => {
  const t = emptyTranscript()
  applyEvent(t, event('assistant/attempt', { turn: 1, step: 0, stream: [
    { type: 'reasoning-chunks', time0: 0, index: 0, dt: [0], texts: ['reason'] },
    { type: 'text-chunks', time0: 0, index: 1, dt: [0], texts: ['partial'] },
  ] }), presenters, true)
  assert.equal(t.items[0].text, 'partial'); assert.equal(t.items[0].reasoning, 'reason')
  assert.equal(t.items[1].kind, 'notice'); assert.equal(splitSettled(t.items).live.length, 0)
})
test('compaction state and failure are derived from durable events', () => {
  const t = emptyTranscript()
  applyEvent(t, user('u1', 'old conversation'), presenters, true)
  applyEvent(t, event('compaction/start', { compactionId: 'c1', turn: null }), presenters, false)
  assert.equal(t.compacting, true)
  applyEvent(t, event('compaction/end', { compactionId: 'c1', turn: null, error: 'cancelled' }), presenters, false)
  assert.equal(t.compacting, false); assert.equal(t.items[0].text, 'old conversation')
  assert.equal(t.items.at(-1).level, 'error')
})
test('tool and command results settle the correct row, not later queued work', () => {
  const t = emptyTranscript()
  applyEvent(t, event('tool/call', { callId: 'call', name: 'bash', arguments: '{"command":"pwd"}' }), presenters, false)
  applyEvent(t, event('command/run', { commandId: 'cmd', name: 'compact' }), presenters, false)
  applyEvent(t, event('tool/result', { message: { role: 'tool', toolCallId: 'call', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'text', text: '/work' }] } }, { surfaceOp: 'append' }), presenters, false)
  assert.equal(splitSettled(t.items).settled.length, 1)
  applyEvent(t, event('command/done', { commandId: 'cmd', kind: 'success', text: 'done' }), presenters, false)
  assert.equal(splitSettled(t.items).settled.length, 2)
})
test('full export retains all captured terminal output and complete diff file texts', () => {
  const output = Array.from({ length: 70 }, (_, i) => `line-${i}`).join('\n')
  const tool = { kind: 'tool', id: 't1', name: 'bash', call: { card: 'terminal', title: 'command' }, result: { card: 'terminal', output }, resultText: output, settled: true, isError: false }
  assert.ok(formatItem(tool, false, true).includes('line-0\nline-1'))
  tool.result = { card: 'diff', diffs: [{ path: 'a.ts', oldText: 'before', newText: 'after' }] }
  tool.resultText = 'updated'
  assert.ok(formatItem(tool, false, true).includes('--- before\nbefore\n+++ after\nafter'))
})


test('managed Laya phases follow their operation and clear on fallback', () => {
  const t = emptyTranscript()
  applyEvent(t, event('laya-pruner/start', { pruneId: 'active', turn: 1, tokensBefore: 140000, contextWindow: 184320 }), presenters, false)
  for (const phase of ['release', 'start', 'prune', 'stop', 'restore']) {
    applyEvent(t, event('laya-pruner/progress', { pruneId: 'active', turn: 1, phase }), presenters, false)
    assert.equal(t.layaPhase, phase)
    applyEvent(t, event('laya-pruner/progress', { pruneId: 'stale', turn: 1, phase: 'start' }), presenters, false)
    assert.equal(t.layaPhase, phase)
  }
  applyEvent(t, event('laya-pruner/end', { pruneId: 'active', turn: 1, outcome: 'fallback', tokensBefore: 140000, tokensAfter: 140000, ms: 12000, kept: 0, truncated: 0, dropped: 0, items: [] }), presenters, false)
  assert.equal(t.layaPruning, false)
  assert.equal(t.layaPhase, undefined)
  applyEvent(t, event('compaction/start', { compactionId: 'summary', turn: 1 }), presenters, false)
  assert.equal(t.compacting, true)
})

test('reasoning seconds match live, replay and abort without counting the final answer', () => {
  const stream=[
    {type:'reasoning-chunks',time0:1000,index:0,dt:[2500],texts:['think',' more']},
    {type:'chunk',time:4000,chunk:{type:'block-end',index:0,block:{type:'reasoning',text:'think more'}}},
    {type:'text-chunks',time0:5000,index:1,dt:[],texts:['answer']},
  ]
  const commit=event('assistant/message',{message:{content:[{type:'reasoning',text:'think more'},{type:'text',text:'answer'}]},stream},{surfaceOp:'append',time:9000})
  const live=emptyTranscript(),replay=emptyTranscript()
  applyChunk(live,{type:'reasoning-delta',index:0,text:'think'},1000)
  applyChunk(live,{type:'reasoning-delta',index:0,text:' more'},3500)
  applyChunk(live,stream[1].chunk,4000)
  assert.equal(live.items[0].reasoningEndedAt,4000)
  applyChunk(live,{type:'text-delta',index:1,text:'answer'},5000)
  applyEvent(live,commit,presenters,false);applyEvent(replay,commit,presenters,true)
  assert.deepEqual(live.items,replay.items)
  assert.equal(replay.items[0].reasoningStartedAt,1000);assert.equal(replay.items[0].reasoningEndedAt,4000)
  const aborted=emptyTranscript()
  applyEvent(aborted,event('assistant/attempt',{stream:[stream[0]]},{time:6000}),presenters,true)
  assert.equal(aborted.items[0].reasoningEndedAt,6000)
  const failed=emptyTranscript();applyChunk(failed,{type:'reasoning-delta',index:0,text:'partial'},1000);endStream(failed,2000)
  assert.equal(failed.items[0].reasoningEndedAt,2000)
})
test('work time follows human admission and completion, ignoring injected and replacement messages', () => {
  const t=emptyTranscript()
  applyEvent(t,event('turn/start',{}, {time:1000}),presenters,false)
  applyEvent(t,{...user('u1','first'),time:1200},presenters,false)
  applyEvent(t,event('step/start',{}, {time:1500}),presenters,false)
  applyEvent(t,{...user('copy','copy',{op:'replace',startSeq:0,endSeq:1}),time:2000},presenters,false)
  applyEvent(t,event('user/message',{source:{kind:'context'}},{surfaceOp:'append',time:2200}),presenters,false)
  assert.equal(t.workStartedAt,1200)
  applyEvent(t,{...user('u2','steering'),time:3000},presenters,false)
  assert.equal(t.workStartedAt,3000)
  applyEvent(t,event('turn/end',{reason:{kind:'aborted'}},{time:6000}),presenters,false)
  assert.equal(t.workCompletedAt,6000)
  applyEvent(t,event('session/end-seed',{}, {time:10000}),presenters,true)
  assert.equal(t.workCompletedAt,6000)
})

const { readFileSync } = await import('node:fs')
const { createDocumentRenderer } = await import('../src/document.ts')
const { textOfRow } = await import('../src/rich-text.ts')
test('a recorded reasoning stream renders one row per settled thought with its duration', () => {
  const t=emptyTranscript()
  const commit=(text,start,end)=>event('assistant/message',{
    message:{content:[{type:'reasoning',text}]},
    stream:[{type:'reasoning-chunks',time0:start,index:0,dt:[],texts:[text]},
      {type:'chunk',time:end,chunk:{type:'block-end',index:0,block:{type:'reasoning',text}}}],
  },{surfaceOp:'append',time:end+100})
  applyEvent(t,commit('Earlier thought',1000,7000),presenters,true)
  applyEvent(t,commit('Latest thought',10000,22000),presenters,true)
  const rows=createDocumentRenderer().render(t.items,{width:100,expanded:false,overrides:{},tick:8,now:90000})
  assert.equal(rows.map(value=>textOfRow(value).trimEnd()).join('\n')+'\n',readFileSync(new URL('./fixtures/thought-status.txt',import.meta.url),'utf8'))
})


test('imported human messages remain visible when replaying a prepared conversation', () => {
  const t = emptyTranscript()
  const message = user('imported-user', 'Study fractions.')
  message.data.source = { kind: 'prechat' }
  applyEvent(t, message, presenters, true)
  applyEvent(t, answer('One half is two quarters.'), presenters, true)
  assert.deepEqual(t.items.map(item => item.text), ['Study fractions.', 'One half is two quarters.'])
})
