/** Exercise the shipped terminal composition without a terminal or a model server. */
import assert from 'node:assert/strict'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-prechat/types'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
const path = process.argv[2]
if (path === undefined) throw new Error('Missing overlay path')
const ctx = await bootProductionProfile({ binName: 'prechat-smoke', profile: 'tui', overlayPaths: [resolveConfigPath(path, undefined)] })
try {
  const original = await ctx.sessionController.create({ cwd: process.cwd(), agentPreset: 'minimal' })
  await ctx.sessionController.selectModel({ sessionId: original.sessionId, provider: 'ds4-v41-flash', model: 'deepseek-v4.1-flash' })
  const originalAgent = ctx.agents.get(original.sessionId)!
  const result = await ctx.commands.execute(originalAgent, '/prechat --apply\nUSER: Explain indexes.\nASSISTANT: Indexes speed up lookups.', [], new AbortController().signal)
  assert(result?.result.kind === 'success' && result.result.sessionId !== undefined)
  const id = result.result.sessionId
  const imported = ctx.agents.get(id)!
  assert.equal(imported.session.deriveMessages().length, 2)
  assert.equal(originalAgent.session.deriveMessages().length, 0)
  // Resolve installs the same pending-model consumer used by TUI/Web resume.
  await ctx.sessionController.resolveAgent(id)
  imported.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
  await imported.whenIdle()
  assert.equal(imported.session.deriveMessages().at(-1)?.role, 'assistant')
  await ctx.sessions.flush(imported.session)
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try {
    const stored = await reader.read()
    assert(stored.events.some(event => event.type === 'assistant/message'))
  } finally { await reader.close() }
  const switched = await ctx.sessionController.selectModel({ sessionId: id, provider: 'test-other', model: 'test-other' })
  assert(switched.sessionId !== undefined && switched.sessionId !== id)
  assert.equal(ctx.agents.get(switched.sessionId)!.session.deriveMessages().length, 0)
  assert.equal(ctx.sessionProjections.snapshot(imported.session, ['prechat']).values.prechat, 2)
  assert.equal(ctx.commands.list(ctx.agents.get(switched.sessionId)!).some(command => command.name === 'prechat'), false)
  console.log('PRECHAT_SMOKE', JSON.stringify({ imported: 2, originalUntouched: true, separateModelChat: true }))
} finally { await ctx.fiber.dispose() }
