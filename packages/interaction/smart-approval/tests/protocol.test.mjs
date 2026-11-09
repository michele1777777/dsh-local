import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDecision } from '../src/protocol.ts'
import { staticDecision } from '../src/policy.ts'
const low = { decision: 'allow', risk: 'low', reason: 'Scoped read' }
test('strict protocol accepts low-risk allow and preserves the concise reason', () => { assert.deepEqual(parseDecision(JSON.stringify(low)), low) })
for (const decision of ['ask', 'deny']) for (const risk of ['low', 'medium', 'high']) test(`${decision} with ${risk} remains non-grant`, () => {
  assert.equal(parseDecision(JSON.stringify({ decision, risk, reason: 'Requires review' })).decision, decision)
})
for (const raw of [
  'null', '[]', 'true', '{}', '"allow"',
  JSON.stringify({ ...low, risk: 'medium' }), JSON.stringify({ ...low, risk: 'high' }),
  JSON.stringify({ ...low, extra: true }), JSON.stringify({ ...low, reason: '' }),
  JSON.stringify({ ...low, reason: 'x'.repeat(321) }), JSON.stringify({ ...low, reason: '\u001b[0m' }),
  JSON.stringify({ ...low, decision: 'APPROVE' }), JSON.stringify({ ...low, risk: 'unknown' }),
  '{"decision":"deny","risk":"low","decision":"allow","reason":"x"}',
  '{"decision":"allow","risk":"low","re\\u0061son":"one","reason":"two"}',
  '```json\n' + JSON.stringify(low) + '\n```', JSON.stringify(low) + ' extra',
]) test(`invalid protocol fails closed: ${raw.slice(0, 80)}`, () => { assert.throws(() => parseDecision(raw)) })
test('colon and quoted JSON inside a reason are data, not extra fields', () => {
  assert.equal(parseDecision(JSON.stringify({ ...low, reason: 'Reason: "yes"' })).decision, 'allow')
})
const options = { deniedTools: [], humanOnlyTools: ['run_code'] }
const action = (args, cwd = '/work/app', name = 'bash') => ({ name, arguments: args, cwd })
for (const command of ['pnpm test', 'pnpm build', 'npm install', 'git status', 'node tests.js']) test(`no static allowlist for ${command}`, () => {
  assert.equal(staticDecision(action({ command }), options), undefined)
})
for (const command of ['rm -rf build', 'sudo id', 'git push origin main', 'git reset --hard', 'curl https://example.com', 'pnpm test && rm -rf .', 'echo $(cat key)', 'pwsh -c dir', 'Remove-Item .\\cache', 'Invoke-RestMethod https://example.com', 'Set-Acl file', 'Start-Process -Verb RunAs pwsh']) test(`human-only command: ${command}`, () => {
  assert.equal(staticDecision(action({ command }), options)?.decision, 'ask')
})
for (const [path, cwd] of [['../other/file','/work/app'], ['/etc/passwd','/work/app'], ['~/.ssh/id_ed25519','/work/app'], ['C:\\Users\\a','C:\\repo'], ['D:\\repo\\x','C:\\repo'], ['C:relative','C:\\repo'], ['\\\\server\\share','C:\\repo']]) test(`human-only path ${path}`, () => {
  assert.equal(staticDecision(action({ path }, cwd, 'read'), options)?.decision, 'ask')
})
for (const [path, cwd] of [['src/file.ts','/work/app'], ['src\\file.ts','C:\\repo'], ['C:\\repo\\src\\a.ts','C:\\repo']]) test(`in-workspace path is eligible, not statically granted: ${path}`, () => {
  assert.equal(staticDecision(action({ path }, cwd, 'read'), options), undefined)
})
test('explicit exact tool deny dominates other rules', () => {
  assert.equal(staticDecision(action({}, '/repo', 'write'), { deniedTools: ['write'], humanOnlyTools: ['write'] })?.decision, 'deny')
})
test('outer PTC tool remains human owned', () => { assert.equal(staticDecision(action({}, '/repo', 'run_code'), options)?.decision, 'ask') })
test('credential paths cannot be auto-granted by the static layer', () => {
  assert.equal(staticDecision(action({ path: '.env.local' }), options)?.decision, 'ask')
})
