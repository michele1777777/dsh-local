import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldPermissionAudit, permissionAuditLabel } from '../src/permission-audit.ts'
const asked = (id = 'r') => ({ type: 'approval/asked', time: 1, data: { id, toolName: 'bash' } })
const decided = (outcome, decision = 'allow') => ({ type: 'approval/decided', time: 2, data: { id: 'r', outcome, review: { source: 'reviewer', decision, reason: 'Scoped operation', durationMs: 5 } } })
test('audit only labels an actual one-shot allow as auto-approved', () => {
  const rows = foldPermissionAudit([], asked(), 'main')
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const result = foldPermissionAudit(rows, decided(outcome), 'main')
    assert.ok(!permissionAuditLabel(result[0]).includes('auto-approved'))
    assert.ok(permissionAuditLabel(result[0]).includes(outcome))
  }
  assert.ok(permissionAuditLabel(foldPermissionAudit(rows, decided('allowed-once'), 'main')[0]).includes('auto-approved'))
})
test('human grant after reviewer ask is not presented as machine approval', () => {
  const rows = foldPermissionAudit(foldPermissionAudit([], asked(), 'main'), decided('allowed-once', 'ask'), 'main')
  assert.equal(permissionAuditLabel(rows[0]), 'bash · human fallback → allowed-once')
})
test('same request id in another owner cannot settle the selected session audit', () => {
  const rows = foldPermissionAudit([], asked(), 'main')
  assert.deepEqual(foldPermissionAudit(rows, decided('allowed-once'), 'child'), rows)
})
test('audit replay is bounded and ordinary manual approvals retain their original label', () => {
  let rows = []
  for (let i = 0; i < 70; i++) rows = foldPermissionAudit(rows, asked(String(i)), 'main')
  assert.equal(rows.length, 50)
  assert.equal(rows[0].id, '20')
  const manual = foldPermissionAudit(foldPermissionAudit([], asked(), 'main'), { type: 'approval/decided', data: { id: 'r', outcome: 'allowed-once' } }, 'main')
  assert.equal(permissionAuditLabel(manual[0]), 'bash · allowed-once')
})
