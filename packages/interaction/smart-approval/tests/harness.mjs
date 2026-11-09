/** Test doubles are confined to tools, provider transport and the permission catalog. */
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import * as SmartApproval from '../src/index.ts'

export function response(text = '{"decision":"allow","risk":"low","reason":"Scoped read"}') {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export async function harness(config = {}, script = async function* () { yield* response() }) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  const requests = [], statuses = [], commands = new Map(), records = [], selections = new Map()
  const header = { config: { provider: 'local', model: 'reasoner' }, tools: [{ name: 'bash', description: 'Runs a command', parameters: { type: 'object' } }] }
  const session = {
    id: 'session-test', inheritedEventCount: 0, snapshotEvents(start = 0, end = records.length) { return records.slice(start, end) }, header: { cwd: '/work/app', origin: 'user' }, surface: { nodes: [] },
    get seq() { return records.length }, eventAt(index) { return records[index] },
    requestHeader() { return header }, isOwnSeq() { return true },
    append(type, data) {
      const event = { seq: records.length, time: Date.now(), type, data }
      records.push(event)
      if (type === 'user/message' || type === 'system/message') session.surface.nodes.push(event.seq)
      ctx.emit('session/event', session, event)
      return event
    },
  }
  const agent = { id: session.id, session, ctx, inject() { throw new Error('Reviewer must not inject any main message') } }
  const transport = {
    async *stream(options) { requests.push(options); yield* script(options) },
  }
  const permissions = {
    names: ['workspace-write', 'danger-full-access', 'smart'],
    current(target) { return selections.get(target) ?? 'workspace-write' },
    set(target, value) { selections.set(target, value); target.append('permission/preset', { preset: value }) },
    setForAgent(target, value) { this.set(target.session, value) },
    registerSmart(admit) { this.admit = admit; return async () => { this.admit = undefined } },
  }
  ctx.provide('sessions', { list: () => [session] })
  ctx.provide('tools', {})
  ctx.provide('permissionPresets', permissions)
  ctx.provide('llm', transport)
  ctx.provide('commands', { register(command) { commands.set(command.name, command) } })
  ctx.on('smart-approval/status', value => { statuses.push(value) })
  const plugin = await ctx.plugin(SmartApproval, config)
  permissions.set(session, 'smart')
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { source: { kind: 'user', rpcId: 'rpc-user' }, content: [{ type: 'text', text: 'Inspect the repository status only.' }] })
  session.append('step/start', { step: 1, turn: 1 })
  let nextId = 0
  async function pending(args = { command: 'git status', sandbox_permissions: 'danger-full-access' }, additions = {}) {
    const callId = `call-${++nextId}`
    const controller = new AbortController()
    const exec = Object.freeze({ agent, name: 'bash', callId, arguments: args, rootCallId: callId, signal: controller.signal, token: {}, ...additions })
    if (exec.parent === undefined) session.append('tool/call', { callId, name: exec.name, arguments: JSON.stringify(args) })
    else session.append('tool/ptc-dispatch-start', { subCallId: callId, rootCallId: exec.rootCallId, name: exec.name, arguments: args })
    await ctx.waterfall(scopeTarget(ctx.tools, agent), 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
    const request = { agent, callId, toolName: exec.name, reason: `escalate sandbox to ${args.sandbox_permissions}: Inspect status`, signal: controller.signal }
    return { exec, request, controller }
  }
  const ask = request => ctx.approval.request(request)
  return { ctx, agent, session, header, records, requests, statuses, commands, permissions, plugin, pending, ask,
    human(outcome = 'rejected') { let count = 0; const off = ctx.on('approval/request', () => { count++; return Promise.resolve(outcome) }); return { get count() { return count }, off } },
    close: () => ctx.fiber.dispose(),
  }
}
