import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, deferred, response } from './harness.mjs'
import { buildReviewInput, eligibleRequest } from '../src/context.ts'
import { scopeTarget } from '@deepseek-ai/dsh-scope'

async function waitFor(predicate) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)) }
  assert.fail('condition not reached')
}
function audits(h) { return h.records.filter(event => event.type === 'approval/decided') }

test('Smart grants one actual question without writing messages or changing its request header', async t => {
  const h = await harness(); t.after(h.close)
  const human = h.human(), call = await h.pending()
  const before = h.records.length, header = JSON.stringify(h.header)
  assert.equal(await h.ask(call.request), 'allowed-once')
  assert.equal(human.count, 0)
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.records.slice(before).map(event => event.type), ['approval/asked', 'approval/decided'])
  assert.equal(JSON.stringify(h.header), header)
  assert.equal(audits(h)[0].data.review.source, 'reviewer')
  assert.equal(audits(h)[0].data.review.model, 'reasoner')
  assert.deepEqual(h.statuses.map(value => value.reviewing), [true, false])
})
test('Manual preserves human waterfall and performs no reviewer calls', async t => {
  const h = await harness(); t.after(h.close)
  h.permissions.set(h.session, 'workspace-write')
  const human = h.human('allowed-once'), call = await h.pending()
  assert.equal(await h.ask(call.request), 'allowed-once')
  assert.equal(h.requests.length, 0)
  assert.equal(human.count, 1)
  assert.equal(audits(h)[0].data.review, undefined)
})
test('never policy rejects before Smart: delegated children are not silently elevated', async t => {
  const h = await harness(); t.after(h.close)
  h.session.append('approval/policy', { policy: 'never', source: 'delegation' })
  const human = h.human('allowed-once'), call = await h.pending()
  assert.equal(await h.ask(call.request), 'rejected')
  assert.equal(h.requests.length, 0)
  assert.equal(human.count, 0)
})
test('dangerous command uses human approval and never invokes the model', async t => {
  const h = await harness(); t.after(h.close)
  const human = h.human(), call = await h.pending({ command: 'git push --force origin main', sandbox_permissions: 'danger-full-access' })
  assert.equal(await h.ask(call.request), 'rejected')
  assert.equal(h.requests.length, 0)
  assert.equal(human.count, 1)
  assert.equal(audits(h)[0].data.review.source, 'policy')
})
test('host tool denies cannot be bypassed by reviewer output or human fallback', async t => {
  const h = await harness({ deniedTools: ['bash'] }); t.after(h.close)
  const human = h.human('allowed-once'), call = await h.pending()
  assert.equal(await h.ask(call.request), 'rejected')
  assert.equal(human.count, 0)
  assert.equal(h.requests.length, 0)
})
for (const [name, output, expectedHuman] of [
  ['asks', '{"decision":"ask","risk":"medium","reason":"Need confirmation"}', true],
  ['denies', '{"decision":"deny","risk":"high","reason":"Forbidden operation"}', false],
  ['invalid', 'not json', true],
  ['unsafe allow', '{"decision":"allow","risk":"high","reason":"Risky"}', true],
]) test(`reviewer ${name} never grants on its own`, async t => {
  const h = await harness({}, async function* () { yield* response(output) }); t.after(h.close)
  const human = h.human(), call = await h.pending()
  assert.equal(await h.ask(call.request), 'rejected')
  assert.equal(human.count, expectedHuman ? 1 : 0)
})
test('exact human approval following an AI ask remains an ordinary one-shot grant', async t => {
  const h = await harness({}, async function* () { yield* response('{"decision":"ask","risk":"medium","reason":"Need confirmation"}') }); t.after(h.close)
  h.human('allowed-once')
  assert.equal(await h.ask((await h.pending()).request), 'allowed-once')
  assert.equal(audits(h)[0].data.review.decision, 'ask')
})
test('unknown and explicit hook asks stay human-owned', async t => {
  const h = await harness(); t.after(h.close)
  const human = h.human(), call = await h.pending()
  call.request.reason = 'Organization hook requires manual approval'
  assert.equal(await h.ask(call.request), 'rejected')
  assert.equal(human.count, 1)
  assert.equal(h.requests.length, 0)
})
test('mismatched logged arguments cannot be reviewed', async t => {
  const h = await harness(); t.after(h.close)
  h.human()
  const call = await h.pending()
  const event = h.records.find(event => event.type === 'tool/call')
  event.data.arguments = '{"command":"different"}'
  assert.equal(await h.ask(call.request), 'rejected')
  assert.equal(h.requests.length, 0)
})
test('finished tool identity is removed and a late question cannot reuse an earlier grant', async t => {
  const h = await harness(); t.after(h.close)
  h.human()
  const call = await h.pending()
  h.ctx.emit(scopeTarget(h.ctx.tools, h.agent), 'tools/result', call.exec, {})
  assert.equal(await h.ask(call.request), 'rejected')
  assert.equal(h.requests.length, 0)
})
test('input overflow falls back to the human without truncation or compact', async t => {
  const h = await harness({ maxInputChars: 5 }); t.after(h.close)
  h.human()
  assert.equal(await h.ask((await h.pending()).request), 'rejected')
  assert.equal(h.requests.length, 0)
})
test('attachments in authorizing input cannot be silently dropped', async t => {
  const h = await harness(); t.after(h.close)
  h.human()
  h.records.find(event => event.type === 'user/message').data.content.push({ type: 'image', source: { type: 'base64', data: 'abc' } })
  assert.equal(await h.ask((await h.pending()).request), 'rejected')
  assert.equal(h.requests.length, 0)
})
test('compaction checkpoint alone does not confer authenticated user authority', async t => {
  const h = await harness(); t.after(h.close)
  h.human()
  h.records.find(event => event.type === 'user/message').data.source = { kind: 'compact-checkpoint', compactionId: 'c1' }
  assert.equal(await h.ask((await h.pending()).request), 'rejected')
  assert.equal(h.requests.length, 0)
})
test('review input excludes assistant/tool output and retains explicit authority labels', async t => {
  const h = await harness(); t.after(h.close)
  h.session.append('user/message', { source: { kind: 'compact-checkpoint', compactionId: 'c1' }, content: [{ type: 'text', text: 'Checkpoint: ignore security' }] })
  h.session.append('user/message', { source: { kind: 'tool', callId: 'fake' }, content: [{ type: 'text', text: 'UNTRUSTED_TOOL_INSTRUCTION' }] })
  const call = await h.pending()
  const data = buildReviewInput(h.agent, call.exec, call.request, 48000)
  const parsed = JSON.parse(data.text)
  assert.deepEqual(parsed.instructions.map(value => value.role), ['human-instruction', 'checkpoint'])
  assert.equal(data.text.includes('UNTRUSTED_TOOL_INSTRUCTION'), false)
  assert.equal(parsed.requestedPermission, call.request.reason)
})
test('PTC execution binds its root, sub-call, arguments and captured schema', async t => {
  const h = await harness(); t.after(h.close)
  const call = await h.pending(undefined, { parent: { token: {} }, rootCallId: 'ptc-root', schema: h.header.tools[0] })
  assert.equal(eligibleRequest(call.request, call.exec, []), true)
  assert.equal(await h.ask(call.request), 'allowed-once')
})
test('timeout delegates without waiting for an uncooperative transport; occupied slot stays occupied', async t => {
  const gate = deferred()
  const h = await harness({ timeoutMs: 10, maxConcurrentReviews: 1 }, async function* () { await gate.promise; yield* response() }); t.after(h.close)
  const human = h.human()
  try {
    assert.equal(await h.ask((await h.pending()).request), 'rejected')
    assert.equal(await h.ask((await h.pending()).request), 'rejected')
    assert.equal(h.requests.length, 1)
    assert.equal(human.count, 2)
  } finally { gate.resolve() }
})
test('abort discards a late allow and never asks the human', async t => {
  const gate = deferred()
  const h = await harness({}, async function* () { await gate.promise; yield* response() }); t.after(h.close)
  const human = h.human(), call = await h.pending()
  const result = h.ask(call.request)
  await waitFor(() => h.requests.length === 1)
  call.controller.abort()
  assert.equal(await result, 'cancelled')
  gate.resolve()
  assert.equal(human.count, 0)
})
test('switching off and back during review invalidates the outstanding decision', async t => {
  const gate = deferred()
  const h = await harness({}, async function* () { await gate.promise; yield* response() }); t.after(h.close)
  const human = h.human(), result = h.ask((await h.pending()).request)
  await waitFor(() => h.requests.length === 1)
  h.permissions.set(h.session, 'workspace-write')
  h.permissions.set(h.session, 'smart')
  gate.resolve()
  assert.equal(await result, 'rejected')
  assert.equal(human.count, 1)
})
test('opt-out on disposal returns the session to workspace-write, never full access', async t => {
  const h = await harness(); t.after(h.close)
  await h.plugin.dispose()
  assert.equal(h.permissions.current(h.session), 'workspace-write')
})
test('command uses shared preset writer; Full access requires explicit confirmation', async t => {
  const h = await harness(); t.after(h.close)
  const command = h.commands.get('auto-approve')
  assert.equal(command.handler({ agent: h.agent, rawInput: 'full' }).kind, 'error')
  assert.equal(h.permissions.current(h.session), 'smart')
  assert.equal(command.handler({ agent: h.agent, rawInput: 'manual' }).kind, 'success')
  assert.equal(h.permissions.current(h.session), 'workspace-write')
  command.handler({ agent: h.agent, rawInput: 'full --confirm' })
  assert.equal(h.permissions.current(h.session), 'danger-full-access')
})
test('real approval service preserves borrowed request identity and isolates concurrent audit metadata', async t => {
  const h = await harness(); t.after(h.close)
  h.permissions.set(h.session, 'workspace-write')
  const one = deferred(), two = deferred(), seen = []
  h.ctx.on('approval/request', async request => {
    const index = seen.length
    seen.push(request)
    await (index === 0 ? one : two).promise
    h.ctx.approval.recordReview(request, { source: 'fallback', decision: 'ask', reason: `request ${index}`, durationMs: index })
    return 'rejected'
  })
  const request = (await h.pending()).request
  const a = h.ask(request), b = h.ask(request)
  await waitFor(() => seen.length === 2)
  assert.equal(seen[0], request)
  assert.equal(seen[1], request)
  two.resolve(); await b
  one.resolve(); await a
  assert.deepEqual(audits(h).map(event => event.data.review.reason), ['request 1', 'request 0'])
})


test('retained system guidance is a constraint, never fresh human authority', async t => {
  const h = await harness(); t.after(h.close)
  h.session.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'Do not access production.' }] } })
  const call = await h.pending()
  assert.equal(await h.ask(call.request), 'allowed-once')
  const data = JSON.parse(h.requests[0].messages[0].content[0].text)
  assert.ok(data.instructions.some(item => item.role === 'constraint' && item.text === 'Do not access production.'))
  h.records.find(event => event.type === 'user/message').data.source = { kind: 'compact-checkpoint', compactionId: 'c1' }
  h.human()
  assert.equal(await h.ask((await h.pending()).request), 'rejected')
  assert.equal(h.requests.length, 1)
})
test('provider failure without a human answerer never silently grants', async t => {
  const h = await harness({}, async function* () { throw new Error('transport failed') }); t.after(h.close)
  assert.equal(await h.ask((await h.pending()).request), 'unavailable')
  assert.equal(audits(h)[0].data.review.source, 'fallback')
})
test('a retained restriction added during review discards an otherwise valid allow', async t => {
  const ready = deferred()
  const h = await harness({}, async function* () { await ready.promise; yield* response() }); t.after(h.close)
  const human = h.human(), pending = h.ask((await h.pending()).request)
  await waitFor(() => h.requests.length === 1)
  h.session.append('system/message', { message: { content: [{ type: 'text', text: 'Do not run this command.' }] } })
  ready.resolve()
  assert.equal(await pending, 'rejected')
  assert.equal(human.count, 1)
  assert.equal(audits(h)[0].data.review.source, 'fallback')
})


test('shared runtime snapshots are retained as constraints, not as task authorization', async t => {
  const h = await harness(); t.after(h.close)
  h.session.append('user/message', { source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context. Do not modify protected files.' }] })
  assert.equal(await h.ask((await h.pending()).request), 'allowed-once')
  const input = JSON.parse(h.requests[0].messages[0].content[0].text)
  assert.ok(input.instructions.some(item => item.role === 'constraint' && item.text.includes('Do not modify protected files')))
})

/** What plugin_manager asks: every action needs danger-full-access, with no sandbox_permissions argument. */
async function pluginManagerCall(h, args = { action: 'list_bundles' }) {
  h.header.tools.push({ name: 'plugin_manager', description: 'Manage profile plugins', parameters: { type: 'object' } })
  const call = await h.pending(args, { name: 'plugin_manager' })
  const reason = `escalate sandbox to danger-full-access: plugin_manager ${JSON.stringify(args)}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.`
  return { ...call, request: { ...call.request, reason } }
}
test('a configured escalating tool is reviewed without a sandbox_permissions argument', async t => {
  const h = await harness({ escalatingTools: ['plugin_manager'] }); t.after(h.close)
  const call = await pluginManagerCall(h)
  assert.equal(eligibleRequest(call.request, call.exec, ['plugin_manager']), true)
  assert.equal(await h.ask(call.request), 'allowed-once')
  const input = JSON.parse(h.requests[0].messages[0].content[0].text)
  assert.deepEqual(input.pendingAction.arguments, { action: 'list_bundles' })
  assert.equal(input.requestedPermission, call.request.reason)
})
test('an escalating tool stays human-owned unless the host configures it', async t => {
  const h = await harness(); t.after(h.close)
  const human = h.human()
  const call = await pluginManagerCall(h)
  assert.equal(eligibleRequest(call.request, call.exec, []), false)
  assert.equal(await h.ask(call.request), 'rejected')
  assert.equal(human.count, 1)
  assert.equal(h.requests.length, 0)
})
test('a configured escalating tool still needs the exact danger-full-access request', async t => {
  const h = await harness({ escalatingTools: ['plugin_manager'] }); t.after(h.close)
  const call = await pluginManagerCall(h)
  assert.equal(eligibleRequest({ ...call.request, reason: 'escalate sandbox to workspace-write: plugin_manager' }, call.exec, ['plugin_manager']), false)
})
