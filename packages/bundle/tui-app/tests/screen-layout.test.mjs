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
const { approvalControls, approvalDetails, cardLayout, indicatorRow, inspectorRows, panelLayout, statusRow } = await import('../src/screen.ts')
const { composerError, UsageError } = await import('../src/composer-error.ts')
const { fixture, conversation, tool, approval, question } = await import('./fixtures.mjs')

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

test('a collapsed tool call is its command with the duration right after it, and its description on a connector row below', () => {
  const rows = createDocumentRenderer().render(conversation().slice(2, 5), { width: 100, expanded: false, overrides: {} })
  // One blank row above the run. The verbs are padded to one width, so the targets start in one column; the duration
  // follows the command behind a middle dot, and what the call did hangs under the verb on a thin connector.
  assert.deepEqual(rows.map(textOfRow), ['', '  • Read   src/auth.ts · 1.8s', '  • Edit   src/auth.ts · 1.8s', '    └─ +2 −1',
    '  • Run    pnpm test --filter auth · 1.8s', '    └─ Run authentication tests'])
  assert.doesNotMatch(text(rows), /[╭╮╰╯│|✓×]|CMD|READ|EDIT/u)
  const [, read, edit, counts, run, described] = rows
  // The status is a dot whose colour tells the outcome.
  assert.deepEqual([run.spans.find(part => part.text === '•')?.tone, read.spans.find(part => part.text === '•')?.tone], ['success', 'success'])
  // The verb carries its tool category's tone; a file change counts added lines in green and removed lines in red.
  assert.equal(run.spans.find(part => part.text.trim() === 'Run')?.tone, 'toolBash')
  assert.equal(read.spans.find(part => part.text.trim() === 'Read')?.tone, 'toolRead')
  assert.equal(edit.spans.find(part => part.text.trim() === 'Edit')?.tone, 'toolEdit')
  assert.equal(counts.spans.find(part => part.text === '+2')?.tone, 'success')
  assert.equal(counts.spans.find(part => part.text === '−1')?.tone, 'error')
  // The description is secondary text in a legible grey; the connector and the duration are fainter.
  assert.equal(described.spans.find(part => part.text === 'Run authentication tests')?.tone, 'description')
  assert.equal(described.spans.find(part => part.text === '└─ ')?.tone, 'comment')
  assert.equal(run.spans.find(part => part.text === '1.8s')?.tone, 'muted')
  // Both rows of a call open it.
  assert.ok([run, described].every(value => value.spans.every(part => part.action?.kind === 'inspect-item' && part.action.itemId === 'tool-1')))
  // A running call has a ring in the accent tone, never the warning tone; an open one is its title row and the body behind a
  // dashed rail, with the exit code and the duration after the command.
  const running = itemRows(tool({ settled: false, completedAt: undefined, result: undefined }), { width: 100, expanded: false, overrides: {} })
  assert.equal(running[1].spans.find(part => part.text === '◌')?.tone, 'accent')
  assert.match(text(itemRows(tool(), { width: 100, expanded: false, overrides: { 'tool-1': true } })), /^ {2}▾ • Run {4}pnpm test --filter auth · exit 0 · 1\.8s\n {2}┇ Run authentication tests$/mu)
})

test('the description row says what the model said a call does, while it runs, after it succeeds and beside a failure', () => {
  const at = item => itemRows(item, { width: 100, expanded: false, overrides: {} }).slice(1)
  assert.deepEqual(at(tool({ settled: false, completedAt: undefined, result: undefined })).map(textOfRow), ['  ◌ Run    pnpm test --filter auth', '    └─ Run authentication tests'])
  const failed = at(tool({ result: { card: 'terminal', output: 'FAIL auth.test.ts', exitCode: 1 } }))
  assert.deepEqual(failed.map(textOfRow), ['  • Run    pnpm test --filter auth · 1.8s', '    └─ Run authentication tests · exit 1'])
  // A failed call has a red dot, a call ended by a signal too, a successful one a green dot, an interrupted one a yellow dot.
  const dot = rows => rows[0].spans.find(part => part.text === '•')?.tone
  assert.equal(dot(failed), 'error')
  assert.equal(dot(at(tool({ result: { card: 'terminal', output: '', signal: 'SIGTERM' } }))), 'error')
  assert.equal(dot(at(tool({ result: { card: 'terminal', output: 'ok', exitCode: 0 } }))), 'success')
  assert.equal(dot(at(tool({ cancelled: true }))), 'warning')
  assert.equal(failed[1].spans.find(part => part.text.includes('Run authentication tests'))?.tone, 'description')
  assert.equal(failed[1].spans.find(part => part.text === 'exit 1')?.tone, 'error')
  assert.match(textOfRow(at(tool({ cancelled: true }))[1]), /Run authentication tests · interrupted$/u)
  // A call view without a description falls back to the call's own description argument, on one line.
  const generic = tool({ args: { description: 'Start the\n  dev server', command: 'pnpm dev' }, call: { card: 'generic', title: 'Run pnpm dev', kind: 'execute' } })
  assert.equal(textOfRow(at(generic)[1]), '    └─ Start the dev server')
})

test('a narrowing tool row cuts the command in its middle and wraps the description, which is never cut', () => {
  const long = tool({ call: { card: 'terminal', title: 'pnpm exec oxlint packages/core/src/auth.ts --deny-warnings' },
    result: { card: 'terminal', output: 'Found 0 warnings and 0 errors in 2 files.', exitCode: 0 } })
  const at = (item, width) => itemRows(item, { width, expanded: false, overrides: {} }).slice(1).map(textOfRow)
  // A call the model did not describe says its result in a few words on the connector row.
  assert.deepEqual(at(long, 200), ['  • Run    pnpm exec oxlint packages/core/src/auth.ts --deny-warnings · 1.8s', '    └─ Found 0 warnings and 0 errors in 2 files.'])
  // Narrow, the command gives way and the duration stays beside it; the note wraps under the connector.
  assert.deepEqual(at(long, 40), ['  • Run    pnpm exec oxlint pack… · 1.8s', '    └─ Found 0 warnings and 0 errors in ', '       2 files.'])
  for (const width of [12, 20, 40, 76, 90, 200]) {
    const lines = at(long, width)
    assert.ok(lines.every(value => widthOf(value) <= width), `${width}: ${lines.join('|')}`)
    assert.equal(lines.slice(1).map(value => value.replace(/^ +(?:└─ )?/u, '')).join('').replace(/\s/gu, ''), 'Found0warningsand0errorsin2files.')
  }
  const described = tool({ call: { card: 'terminal', title: 'pnpm exec oxlint packages/core/src/auth.ts --deny-warnings', description: 'Lint the auth module' } })
  assert.deepEqual(at(described, 100), ['  • Run    pnpm exec oxlint packages/core/src/auth.ts --deny-warnings · 1.8s', '    └─ Lint the auth module'])
  assert.deepEqual(at(described, 60), ['  • Run    pnpm exec oxlint packages/core/src/auth.t… · 1.8s', '    └─ Lint the auth module'])
  assert.deepEqual(at(described, 30), ['  • Run    pnpm exec o… · 1.8s', '    └─ Lint the auth module'])
  // A long command with whole words at its end keeps them: the program and the last arguments both show.
  const piped = tool({ call: { card: 'terminal', title: 'find packages -name "*.ts" -newer .last-run -print0 | xargs -0 grep -l expiresAt | sort -u', description: 'List files that touch expiry' } })
  assert.equal(at(piped, 70)[0], '  • Run    find packages -name "*.ts" … | sort -u · 1.8s')
})

test('messages share the two-cell margin: a prompt stands on a band behind an accent bar, a dot marks an answer, and notices get a blank row', () => {
  const [user, , , , , answer] = conversation()
  const prompt = itemRows(user, { width: 80, expanded: false, overrides: {} })
  assert.deepEqual(prompt.map(value => textOfRow(value).trimEnd()), ['', '▌ Check authentication, fix expired tokens, and run the tests.'])
  // The band runs the whole width, under the bar, the bold text and the padding after it.
  assert.equal(widthOf(textOfRow(prompt[1])), 80)
  assert.ok(prompt[1].spans.every(part => part.background === 'band'))
  assert.deepEqual([prompt[1].spans[0].text, prompt[1].spans[0].tone], ['▌ ', 'accent'])
  assert.ok(prompt[1].spans.slice(1, -1).every(part => part.bold === true))
  const reply = itemRows(answer, { width: 80, expanded: false, overrides: {} })
  assert.doesNotMatch(text(reply), /• DSH/)
  assert.equal(textOfRow(reply[1]), '• Authentication fixed')
  assert.equal(reply[1].spans[0].tone, 'accent')
  assert.ok(reply.slice(2).every(value => textOfRow(value) === '' || textOfRow(value).startsWith('  ')))
  const notice = itemRows({ kind: 'notice', id: 'n', text: 'Context compacted', level: 'success', settled: true }, { width: 80, expanded: false, overrides: {} })
  assert.deepEqual(notice.map(textOfRow), ['', '  • Context compacted'])
  assert.equal(notice[1].spans.find(part => part.text.startsWith('•'))?.tone, 'success')
})

test('a code block stands on a band without borders, with a clickable Copy in its header row', () => {
  for (const width of [6, 12, 29, 80]) {
    const rows = markdownRows('```ts\nconst value = compute(input, "a long argument that wraps")\n```', width)
    assert.ok(rows[0].codeHeader)
    // The language gives way before the Copy control does.
    assert.match(textOfRow(rows[0]), width >= 12 ? /^ts ─+ Copy$/u : /^─+ Copy$/u)
    // No border character stands beside the code, so a terminal's own selection copies the code alone.
    assert.equal(rows.slice(1).map(textOfRow).join('').replace(/ /g, ''), 'const value = compute(input, "a long argument that wraps")'.replace(/ /g, ''))
    assert.doesNotMatch(rows.slice(1).map(textOfRow).join('\n'), /[│╭╮╰╯]/u)
    assert.ok(rows.every(value => widthOf(textOfRow(value)) === width))
    assert.ok(rows.every(value => value.spans.every(part => part.background === 'band')))
  }
  // A block the text has not closed yet ends with its last line.
  assert.equal(textOfRow(markdownRows('```sh\necho', 40).at(-1)).trimEnd(), 'echo')
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
    assert.match(lines(h)[0], /^ DSH {3}Authentication & tests +harness · standard$/)
    assert.deepEqual(h.rows()[0].spans[0], { text: ' DSH ', tone: 'accent', bold: true, inverse: true })
    // The header names the working directory by its last segment only, never the path or the session id.
    // The header and the indicator row name the folder alone; the whole path is on the welcome, under its title.
    assert.doesNotMatch(lines(h).slice(0, 2).join('\n'), /workspace\/harness|5a4a51d6|GOAL|PLAN|TASKS/)
    assert.doesNotMatch(h.text(), /5a4a51d6|GOAL|PLAN|TASKS/)
    assert.match(h.text(), /^ +\/workspace\/harness · deepseek\/reasoner high$/mu)
    // Goal and plan on the left; on the right the checklist as a one-colour meter, its count and the task in progress.
    // With rows to spare, a blank row separates the header, the indicator row and the conversation.
    assert.deepEqual([lines(h)[1], lines(h)[3]], ['', ''])
    assert.equal(lines(h)[2], `◎ Ship OAuth refresh-token rotation   ▣ plan${' '.repeat(39)}tasks ▰▱ 1/2 · b`)
    const indicator = h.rows()[2]
    const tone = text => indicator.spans.find(part => part.text.includes(text))?.tone
    assert.deepEqual([tone('◎'), tone('Ship OAuth'), tone('▣'), tone('plan'), tone('▰'), tone('▱'), tone('1/2'), tone('b')],
      ['accent', 'text', 'brand', 'muted', 'accent', 'comment', 'muted', 'text'])
    assert.equal(indicator.spans.find(part => part.text.includes('Ship OAuth'))?.bold, true)
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
  assert.deepEqual(terminal.rows.filter(value => value.kind === 'header').map(value => value.label), ['SESSION', 'MODEL & CONTEXT', 'VIEW', 'SETTINGS'])
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
    assert.match(h.text(), /^ {3}All {2}\d+ {3}Agent 3 {3}Skills 1 {3}Terminal \d+$/mu)
    assert.match(h.text(), /^ {2}AGENT {2}from the session preset ─+$/mu)
    assert.match(h.text(), /^❯ \/compact/mu)
    // The chosen command stands on the selection background across the whole row; the others have none.
    const chosen = h.rows().find(value => textOfRow(value).startsWith('❯ /compact'))
    assert.ok(chosen.spans.every(part => part.background === 'select')); assert.equal(widthOf(textOfRow(chosen)), 99)
    assert.ok(h.rows().find(value => textOfRow(value).startsWith('  /goal')).spans.every(part => part.background === undefined))
    assert.match(h.text(), /^ {2}1 of \d+ +↑↓ choose · ←→ category · Tab complete · Enter run · Esc dismiss$/mu)
    // ↑ from the first command wraps to the last; ↓ steps over the SKILLS heading.
    await h.key('', { downArrow: true }); await h.key('', { downArrow: true }); await h.key('', { downArrow: true })
    assert.match(h.text(), /^❯ \/code-review/mu)
    await h.key('', { leftArrow: true })
    assert.match(h.text(), /^ {2}SESSION ─+$/mu)
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
    assert.match(typed.h.text(), /^ {3}All {2}\d+ {3}Agent/mu)
    assert.ok(typed.h.rows().some(value => value.spans.some(part => part.text === ' All ' && part.bold === true && part.inverse === true)))
    await click(typed.h, action => action.kind === 'palette-tab' && action.tab === 'skills')
    assert.match(typed.h.text(), / Skills {2}\d+/)
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

test('the approval card: the command on a neutral band, folded arguments, and the default choice filled in the warning tone', () => {
  const details = approvalDetails(approval(), 94)
  // The command is whole on its band; the arguments are folded beside it and open on request.
  const band = details[0]
  assert.match(textOfRow(band), /^ \$ pnpm test --filter auth +$/u)
  assert.ok(band.spans.every(part => part.background === 'plate')); assert.equal(widthOf(textOfRow(band)), 94)
  assert.match(text(details), /^in \/workspace\/harness · owner session-demo +Copy$/mu)
  assert.match(text(details), /^▸ Arguments · 2 fields$/mu)
  assert.doesNotMatch(text(details), /"command"/)
  assert.match(text(approvalDetails(approval(), 94, true)), /^▾ Arguments · 2 fields\n {2}\{\n {4}"command"/mu)
  // Without a command the arguments are the request, and show.
  assert.match(text(approvalDetails({ ...approval(), detail: 'plain arguments' }, 94)), /^▾ Arguments\n {2}plain arguments$/mu)
  const controls = approvalControls(94, false, 1)
  assert.equal(controls.length, 1)
  assert.match(textOfRow(controls[0]), /^ {2}Allow once {6}Reject {6}Enter confirm · y select allow · n\/Esc reject · a arguments$/)
  const reject = controls[0].spans.find(part => part.text === '  Reject  ')
  assert.deepEqual([reject.tone, reject.inverse, reject.bold], ['warning', true, true])
  assert.notEqual(controls[0].spans.find(part => part.text === '  Allow once  ').inverse, true)
  assert.ok(controls[0].spans.every(part => part.tone !== 'success' && part.tone !== 'error'))
  // The card is as tall as its content: borders, a blank row above the details and one above the controls.
  const layout = cardLayout('! Permission required', 'bash', details, controls, 'warning', 100, 30, 0)
  assert.match(textOfRow(layout.rows[0]), /^╭─ ! Permission required ─+ bash ─╮$/u)
  assert.equal(layout.rows.length, details.length + controls.length + 4)
  assert.ok(layout.rows.every(value => widthOf(textOfRow(value)) === 100))
  assert.match(textOfRow(layout.rows.at(-1)), /^╰─+╯$/u)
  assert.equal(textOfRow(layout.rows.at(-3)).replace(/[│ ]/gu, ''), '')
  // Too tall, only the details scroll, above a position row and the pinned controls.
  const long = approvalDetails({ ...approval(), detail: Array.from({ length: 60 }, (_, index) => `line-${index}`).join('\n') }, 94)
  const scrolled = cardLayout('! Permission required', 'bash', long, controls, 'warning', 100, 12, 1e6)
  assert.equal(scrolled.rows.length, 12)
  assert.match(text(scrolled.rows), /line-59/); assert.match(text(scrolled.rows), /of \d+ · PgUp\/PgDn scroll/); assert.match(text(scrolled.rows), /Allow once/)
  // Narrow, the choice and the keys take one row each.
  assert.equal(approvalControls(40, true, 2).length, 2)
})

test('an approval takes the composer\'s place: the conversation stays above the card and the status row below it', async () => {
  const transcript = fixture().transcript; transcript.items = conversation()
  const { h } = setup({ transcript, pending: [approval()] })
  try {
    const all = lines(h)
    assert.match(all[0], /^ DSH /)
    assert.ok(all.some(value => value.includes('Authentication fixed')))
    assert.match(all.at(-1), /^! Permission required/)
    assert.match(all.at(-2), /^╰─+╯$/u)
    const top = all.findIndex(value => value.startsWith('╭─ ! Permission required'))
    assert.equal(all[top - 1], '')
    assert.doesNotMatch(h.text(), /Ask anything/)
    // `a` opens the complete arguments.
    assert.doesNotMatch(h.text(), /"command"/)
    await h.key('a')
    assert.match(h.text(), /▾ Arguments · 2 fields/); assert.match(h.text(), /"command"/)
  } finally { h.dispose() }
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

test('a folded settled thought is one row and opens behind a rail; live reasoning keeps its label', () => {
  const thought = { kind: 'assistant', id: 'th', reasoning: 'plan the change\ncheck the tests', text: '', settled: true, reasoningStartedAt: 1000, reasoningEndedAt: 3500 }
  const rows = itemRows(thought, { width: 100, expanded: false, overrides: {} })
  assert.deepEqual(rows.map(textOfRow), ['', '  ✦ Thought · 2.5s'])
  const line = rows[1]
  assert.ok(line.spans.slice(1).every(part => part.action?.kind === 'toggle-reasoning' && part.action.itemId === 'th'))
  assert.equal(line.spans.find(part => part.text.startsWith('✦'))?.tone, 'reasoning')
  assert.equal(line.spans.find(part => part.text.includes('2.5s'))?.tone, 'muted')
  // No timestamps: the line count stands in for the duration.
  const untimed = itemRows({ ...thought, reasoningStartedAt: undefined, reasoningEndedAt: undefined }, { width: 100, expanded: false, overrides: {} })
  assert.equal(textOfRow(untimed[1]), '  ✦ Thought · 2 lines')
  const opened = itemRows({ ...thought, reasoningStartedAt: undefined, reasoningEndedAt: undefined }, { width: 100, expanded: false, overrides: { 'reasoning:th': true } })
  assert.deepEqual(opened.map(textOfRow), ['', '  ▾ Thought · 2 lines', '  ┊ plan the change', '  ┊ check the tests'])
  assert.doesNotMatch(text(opened), /—/)
  // On a short terminal a thought followed by tool calls forms one list without blank rows, and an answer after a thought
  // keeps the thought row above its dot row; with rows to spare a blank row separates the thought from the answer.
  const listed = createDocumentRenderer().render([thought, tool()], { width: 100, expanded: false, overrides: {} })
  assert.deepEqual(listed.map(value => textOfRow(value).trim().split(/ {2,}/u)[0]), ['', '✦ Thought · 2.5s', '• Run', '└─ Run authentication tests'])
  const answered = itemRows({ ...thought, text: 'Done.' }, { width: 100, expanded: false, overrides: {} })
  assert.deepEqual(answered.map(value => textOfRow(value).trimEnd()), ['', '  ✦ Thought · 2.5s', '• Done.'])
  const spaced = itemRows({ ...thought, text: 'Done.' }, { width: 100, expanded: false, overrides: {}, terminalRows: 30 })
  assert.deepEqual(spaced.map(value => textOfRow(value).trimEnd()), ['', '  ✦ Thought · 2.5s', '', '• Done.'])
  // Still thinking, the live label stays.
  const live = itemRows({ ...thought, settled: false, reasoningEndedAt: undefined }, { width: 100, expanded: false, overrides: {}, tick: 0, now: 5000 })
  assert.match(textOfRow(live[1]), /Thinking… · 4s · 2 lines/)
})

test('a running compaction has one live row directly under the last item: the context size and the elapsed time', () => {
  const transcript = fixture().transcript
  transcript.items = conversation().slice(0, 3); transcript.compacting = true; transcript.usage = { input: 48_000, output: 10 }
  const { h } = setup({ transcript, motion: false })
  try {
    const all = lines(h), at = all.findIndex(value => value.includes('Compacting context'))
    assert.match(all[at], /^ {2}◌ Compacting context {3}48k tokens +0s$/u)
    assert.notEqual(all[at - 1].trim(), '')
  } finally { h.dispose() }
})

test('a question is a card in the composer\'s place: numbered options with descriptions, the one in focus on the selection background', async () => {
  const transcript = fixture().transcript; transcript.items = conversation()
  const { h } = setup({ transcript, pending: [question()] })
  try {
    const all = lines(h)
    assert.ok(all.some(value => /^╭─ Review implementation plan ─+╮$/u.test(value)))
    assert.ok(all.some(value => value.includes('Authentication fixed')))
    assert.match(all.at(-1), /^! Your answer is needed/)
    const option = label => h.rows().find(value => textOfRow(value).includes(label))
    assert.match(textOfRow(option('Approve  ')), /^│ {3}● 1 {2}Approve {8}Proceed with the proposed implementation\. +│$/u)
    assert.ok(option('Approve  ').spans.some(part => part.background === 'select'))
    assert.match(textOfRow(option('Keep planning')), /^│ {3}○ 2 {2}Keep planning {2}Continue exploring before making changes\. +│$/u)
    assert.ok(option('Keep planning').spans.every(part => part.background === undefined))
    assert.match(h.text(), /✎ {2}Tab {2}Write your own answer/u)
    assert.match(h.text(), /↑↓ choose · 1–2 pick · Space select · Enter confirm · Tab custom · Esc cancel/u)
    // A digit picks the option with that number.
    await h.key('2')
    assert.match(textOfRow(option('Keep planning')), /^│ {3}● 2 /u)
    assert.match(textOfRow(option('Approve  ')), /^│ {3}○ 1 /u)
    assert.ok(option('Keep planning').spans.some(part => part.background === 'select'))
  } finally { h.dispose() }
})

test('a short picker is a card in the composer\'s place; the conversation stays above it', async () => {
  const transcript = fixture().transcript; transcript.items = conversation()
  const picker = { kind: 'models', title: 'Model', rows: [{ id: 'a', label: 'deepseek/reasoner', detail: 'reasoning · 128k context', current: true },
    { id: 'b', label: 'deepseek/chat', detail: 'fast · 128k context' }] }
  const { h } = setup({ transcript, picker })
  try {
    const all = lines(h)
    assert.ok(all.some(value => /^╭─ Model ─+ 1 of 2 ─╮$/u.test(value)))
    assert.ok(all.some(value => /^│ {2}❯ ● deepseek\/reasoner {2}reasoning · 128k context +current +│$/u.test(value)))
    assert.ok(all.some(value => /^│ {6}deepseek\/chat {6}fast · 128k context +│$/u.test(value)))
    assert.ok(all.some(value => value.includes('Authentication fixed')))
    assert.match(h.text(), /↑↓ choose · Enter select · type to filter · Esc close/u)
    assert.doesNotMatch(h.text(), /Ask anything/)
    await h.key('', { downArrow: true })
    assert.ok(lines(h).some(value => /^│ {2}❯ {3}deepseek\/chat /u.test(value)))
    assert.ok(h.rows().find(value => textOfRow(value).includes('deepseek/chat')).spans.some(part => part.background === 'select'))
  } finally { h.dispose() }
})

test('the tasks panel: goal and plan, the checklist with a meter and one row per task, and empty sections on one row', () => {
  const state = fixture({ projections: { ...fixture().projections, goal: { goal: { objective: 'Make expired tokens fail closed', phase: 'active' } }, plan: { active: true },
    todos: [{ content: 'Inspect token validation', status: 'completed' }, { content: 'Add expiry checks', status: 'in_progress' }, { content: 'Run the focused tests', status: 'pending' }] } })
  const rows = inspectorRows(state, 'tasks', [], 80), all = rows.map(textOfRow)
  assert.match(all[0], /^◎ Make expired tokens fail closed +goal · active$/u)
  assert.equal(all[1], '▣ plan')
  assert.equal(all[3], 'Checklist   ▰▱▱  1 of 3')
  assert.match(all[4], /^ {2}• {2}Inspect token validation +done$/u)
  assert.match(all[5], /^ {2}◐ {2}Add expiry checks +in progress$/u)
  assert.equal(all[6], '  ○  Run the focused tests')
  // The dot of a finished task is green; the task in progress is bold in the accent tone.
  assert.equal(rows[4].spans[0].tone, 'success'); assert.equal(rows[5].spans[0].tone, 'accent'); assert.equal(rows[5].spans[1].bold, true)
  assert.match(all[8], /^Background jobs +none$/u); assert.match(all[9], /^Queued messages +none$/u)
  assert.ok(rows.every(value => widthOf(textOfRow(value)) <= 80))
  assert.match(inspectorRows(fixture(), 'tasks', [], 80).map(textOfRow)[0], /^Checklist +none$/u)
})

test('the permissions panel: the preset as a filled label and the requests as a table with their time', () => {
  const session = fixture().sessionId
  const state = fixture({ projections: { ...fixture().projections, permissions: { currentValue: 'smart' } },
    permissionAudit: [{ id: 'a', owner: 'agent-2', toolName: 'bash', time: 1e12, outcome: 'allowed-once' }, { id: 'b', owner: session, toolName: 'write_file', time: 1e12 + 60_000, outcome: 'rejected' }] })
  const rows = inspectorRows(state, 'permissions', [], 100), all = rows.map(textOfRow)
  assert.equal(all[0], 'Preset    smart    policy ask')
  const preset = rows[0].spans.find(part => part.text === ' smart ')
  assert.deepEqual([preset.tone, preset.inverse, preset.bold], ['accent', true, true])
  const at = all.indexOf('Recent requests   latest 50')
  assert.match(all[at + 1], /^\d\d:\d\d {3}bash {9}allowed once {3}subagent agent-2$/u)
  assert.match(all[at + 2], /^\d\d:\d\d {3}write_file {3}rejected$/u)
  // Outcomes are told by words and weight, not by green and red.
  assert.ok(rows.slice(at + 1, at + 3).every(value => value.spans.every(part => part.tone !== 'success' && part.tone !== 'error')))
  assert.match(inspectorRows(fixture(), 'permissions', [], 100).map(textOfRow).join('\n'), /^Recent requests {3}latest 50 +none$/mu)
})

test('the context panel shows the figures as meters and keeps the explanations after them', () => {
  const all = inspectorRows(fixture(), 'context', [], 100).map(textOfRow)
  assert.match(all[0], /^Authentication & tests {3}\/workspace\/harness · standard · deepseek\/reasoner · effort high$/u)
  assert.equal(all[all.indexOf('Context   latest host projection') + 1], `${'▰'.repeat(8)}${'▱'.repeat(42)}  15%  20k of 131k`)
  const used = all.indexOf('Tokens used   provider accounting, accumulated')
  assert.deepEqual(all.slice(used + 1, used + 5), [`Cache read                   ${'▰'.repeat(16)}  48k`, `Uncached input               ${'▰'.repeat(4)}${'▱'.repeat(12)}  13k`,
    `Output (includes reasoning)  ▰${'▱'.repeat(15)}  2.6k`, `Cache write                  ${'▱'.repeat(16)}  0`])
  assert.ok(all.indexOf('How these numbers are measured') > all.indexOf('Completed steps / turns  6 / 2'))
  // A narrow panel keeps the counts and leaves the meters out.
  assert.ok(inspectorRows(fixture(), 'context', [], 40).map(textOfRow).includes('Cache read                   48k'))
})

test('help opens with a key table in sections, in two columns when wide, before the explanations', () => {
  const wide = inspectorRows(fixture(), 'help', [], 100).map(textOfRow)
  assert.equal(wide[0], 'Write')
  assert.match(wide[1], /^Enter {16}send {25}Ctrl\+R {15}search prompt history$/u)
  assert.ok(wide.includes('While a turn runs') && wide.includes('Read') && wide.includes('Mouse'))
  assert.ok(wide.indexOf('Details') > wide.indexOf('Mouse'))
  assert.ok(wide.every(value => !value.endsWith('…')))
  const narrow = inspectorRows(fixture(), 'help', [], 60).map(textOfRow)
  assert.deepEqual(narrow.slice(0, 3), ['Write', 'Enter                send', 'Alt+Enter · Ctrl+J   new line'])
})

test('a wide terminal sets the session preview beside the session list; a narrower one keeps it under the list', async () => {
  const picker = { kind: 'sessions', title: 'Resume', rows: [{ id: 'a', label: 'Saved', detail: '/repo', command: '/resume a' }, { id: 'b', label: 'Other', detail: '/else', command: '/resume b' }] }
  const wide = setup({ picker }, 121, 30)
  try {
    const all = lines(wide.h)
    assert.match(all[0], /^── Resume ─+ │ ── Session preview ─+$/u)
    assert.ok(all.every(value => value.slice(55, 58) === ' │ '))
    // The row in focus stands on the selection background, its detail row included.
    const focused = wide.h.rows().filter(value => value.spans.some(part => part.background === 'select')).map(textOfRow)
    assert.equal(focused.length, 2); assert.match(focused[0], /^❯ {3}Saved/u); assert.match(focused[1], /^ {4}\/repo/u)
  } finally { wide.h.dispose() }
  const narrow = setup({ picker }, 90, 30)
  try { assert.ok(lines(narrow.h).some(value => /^── Session preview ─+$/u.test(value))); assert.doesNotMatch(narrow.h.text(), / │ /u) } finally { narrow.h.dispose() }
})

test('a terminal with rows to spare separates one-row items, the header, the indicator row and the composer with blank rows', () => {
  const items = conversation().slice(1, 5)
  const tight = createDocumentRenderer().render(items, { width: 100, expanded: false, overrides: {}, terminalRows: 27 }).map(textOfRow)
  const roomy = createDocumentRenderer().render(items, { width: 100, expanded: false, overrides: {}, terminalRows: 28 }).map(textOfRow)
  // Below 28 rows the thought and the calls are a list without blank rows, under the blank row that opens the document.
  assert.deepEqual(tight, ['', '  ✦ Thought · 1 line', '  • Read   src/auth.ts · 1.8s', '  • Edit   src/auth.ts · 1.8s', '    └─ +2 −1',
    '  • Run    pnpm test --filter auth · 1.8s', '    └─ Run authentication tests'])
  // From 28 rows each has a blank row above it, except the first item, which starts under the blank row below the header.
  assert.deepEqual(roomy, ['  ✦ Thought · 1 line', '', '  • Read   src/auth.ts · 1.8s', '', '  • Edit   src/auth.ts · 1.8s', '    └─ +2 −1', '',
    '  • Run    pnpm test --filter auth · 1.8s', '    └─ Run authentication tests'])
  const transcript = fixture().transcript; transcript.items = conversation()
  const tall = setup({ transcript }, 100, 30)
  try {
    const all = lines(tall.h)
    // One blank row follows the header, and the conversation starts right under it.
    assert.match(all[0], /^ DSH /); assert.equal(all[1], ''); assert.equal(all.findIndex(value => value.startsWith('▌ Check authentication')), 2)
    assert.equal(all.findIndex(value => value.includes('• Edit')) - all.findIndex(value => value.includes('• Read')), 2)
    // The composer's top rule has a blank row above it; the status row stays under the bottom rule.
    assert.equal(all.at(-5), ''); assert.match(all.at(-4), /^─+$/u); assert.equal(all.at(-3), '›  Ask anything'); assert.match(all.at(-2), /^─+$/u)
  } finally { tall.h.dispose() }
  const short = setup({ transcript }, 100, 24)
  try {
    const all = lines(short.h)
    assert.equal(all.findIndex(value => value.startsWith('▌ Check authentication')), 2)
    assert.equal(all.findIndex(value => value.includes('• Edit')) - all.findIndex(value => value.includes('• Read')), 1)
  } finally { short.h.dispose() }
})
