/** The single-row chrome, one-row tool calls, Keys box, palette tabs and transient composer messages. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
register('./ui-loader.mjs', import.meta.url)
const { App } = await import('../src/app.tsx')
const { createHarness } = await import('./ui-harness.mjs')
const { createStore } = await import('../src/store.ts')
const { mergeCommands, paletteView } = await import('../src/commands.ts')
const { createDocumentRenderer, itemRows } = await import('../src/document.ts')
const { markdownRows } = await import('../src/markdown-layout.ts')
const { row, span, textOfRow, widthOf, wrapProse } = await import('../src/rich-text.ts')
const { approvalControls, approvalDetails, indicatorRow, panelLayout, statusRow } = await import('../src/screen.ts')
const { composerError, UsageError } = await import('../src/composer-error.ts')
const { fixture, conversation, tool, approval } = await import('./fixtures.mjs')

const text = rows => rows.map(textOfRow).join('\n')
const registry = [{ name: 'plan', description: 'plan with the preset' }, { name: 'goal', description: 'persistent goal' }, { name: 'compact', description: 'compact context' }]
const skills = [{ name: 'code-review', description: 'review the diff' }]
function setup(overrides = {}, columns = 100, height = 30) {
  const store = createStore(fixture(overrides)), calls = { submit: [], commands: [], cancel: 0 }
  const controller = {
    async submit(value) { calls.submit.push(value) }, async runCommand(line) { calls.commands.push(line) },
    cancel() { calls.cancel++ }, exit() {}, commands: () => mergeCommands(registry, skills), answerApproval() {}, answerQuestion() {},
    hint(value) { store.update((s) => { s.hint = value }) }, closePicker() {}, report(error) { store.update((s) => { s.composerError = composerError(error) }) },
  }
  return { h: createHarness(App, store, controller, columns, height), store, calls, controller }
}
const lines = h => h.rows().map(textOfRow)
async function click(h, predicate) {
  for (const [y, value] of h.rows().entries()) {
    let x = 0
    for (const part of value.spans) {
      if (part.action !== undefined && predicate(part.action)) { await h.key(`\x1b[<0;${x + 1};${y + 1}M`); await h.key(`\x1b[<0;${x + 1};${y + 1}m`); return }
      x += widthOf(part.text)
    }
  }
  assert.fail(`no visible target in:\n${h.text()}`)
}

test('collapsed tool calls are single rows in three columns: command, muted description, and the duration at the right edge', () => {
  const rows = createDocumentRenderer().render(conversation().slice(2, 5), { width: 100, expanded: false, overrides: {} })
  // One blank row above the run, none between consecutive calls; every row reaches the right edge of the frame.
  assert.equal(textOfRow(rows[0]), '')
  assert.match(textOfRow(rows[1]), /^ {2}✓ Read src\/auth\.ts +1\.8s$/)
  assert.match(textOfRow(rows[2]), /^ {2}✓ Edit src\/auth\.ts +\+2 −1 +1\.8s$/)
  assert.match(textOfRow(rows[3]), /^ {2}✓ Run pnpm test --filter auth {2}2 tests passed +1\.8s$/)
  assert.ok(rows.slice(1).every(value => widthOf(textOfRow(value)) === 100))
  // The descriptions of consecutive calls share one column, two cells after the widest command.
  assert.equal(textOfRow(rows[2]).indexOf('+2 −1'), textOfRow(rows[3]).indexOf('2 tests passed'))
  assert.equal(textOfRow(rows[3]).indexOf('2 tests passed'), 2 + widthOf('✓ Run pnpm test --filter auth') + 2)
  assert.equal(rows.length, 4)
  assert.doesNotMatch(text(rows), /[╭╮╰╯│·|]|CMD|READ|EDIT/u)
  const run = rows[3]
  assert.equal(run.spans.find(part => part.text === '✓')?.tone, 'success')
  assert.equal(run.spans.find(part => part.text === ' Run')?.tone, 'muted')
  assert.equal(run.spans.find(part => part.text === '2 tests passed')?.tone, 'muted')
  assert.equal(run.spans.find(part => part.text === '1.8s')?.tone, 'muted')
  assert.ok(run.spans.every(part => part.action?.kind === 'inspect-item' && part.action.itemId === 'tool-1'))
  // Alone, a call starts its description two cells after its own command.
  assert.match(textOfRow(itemRows(conversation()[3], { width: 100, expanded: false, overrides: {} })[1]), /^ {2}✓ Edit src\/auth\.ts {2}\+2 −1 +1\.8s$/)
  // A running call keeps its glyph in the accent tone, never the warning tone; an expanded one is the bordered card.
  const running = itemRows(tool({ settled: false, completedAt: undefined, result: undefined }), { width: 100, expanded: false, overrides: {} })
  assert.equal(running[1].spans.find(part => part.text === '◌')?.tone, 'accent')
  assert.match(text(itemRows(tool(), { width: 100, expanded: false, overrides: { 'tool-1': true } })), /╭─ ▾ ✓ CMD pnpm test --filter auth/)
})

test('a narrowing tool row cuts the command first, keeps the description visible, and keeps the duration', () => {
  const long = tool({ call: { card: 'terminal', title: 'pnpm exec oxlint packages/core/src/auth.ts --deny-warnings', description: 'Lint' },
    result: { card: 'terminal', output: 'Found 0 warnings and 0 errors in 2 files.', exitCode: 0 } })
  const at = width => textOfRow(itemRows(long, { width, expanded: false, overrides: {} })[1])
  assert.equal(at(200), `  ✓ Run pnpm exec oxlint packages/core/src/auth.ts --deny-warnings  Found 0 warnings and 0 errors in 2 files.${' '.repeat(87)}1.8s`)
  assert.equal(at(90), '  ✓ Run pnpm exec oxlint packages/core/s…  Found 0 warnings and 0 errors in 2 files.  1.8s')
  assert.equal(at(76), '  ✓ Run pnpm exec oxlint p…  Found 0 warnings and 0 errors in 2 files.  1.8s')
  // Once the command is down to 16 cells, the description takes the ellipsis.
  assert.equal(at(40), '  ✓ Run pnpm exec…  Found 0 warni…  1.8s')
  for (const width of [12, 20, 40, 76, 90, 200]) assert.equal(widthOf(at(width)), width)
  // A shared column never starts past 60% of the content width, so one long command does not push every description away.
  const rows = createDocumentRenderer().render([conversation()[3], long], { width: 100, expanded: false, overrides: {} })
  assert.equal(textOfRow(rows[1]).indexOf('+2 −1'), 2 + Math.floor(98 * 0.6))
})

test('messages share the two-cell margin: › and ● mark the first rows, and notices get a blank row', () => {
  const [user, , , , , answer] = conversation()
  const prompt = itemRows(user, { width: 80, expanded: false, overrides: {} })
  assert.deepEqual(prompt.map(textOfRow), ['', '› Check authentication, fix expired tokens, and run the tests.'])
  assert.ok(prompt[1].spans.slice(1).every(part => part.bold === true))
  const reply = itemRows(answer, { width: 80, expanded: false, overrides: {} })
  assert.doesNotMatch(text(reply), /● DSH/)
  assert.equal(textOfRow(reply[1]), '● Authentication fixed')
  assert.equal(reply[1].spans[0].tone, 'accent')
  assert.ok(reply.slice(2).every(value => textOfRow(value) === '' || textOfRow(value).startsWith('  ')))
  const notice = itemRows({ kind: 'notice', id: 'n', text: 'Context compacted', level: 'success', settled: true }, { width: 80, expanded: false, overrides: {} })
  assert.deepEqual(notice.map(textOfRow), ['', '  ✓ Context compacted'])
})

test('a code block is a closed box whose right borders share one column, with a clickable Copy in the top border', () => {
  for (const width of [12, 29, 80]) {
    const rows = markdownRows('```ts\nconst value = compute(input, "a long argument that wraps")\n```', width)
    assert.ok(rows[0].codeHeader)
    // The language gives way before the Copy control does.
    assert.match(textOfRow(rows[0]), width >= 16 ? /^╭─ ts ─+ Copy ─╮$/u : /^╭─+ Copy ─╮$/u)
    assert.match(textOfRow(rows.at(-1)), /^╰─+╯$/u)
    assert.ok(rows.slice(1, -1).every(value => /^│ .* │$/u.test(textOfRow(value))))
    assert.ok(rows.every(value => widthOf(textOfRow(value)) === width))
  }
  // A block the text has not closed yet is closed at the end of the layout.
  assert.match(textOfRow(markdownRows('```sh\necho', 40).at(-1)), /^╰─+╯$/u)
  const answer = itemRows({ kind: 'assistant', id: 'a', reasoning: '', text: '```ts\nx\n```', settled: true }, { width: 60, expanded: false, overrides: {} })
  assert.ok(answer.flatMap(value => value.spans).some(part => part.text === 'Copy' && part.action?.kind === 'copy-code'))
})

test('prose wrapping starts wrapped lines at the next word, not with the spaces of the break', () => {
  const wrapped = wrapProse(row(span('alpha beta gamma delta')), 10).map(textOfRow)
  assert.deepEqual(wrapped.map(value => value.trimEnd()), ['alpha beta', 'gamma', 'delta'])
  assert.ok(wrapProse(row(span('one two  three four five six')), 7).every(value => !textOfRow(value).startsWith(' ')))
})

test('the header is one row and goal, plan and tasks share one muted indicator row with their click actions', async () => {
  const goal = { goal: { id: 'g', revision: 1, objective: 'Ship OAuth refresh-token rotation\nDetails', phase: 'active', maxGoalRounds: 20 } }
  const todos = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]
  const { h, store } = setup({ projections: { ...fixture().projections, goal, plan: { active: true }, todos } })
  try {
    assert.match(lines(h)[0], /^DSH {2}Authentication & tests +standard$/)
    assert.doesNotMatch(h.text(), /workspace\/harness|5a4a51d6|GOAL|PLAN|TASKS/)
    assert.equal(lines(h)[1], '◎ Ship OAuth refresh-token rotation   ▣ plan   ☐ 1/2 tasks')
    const indicator = h.rows()[1]
    assert.ok(indicator.spans.filter(part => /[◎▣☐]/u.test(part.text)).every(part => part.tone === 'brand'))
    assert.ok(indicator.spans.filter(part => /\w/u.test(part.text)).every(part => part.tone === 'muted'))
    await click(h, action => action.kind === 'open-tasks')
    assert.equal(store.getState().panel, 'tasks')
  } finally { h.dispose() }
  const blocked = indicatorRow(fixture({ projections: { goal: { goal: { ...goal.goal, phase: 'blocked' } } } }), 80)
  assert.equal(blocked.spans.find(part => part.text.includes('blocked'))?.tone, 'warning')
  assert.equal(indicatorRow(fixture(), 80), undefined)
})

test('the composer sits between two rules over a single status row; decode speed and key hints stay out of it', async () => {
  const job = { id: 'job-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }
  const { h } = setup({ jobs: [job] })
  try {
    const all = lines(h)
    assert.match(all.at(-1), /^● Ready {2}· {2}deepseek\/reasoner high {2}· {2}1 job +▰▱{7} ctx 15% · 20k\/131k {3}\? keys$/u)
    assert.match(all.at(-2), /^─+$/u)
    assert.equal(all.at(-3), '›  Ask anything')
    assert.match(all.at(-4), /^─+$/u)
    assert.doesNotMatch(h.text(), /Enter send|decode|TTFT|Work ·|for commands/)
  } finally { h.dispose() }
  // Panels carry their own keys: the status row stays, without the keys control or hints.
  const panel = setup({ pending: [approval()] })
  try {
    assert.match(lines(panel.h).at(-1), /^! Permission required/)
    assert.doesNotMatch(lines(panel.h).at(-1), /\? keys/)
    assert.doesNotMatch(panel.h.text(), /Enter send/)
  } finally { panel.h.dispose() }
  const running = fixture({ status: 'running', jobs: [job], transcript: { ...fixture().transcript, workStartedAt: 1000 } })
  assert.match(textOfRow(statusRow(running, 130, 0, 61000)), /^⠋ Waiting for model {2}· {2}deepseek\/reasoner high {2}· {2}1 job {2}· {2}1m 0s +▰▱{7} ctx 15% · 20k\/131k {3}\? keys$/u)
  // Narrower, the separators tighten before any entry leaves.
  assert.match(textOfRow(statusRow(running, 100, 0, 61000)), /^⠋ Waiting for model · deepseek\/reasoner high · 1 job · 1m 0s +▰▱{7} ctx 15% · 20k\/131k \? keys$/u)
})

test('? on an empty prompt opens the Keys box; Esc or the next key closes it and that key acts as usual', async () => {
  const { h, store, calls } = setup({ status: 'running' }, 100, 34)
  try {
    await h.key('?')
    assert.match(h.text(), /╭─ Keys ─/)
    assert.match(h.text(), /Enter send .*Alt\+Enter new line .*\/ commands/)
    assert.match(h.text(), /click a tool or thinking line to expand it/)
    assert.doesNotMatch(h.text(), /› \?/)
    // Esc only closes the box: the running turn is not interrupted.
    await h.key('', { escape: true })
    assert.doesNotMatch(h.text(), /─ Keys ─/)
    assert.equal(calls.cancel, 0)
    await h.key('?'); await h.key('x')
    assert.doesNotMatch(h.text(), /─ Keys ─/)
    assert.match(h.text(), /› x/)
    // In a draft, and as the key that closes the box, ? is a character.
    await h.key('?')
    assert.match(h.text(), /› x\?/)
    assert.doesNotMatch(h.text(), /─ Keys ─/)
    store.update((s) => { s.status = 'idle' })
    await h.key('', { backspace: true }); await h.key('', { backspace: true })
    await h.key('?'); await h.key('?')
    assert.match(h.text(), /› \?/)
    assert.doesNotMatch(h.text(), /─ Keys ─/)
  } finally { h.dispose() }
  const mouse = setup()
  try {
    await click(mouse.h, action => action.kind === 'toggle-keys')
    assert.match(mouse.h.text(), /─ Keys ─/)
    await click(mouse.h, action => action.kind === 'toggle-keys')
    assert.doesNotMatch(mouse.h.text(), /─ Keys ─/)
  } finally { mouse.h.dispose() }
})

test('the palette groups an empty query by kind, and the Terminal tab by function', () => {
  const entries = mergeCommands(registry, skills)
  const all = paletteView(entries, '/', 'all')
  assert.deepEqual(all.counts, { all: entries.length, agent: 3, skills: 1, terminal: entries.length - 4 })
  const headers = all.rows.filter(value => value.kind === 'header').map(value => value.label)
  assert.deepEqual(headers, ['AGENT', 'SKILLS', 'TERMINAL'])
  assert.deepEqual(all.entries.slice(0, 4).map(entry => entry.name), ['compact', 'goal', 'plan', 'code-review'])
  const terminal = paletteView(entries, '/', 'terminal')
  assert.deepEqual(terminal.rows.filter(value => value.kind === 'header').map(value => value.label), ['SESSION', 'MODEL & CONTEXT', 'INPUT', 'VIEW', 'SETTINGS'])
  assert.deepEqual(terminal.entries.slice(0, 8).map(entry => entry.name), ['new', 'resume', 'sessions', 'fork', 'rename', 'export', 'clear', 'exit'])
  assert.ok(terminal.entries.every(entry => entry.origin === 'local' && entry.group !== undefined))
  // A typed query keeps the ranking, without headings.
  const typed = paletteView(entries, '/co', 'all')
  assert.equal(typed.grouped, false)
  assert.ok(typed.rows.every(value => value.kind === 'entry'))
  assert.equal(typed.entries[0].name, 'copy')
})

test('palette tabs switch with ←→ only at the end of the query; ↑↓ skip headings; a typed query shows the kind column', async () => {
  const { h, calls } = setup({}, 100, 30)
  try {
    await h.paste('/')
    assert.match(h.text(), /^ {2}All \d+ {3}Agent 3 {3}Skills 1 {3}Terminal \d+$/mu)
    assert.match(h.text(), /^ {2}AGENT {2}from the session preset$/mu)
    assert.match(h.text(), /^❯ \/compact/mu)
    assert.match(h.text(), /1\/\d+ · ↑↓ choose · ←→ category · Tab complete · Enter run · Esc dismiss/)
    // ↑ from the first command wraps to the last; ↓ steps over the SKILLS heading.
    await h.key('', { downArrow: true }); await h.key('', { downArrow: true }); await h.key('', { downArrow: true })
    assert.match(h.text(), /^❯ \/code-review/mu)
    await h.key('', { leftArrow: true })
    assert.match(h.text(), /^ {2}SESSION$/mu)
    assert.match(h.text(), /^❯ \/new/mu)
    await h.key('', { rightArrow: true }); await h.key('', { rightArrow: true })
    assert.match(h.text(), /^❯ \/compact/mu)
    assert.doesNotMatch(h.text(), /AGENT|SESSION/)
    await h.key('', { return: true })
    assert.deepEqual(calls.commands, ['/compact'])
  } finally { h.dispose() }
  const typed = setup({}, 100, 30)
  try {
    await typed.h.paste('/cop')
    assert.match(typed.h.text(), /^❯ \/copy code \| raw +terminal +copy last answer/mu)
    // Away from the end of the query, → moves the cursor instead of the tab.
    await typed.h.key('', { home: true }); await typed.h.key('', { rightArrow: true }); await typed.h.key('x')
    assert.match(typed.h.text(), /› \/xcop/)
    assert.match(typed.h.text(), /^ {2}All \d+ {3}Agent/mu)
    assert.ok(typed.h.rows().some(value => value.spans.some(part => part.text.startsWith('All') && part.bold === true)))
    await click(typed.h, action => action.kind === 'palette-tab' && action.tab === 'skills')
    assert.match(typed.h.text(), /Skills \d+/)
  } finally { typed.h.dispose() }
  const narrow = setup({}, 50, 30)
  try { await narrow.h.paste('/cop'); assert.doesNotMatch(narrow.h.text(), /terminal +copy last/) } finally { narrow.h.dispose() }
})

test('errors stay above the composer until the next keystroke; hints expire; both clear when a prompt or command is sent', async () => {
  const { h, store, controller, calls } = setup()
  try {
    controller.report(new UsageError('/image needs a path', '/image <path>'))
    await h.flush()
    const all = lines(h)
    // Status row, bottom rule, prompt line and top rule sit below the error.
    assert.equal(all.at(-5), '  × /image needs a path · usage: /image <path>')
    assert.equal(store.getState().transcript.items.length, 0)
    await h.key('a')
    assert.doesNotMatch(h.text(), /needs a path/)
    assert.match(h.text(), /› a/)
    controller.hint('Copied 12 chars to clipboard')
    controller.report(new Error('clipboard missing'))
    await h.flush()
    assert.match(h.text(), /× clipboard missing/)
    assert.match(h.text(), /Copied 12 chars/)
    await h.key('', { return: true })
    assert.deepEqual(calls.submit, ['a'])
    assert.doesNotMatch(h.text(), /clipboard missing|Copied 12 chars/)
    controller.report(new Error('stale'))
    await h.flush()
    await h.paste('/help'); await h.key('', { return: true })
    assert.deepEqual(calls.commands, ['/help'])
    assert.equal(store.getState().composerError, undefined)
  } finally { h.dispose() }
})

test('an informational hint clears itself after five seconds', async () => {
  const original = globalThis.setTimeout, expiring = []
  globalThis.setTimeout = (callback, ms, ...rest) => ms === 5000 ? (expiring.push(callback), original(() => {}, 0)) : original(callback, ms, ...rest)
  const { h, controller, store } = setup()
  try {
    controller.hint('Press Ctrl+C again to exit.')
    await h.flush()
    assert.match(h.text(), /Press Ctrl\+C again to exit\./)
    assert.ok(expiring.length > 0)
    expiring.at(-1)()
    await h.flush()
    assert.equal(store.getState().hint, undefined)
    assert.doesNotMatch(h.text(), /Press Ctrl\+C again/)
  } finally { h.dispose(); globalThis.setTimeout = original }
})

test('report() shows a failure above the composer and writes no transcript notice', () => {
  assert.deepEqual(composerError(new UsageError('/attach needs a path', '/attach <path>')), { message: '/attach needs a path', usage: '/attach <path>' })
  assert.equal(new UsageError('/attach needs a path', '/attach <path>').message, '/attach needs a path · usage: /attach <path>')
  assert.deepEqual(composerError('plain'), { message: 'plain' })
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const report = source.slice(source.indexOf('    report(error) {'), source.indexOf('\n    },', source.indexOf('    report(error) {')))
  assert.match(report, /composerError\(error\)/)
  assert.doesNotMatch(report, /notice\(/)
})

test('approval controls follow the details after one blank row, with the default choice bracketed in a neutral tone', () => {
  const details = approvalDetails(approval(), 100)
  const controls = approvalControls(100, false, 1)
  assert.equal(controls.length, 1)
  assert.match(textOfRow(controls[0]), /^ {3}Allow once {4}\[ Reject \] {4}←→ choose · Enter confirm · y select allow · n\/Esc reject$/)
  const reject = controls[0].spans.find(part => part.text === '[ Reject ]')
  assert.equal(reject.tone, 'text'); assert.notEqual(reject.inverse, true)
  const layout = panelLayout('Permission required', details, controls, 100, 30, 0)
  assert.equal(textOfRow(layout.rows[0]).startsWith('── Permission required ─'), true)
  assert.equal(textOfRow(layout.rows[details.length + 1]), '')
  assert.equal(layout.rows[details.length + 2], controls[0])
  assert.equal(layout.rows.length, 30)
  // Narrow, the choice and the keys take one row each.
  assert.equal(approvalControls(40, true, 2).length, 2)
})

test('in-page panels have sentence-case titles', async () => {
  for (const [panel, title] of [['help', 'Help'], ['context', 'Session status'], ['tasks', 'Tasks'], ['jobs', 'Background jobs']]) {
    const { h } = setup({ panel })
    try { assert.match(lines(h)[0], new RegExp(`^── ${title} ─`)); assert.doesNotMatch(h.text(), /in-page|\(IN-PAGE\)/i) } finally { h.dispose() }
  }
})

for (const [columns, height] of [[29, 12], [40, 16], [41, 20], [80, 24]]) test(`the composer block, palette and Keys box stay inside a ${columns}x${height} frame`, async () => {
  const queue = [{ id: 'q', placement: 'queued', message: { id: 'q', content: [{ type: 'text', text: 'and then run the linter '.repeat(4) }] } }]
  const attachments = [{ name: 'a-rather-long-screenshot-name.png', part: { type: 'image' } }]
  const overrides = { transcript: { ...fixture().transcript, items: conversation() }, queue, attachments, composerError: { message: 'a long failure message '.repeat(4), usage: '/image <path>' }, hint: 'Copied 12 chars to clipboard' }
  for (const action of [async () => {}, async h => { await h.paste('/') }, async h => { await h.key('?') }]) {
    const { h } = setup(overrides, columns, height)
    try {
      await action(h)
      assert.equal(h.rows().length, height)
      for (const value of h.rows()) assert.ok(widthOf(textOfRow(value)) <= columns - 1, textOfRow(value))
      // The composer, its rules and the status row are never pushed out of the frame.
      assert.match(lines(h).at(-1), /^● Ready/)
      assert.match(lines(h).at(-2), /^─+$/u)
    } finally { h.dispose() }
  }
})

test('the status line keeps the context bar and numbers longest: keys, model, jobs and timer leave first', () => {
  const job = { id: 'job-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1, output: { total: 0, earliest: 0 } }
  const state = fixture({ jobs: [job], projections: { ...fixture().projections, permissions: { currentValue: 'smart' } } })
  // A 100-column terminal paints 99 cells: everything fits, the bar included.
  assert.match(textOfRow(statusRow(state, 99, 0, 0)), /^● Ready {2}· {2}deepseek\/reasoner high {2}· {2}smart {2}· {2}1 job +▰▱{7} ctx 15% · 20k\/131k {3}\? keys$/u)
  // At 80 columns the keys control is the first to go; the model, bar and numbers stay.
  assert.match(textOfRow(statusRow(state, 79, 0, 0)), /^● Ready · deepseek\/reasoner high · smart · 1 job +▰▱{7} ctx 15% · 20k\/131k$/u)
  const order = ['? keys', 'deepseek/reasoner', '1 job', '▰', '20k/131k', 'ctx 15%', 'smart']
  let gone = 0
  for (let width = 130; width >= 20; width--) {
    const painted = textOfRow(statusRow(state, width, 0, 0))
    assert.ok(widthOf(painted) <= width)
    const missing = order.filter(entry => !painted.includes(entry)).length
    // Entries only ever leave in the listed order.
    assert.ok(order.slice(0, missing).every(entry => !painted.includes(entry)) && order.slice(missing).every(entry => painted.includes(entry)), `${width}: ${painted}`)
    assert.ok(missing >= gone)
    gone = missing
  }
  // While a turn runs, its timer leaves after the jobs and before the bar.
  const running = fixture({ status: 'running', jobs: [job], transcript: { ...fixture().transcript, workStartedAt: 1000 } })
  const timed = [70, 60, 55, 50].map(width => textOfRow(statusRow(running, width, 0, 61000)))
  assert.ok(timed.some(value => value.includes('1m 0s') && value.includes('▰') && !value.includes('1 job')))
  assert.ok(timed.every(value => !value.includes('1m 0s') ? !value.includes('1 job') : true))
})

test('a folded settled thought is one row in the tool columns and opens into the card; live reasoning keeps its label', () => {
  const thought = { kind: 'assistant', id: 'th', reasoning: 'plan the change\ncheck the tests', text: '', settled: true, reasoningStartedAt: 1000, reasoningEndedAt: 3500 }
  const rows = itemRows(thought, { width: 100, expanded: false, overrides: {} })
  assert.deepEqual(rows.map(textOfRow), ['', `  ◦ Thought  2 lines${' '.repeat(76)}2.5s`])
  const line = rows[1]
  assert.ok(line.spans.slice(1).every(part => part.action?.kind === 'toggle-reasoning' && part.action.itemId === 'th'))
  assert.equal(line.spans.find(part => part.text.startsWith('◦'))?.tone, 'reasoning')
  assert.equal(line.spans.find(part => part.text.includes('2 lines'))?.tone, 'muted')
  // No timestamps: no duration and no placeholder.
  const untimed = itemRows({ ...thought, reasoningStartedAt: undefined, reasoningEndedAt: undefined }, { width: 100, expanded: false, overrides: {} })
  assert.equal(textOfRow(untimed[1]).trimEnd(), '  ◦ Thought  2 lines')
  const opened = itemRows({ ...thought, reasoningStartedAt: undefined, reasoningEndedAt: undefined }, { width: 100, expanded: false, overrides: { 'reasoning:th': true } })
  assert.match(textOfRow(opened[1]), /^ {2}╭─ ▾ Thought · 2 lines ─+╮$/u)
  assert.doesNotMatch(text(opened), /—/)
  // A thought followed by tool calls forms one list whose descriptions share a column; an answer after a thought keeps the
  // thought row above its ● row.
  const listed = createDocumentRenderer().render([thought, tool()], { width: 100, expanded: false, overrides: {} })
  assert.deepEqual(listed.map(value => textOfRow(value).trim().split(/ {2,}/u)[0]), ['', '◦ Thought', '✓ Run pnpm test --filter auth'])
  assert.equal(textOfRow(listed[1]).indexOf('2 lines'), textOfRow(listed[2]).indexOf('2 tests passed'))
  const answered = itemRows({ ...thought, text: 'Done.' }, { width: 100, expanded: false, overrides: {} })
  assert.deepEqual(answered.map(value => textOfRow(value).trimEnd()), ['', '  ◦ Thought  2 lines' + ' '.repeat(76) + '2.5s', '● Done.'])
  // Still thinking, the live label stays.
  const live = itemRows({ ...thought, settled: false, reasoningEndedAt: undefined }, { width: 100, expanded: false, overrides: {}, tick: 0, now: 5000 })
  assert.match(textOfRow(live[1]), /Thinking… · 4s · 2 lines/)
})
