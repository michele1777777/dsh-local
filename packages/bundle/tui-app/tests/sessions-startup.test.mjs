import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidatesFromSummaries, resolveCandidate, listCandidates } from '../src/sessions.ts'
import { tuiCommand } from '../src/startup.ts'
import { mergeCommands, filterCommands } from '../src/commands.ts'
const summary = (sessionId, updatedAt, extra = {}) => ({ sessionId, updatedAt, cwd: '/work', running: false, blank: false, ...extra })
test('resume sorts by activity, keeps human forks, excludes subagent/blank sessions', () => {
  const candidates = candidatesFromSummaries([
    summary('old', 1), summary('fork', 9, { parentSessionId: 'old' }), summary('child', 20, { origin: 'subagent' }),
    summary('other', 30, { cwd: '/other' }), summary('empty', 50, { blank: true }),
  ], '/work')
  assert.deepEqual(candidates.map(row => row.id), ['fork', 'old'])
})
test('all-directory discovery and explicit ID/prefix/title matching', () => {
  const candidates = candidatesFromSummaries([
    summary('session-abc', 1, { projections: { values: { title: 'Fix tests' } } }), summary('session-abd', 2, { cwd: '/other' }),
  ], '/work', true)
  assert.equal(candidates.length, 2)
  assert.equal(resolveCandidate(candidates, 'fix tests').id, 'session-abc')
  assert.equal(resolveCandidate(candidates, 'session-abc').id, 'session-abc')
  assert.throws(() => resolveCandidate(candidates, 'session-ab'), /Ambiguous/)
})
test('session discovery calls the shared list service with cancellation', async () => {
  const signal = new AbortController().signal
  const ctx = { sessionController: { list: async (query, actual) => { assert.deepEqual(query, {}); assert.equal(actual, signal); return { items: [summary('a', 1)] } } } }
  assert.equal((await listCandidates(ctx, '/work', false, signal))[0].id, 'a')
})
function parse(args) {
  let value
  const command = tuiCommand(result => { value = result })
  const configure = node => { node.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} }); node.commands.forEach(configure) }
  configure(command)
  command.parse(args, { from: 'user' })
  return value
}
for (const args of [['resume'], ['-r'], ['--resume']]) test(`startup picker: ${args.join(' ')}`, () => { assert.equal(parse(args).pick, true) })
for (const args of [['continue'], ['-c'], ['resume', '--last']]) test(`startup continue: ${args.join(' ')}`, () => { assert.equal(parse(args).continueLast, true) })
test('startup resumes exact ID and preserves quoted multiline opening text', () => {
  const value = parse(['resume', 'session-id', '  first\n second  '])
  assert.equal(value.resumeId, 'session-id'); assert.equal(value.task, '  first\n second  ')
})
test('startup flags include all directories, model and preset; reasoning is not a display switch', () => {
  const value = parse(['--model', 'p/m', '--effort', 'high', '--preset', 'standard', 'task'])
  assert.equal(value.model, 'p/m'); assert.equal(value.effort, 'high'); assert.equal('reasoning' in value, false)
  assert.throws(() => parse(['--no-reasoning']), /unknown option/)
  assert.equal(parse(['resume', '--all']).all, true)
})
for (const args of [['-r', 'id', '-c'], ['resume', 'id', '--last'], ['--preset', 'standard', 'resume', 'id']]) test(`invalid startup: ${args.join(' ')}`, () => { assert.throws(() => parse(args)) })
test('plugin commands win names except reserved safety controls', () => {
  const entries = mergeCommands([{ name: 'model', description: 'plugin model' }, { name: 'compact', description: 'compact' }, { name: 'stop', description: 'plugin stop' }])
  assert.equal(entries.find(row => row.name === 'model').origin, 'registry')
  assert.equal(entries.find(row => row.name === 'stop').origin, 'local')
  assert.equal(filterCommands(entries, '/COMP')[0].name, 'compact')
})
