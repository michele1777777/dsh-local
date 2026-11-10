/** The three braille animations: asset validation, frame timing, the welcome whale, the Thinking mark and the pruning mark. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { register } from 'node:module'
register('./ui-loader.mjs', import.meta.url)
const { App } = await import('../src/app.tsx')
const { createHarness } = await import('./ui-harness.mjs')
const { createStore } = await import('../src/store.ts')
const { emptyTranscript } = await import('../src/transcript.ts')
const { itemRows, layaPassRows } = await import('../src/document.ts')
const { statusRow, welcomeRows } = await import('../src/screen.ts')
const { textOfRow, widthOf } = await import('../src/rich-text.ts')
const { layaPhaseLabel } = await import('../src/metrics.ts')
const {
  ANIMATION_ASSETS, ANIMATION_TICK_MS, PRUNING_SCENE, SceneAnimations, SceneAssetError, THINKING_SCENE, WELCOME_SCENE, WELCOME_STILL_FRAME,
  frameIndex, parseSceneAnimation,
} = await import('../src/animation.ts')
const { fixture } = await import('./fixtures.mjs')

const animations = new SceneAnimations(ANIMATION_ASSETS, error => { throw error })
const SCENES = [WELCOME_SCENE, THINKING_SCENE, PRUNING_SCENE]
const BRAILLE = /[⠁-⣿]/u
const controller = { async submit() {}, async runCommand() {}, cancel() {}, exit() {}, commands: () => [], answerApproval() {}, answerQuestion() {}, hint() {}, closePicker() {}, report(error) { throw error } }
const user = { kind: 'user', id: 'user-1', text: 'Plan the change.', settled: true, queued: false }
const answer = { kind: 'assistant', id: 'answer-1', reasoning: '', text: 'Done.', settled: true }
const live = () => ({ kind: 'assistant', id: 'live', reasoning: 'Looking at the code.', text: '', settled: false, reasoningStartedAt: Date.now() - 12000 })
const harness = (columns, rows, state, owner = animations) => createHarness(App, createStore(fixture(state)), controller, columns, rows, undefined, owner)
const lines = h => h.rows().map(textOfRow)
/** The screen above the status row, whose spinner is a braille glyph too. */
const body = h => lines(h).slice(0, -1).join('\n')
/** Whether two frames of a scene show the same cells; a loop repeats some poses. */
const same = (scene, a, b) => animations.animation(scene).frames[a].map(textOfRow).join('\n') === animations.animation(scene).frames[b].map(textOfRow).join('\n')
const pruning = (phase, overrides = {}) => ({ motion: false, status: 'running', ...overrides,
  transcript: { ...emptyTranscript(), items: [user], layaPruning: true, layaPruneId: 'prune-1', layaPhase: phase } })

/** Where a frame of `scene` appears on screen as one aligned block: its frame index, top row and left column. */
function shown(screen, scene) {
  const animation = animations.animation(scene)
  for (const [index, frame] of animation.frames.entries()) {
    const rows = frame.map(textOfRow), anchor = rows.findIndex(line => line.trim() !== '')
    if (anchor < 0) continue
    const needle = rows[anchor].trim(), lead = rows[anchor].search(/\S/u)
    for (let y = 0; y + rows.length <= screen.length; y++) {
      for (let x = screen[y + anchor].indexOf(needle); x >= 0; x = screen[y + anchor].indexOf(needle, x + 1)) {
        const left = x - lead
        if (left >= 0 && rows.every((line, offset) => screen[y + offset].slice(left, left + scene.columns).padEnd(scene.columns) === line)) return { index, y, x: left }
      }
    }
  }
  return undefined
}

test('the three packaged assets load at 10 fps with their declared sizes, loops and theme tones', () => {
  const reports = [], owner = new SceneAnimations(ANIMATION_ASSETS, error => { reports.push(error) })
  const expected = { 'welcome-whale.json.gz': [60, 15, 6400, ['brand', 'command', 'footer', 'muted', 'text']],
    'thinking-synapse.json.gz': [12, 3, 6400, ['muted', 'reasoning', 'text']],
    'pruning-sieve.json.gz': [10, 3, 4800, ['accent', 'error', 'muted', 'success', 'text']] }
  for (const scene of SCENES) {
    const [columns, rows, durationMs, tones] = expected[scene.file]
    assert.deepEqual([scene.columns, scene.rows], [columns, rows])
    const animation = owner.animation(scene)
    assert.ok(animation !== undefined, scene.file)
    assert.deepEqual([animation.fps, animation.durationMs, animation.frames.length], [10, durationMs, durationMs / 100])
    for (const frame of animation.frames) for (const line of frame) assert.equal(widthOf(textOfRow(line)), columns)
    assert.deepEqual([...new Set(animation.frames.flatMap(frame => frame.flatMap(line => line.spans.map(part => part.tone))))].sort(), tones)
  }
  // The still welcome frame is the formed whale: the densest pose of the loop, not the scattered clouds of frame 0.
  const whale = owner.animation(WELCOME_SCENE), dots = frame => frame.map(textOfRow).join('').replace(/[ ⠀]/gu, '').length
  assert.ok(dots(whale.frames[WELCOME_STILL_FRAME]) > dots(whale.frames[0]) * 1.5)
  assert.deepEqual(reports, [])
})

/** A fresh, valid copy of the Thinking asset as parsed JSON. */
const validThinking = () => ({ columns: 12, rows: 3, fps: 10, durationMs: 6400,
  frames: animations.animation(THINKING_SCENE).frames.map(frame => frame.map(line => ({ spans: line.spans.map(part => ({ ...part })) }))) })
test('a malformed asset is rejected with the file and the problem', () => {
  assert.equal(parseSceneAnimation(validThinking(), THINKING_SCENE).frames.length, 64)
  const rejects = (mutate, problem) => {
    const value = validThinking(), result = mutate(value), bad = result === undefined ? value : result
    assert.throws(() => parseSceneAnimation(bad, THINKING_SCENE), error => error instanceof SceneAssetError && error.file === 'thinking-synapse.json.gz'
      && /^Animation thinking-synapse\.json\.gz is unusable: /.test(error.message) && problem.test(error.message), String(problem))
  }
  rejects(() => null, /not a JSON object/)
  rejects(() => [], /not a JSON object/)
  rejects(value => { value.columns = 13 }, /declares 13×3 cells instead of 12×3/)
  rejects(value => { value.fps = 0 }, /positive integers/)
  rejects(value => { value.frames.pop() }, /must hold 64 frames/)
  rejects(value => { value.frames[7].pop() }, /frame 7 does not have 3 rows/)
  rejects(value => { value.frames[3][2] = { text: 'x' } }, /frame 3 row 2 has no spans/)
  rejects(value => { value.frames[3][2].spans.push({ text: '⠁', tone: 'muted' }) }, /frame 3 row 2 is 13 cells wide instead of 12/)
  rejects(value => { value.frames[5][0].spans[0].tone = 'purple' }, /frame 5 row 0 has an unknown tone "purple"/)
  rejects(value => { value.frames[5][0].spans[0].text = '\x1b[31m' }, /frame 5 row 0 has a span outside the scene glyphs/)
  rejects(value => { value.frames[5][0].spans[0].text = '█'.repeat(value.frames[5][0].spans[0].text.length) }, /outside the scene glyphs/)
})

test('an unusable asset is reported once and leaves its place empty; labels and welcome text stay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-anim-'))
  try {
    writeFileSync(join(directory, 'thinking-synapse.json.gz'), 'not gzip')
    writeFileSync(join(directory, 'pruning-sieve.json.gz'), gzipSync(JSON.stringify({ columns: 10, rows: 3 })))
    const reports = [], owner = new SceneAnimations(pathToFileURL(directory + '/'), error => { reports.push(error) })
    assert.equal(owner.frame(THINKING_SCENE, 0), undefined)
    assert.equal(owner.frame(THINKING_SCENE, 500), undefined)
    assert.equal(reports.length, 1)
    assert.ok(reports[0] instanceof SceneAssetError && reports[0].file === 'thinking-synapse.json.gz' && reports[0].cause !== undefined)
    assert.match(reports[0].message, /^Animation thinking-synapse\.json\.gz is unusable: it cannot be read as gzip JSON\. The TUI shows no animation in its place; reinstall @deepseek-ai\/dsh-tui-app to restore it\.$/)
    assert.equal(owner.still(PRUNING_SCENE, 0), undefined)
    assert.match(reports[1].message, /pruning-sieve\.json\.gz is unusable: fps and durationMs must be positive integers/)
    // A missing file is unusable too.
    for (const state of [{}, { status: 'running', transcript: { ...emptyTranscript(), items: [user, live()] } }, pruning('prune')]) {
      const h = harness(120, 40, state, owner)
      try {
        assert.doesNotMatch(body(h), BRAILLE)
        assert.match(h.text(), /What are we building\?|Thinking… · 12s|laya_context_pruner · pruning context/)
      } finally { h.dispose() }
    }
    assert.deepEqual(reports.map(error => error.file), ['thinking-synapse.json.gz', 'pruning-sieve.json.gz', 'welcome-whale.json.gz'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('the frame index follows animation time in tick steps and wraps every cycle', () => {
  const whale = animations.animation(WELCOME_SCENE)
  assert.equal(ANIMATION_TICK_MS, 100)
  assert.deepEqual([0, 99, 100, 6300, 6400, 6500, 12800 + 40].map(ms => frameIndex(whale, ms)), [0, 0, 1, 63, 0, 1, 0])
  assert.deepEqual(animations.frame(PRUNING_SCENE, 4800), animations.frame(PRUNING_SCENE, 0))
  assert.notDeepEqual(animations.frame(PRUNING_SCENE, ANIMATION_TICK_MS), animations.frame(PRUNING_SCENE, 0))
  assert.equal(animations.still(WELCOME_SCENE, WELCOME_STILL_FRAME + 64), whale.frames[WELCOME_STILL_FRAME])
})

for (const [columns, rows] of [[200, 40], [80, 30], [120, 27], [65, 30]]) test(`at ${columns}×${rows} the welcome whale is centred above the welcome text`, () => {
  const h = harness(columns, rows, { motion: false })
  try {
    const screen = lines(h), found = shown(screen, WELCOME_SCENE)
    assert.ok(found !== undefined && same(WELCOME_SCENE, found.index, WELCOME_STILL_FRAME), h.text())
    // Horizontally: the 60 columns sit in the middle of the frame, one column narrower than the terminal.
    assert.equal(found.x, Math.floor((columns - 1 - 60) / 2))
    // Vertically: the whale, a blank row and the six text rows sit in the middle of the conversation area.
    const title = screen.findIndex(line => line.includes('What are we building?'))
    assert.equal(title, found.y + 16)
    const area = screen.findIndex(line => line.startsWith('───')) - 1
    const above = found.y - 1, below = area - (title + 5)
    assert.ok(Math.abs(above - below) <= 1, `${above} rows above, ${below} below`)
    assert.match(h.text(), /What are we building\?[\s\S]*Your conversation stays in the shared session log\./)
  } finally { h.dispose() }
})

test('without room for the 60 columns plus margins or the rows, the welcome text stands alone', () => {
  for (const [columns, rows] of [[64, 40], [40, 40], [200, 26], [120, 26], [80, 24]]) {
    const h = harness(columns, rows, {})
    try {
      assert.doesNotMatch(body(h), BRAILLE, `${columns}×${rows}`)
      assert.match(h.text(), /What are we building\?[\s\S]*session log\./)
      for (const line of lines(h)) assert.ok(widthOf(line) <= columns - 1)
    } finally { h.dispose() }
  }
  const narrow = welcomeRows(animations.still(WELCOME_SCENE, 0), 30, 20)
  assert.equal(narrow.length, 20)
  assert.ok(narrow.every(line => widthOf(textOfRow(line)) <= 30))
})

test('the welcome whale plays its loop from the first frame and disappears with the first message', async () => {
  const store = createStore(fixture({ motion: true }))
  const h = createHarness(App, store, controller, 120, 40)
  try {
    assert.equal(shown(lines(h), WELCOME_SCENE)?.index, 0)
    await delay(450); await h.flush()
    assert.ok(!same(WELCOME_SCENE, shown(lines(h), WELCOME_SCENE).index, 0))
    store.update((state) => { state.transcript = { ...state.transcript, items: [user] } })
    await h.flush()
    assert.doesNotMatch(body(h), BRAILLE)
    assert.doesNotMatch(h.text(), /What are we building\?/)
  } finally { h.dispose() }
})

test('/clear brings the animated welcome back after the conversation stopped the tick', async () => {
  const store = createStore(fixture({ motion: true, transcript: { ...emptyTranscript(), items: [user, answer] } }))
  const h = createHarness(App, store, controller, 120, 40)
  try {
    assert.doesNotMatch(body(h), BRAILLE)
    // What /clear does: hide the settled items and start a new view; the transcript keeps them.
    store.update((state) => { state.busy = '/clear' }); await h.flush()
    store.update((state) => { state.hiddenBefore = state.transcript.items.length; state.viewEpoch++; state.busy = undefined })
    await h.flush()
    assert.equal(shown(lines(h), WELCOME_SCENE)?.index, 0)
    await delay(450); await h.flush()
    assert.ok(!same(WELCOME_SCENE, shown(lines(h), WELCOME_SCENE).index, 0), 'the whale keeps moving once the command is done')
    assert.match(h.text(), /What are we building\?/)
  } finally { h.dispose() }
})

test('motion off holds the formed whale', async () => {
  const h = harness(120, 40, { motion: false })
  try {
    const first = h.text()
    assert.ok(same(WELCOME_SCENE, shown(lines(h), WELCOME_SCENE).index, WELCOME_STILL_FRAME))
    await delay(350); await h.flush()
    assert.equal(h.text(), first)
  } finally { h.dispose() }
})

test('the Thinking mark follows the live label on its middle row, two cells after it, without a box', () => {
  const rows = itemRows(live(), { width: 100, expanded: false, overrides: {}, tick: 7, now: Date.now(), animations })
  const frame = animations.frame(THINKING_SCENE, 7 * ANIMATION_TICK_MS).map(textOfRow)
  assert.equal(rows.length, 4)
  const label = '  › Thinking… · 12s · 1 line'
  assert.deepEqual(rows.slice(1).map(textOfRow), [' '.repeat(label.length + 2) + frame[0], `${label}  ${frame[1]}`, ' '.repeat(label.length + 2) + frame[2]])
  assert.doesNotMatch(rows.map(textOfRow).join('\n'), /[╭╮╰╯│─⎻⎼]|Show details/u)
  // Every cell of the label and the mark opens the reasoning.
  assert.ok(rows.slice(1).every(line => line.spans.slice(1).every(part => part.action?.kind === 'toggle-reasoning')))
  // Opened while thinking, the reasoning follows the label behind two cells.
  const open = itemRows(live(), { width: 100, expanded: false, overrides: { 'reasoning:live': true }, tick: 7, now: Date.now(), animations })
  assert.match(textOfRow(open[2]), /^ {2}▾ Thinking… · 12s · 1 line {2}/u)
  assert.equal(textOfRow(open[4]), '    Looking at the code.')
  // Too narrow for label and mark on one row: the label wraps alone.
  const narrow = itemRows(live(), { width: 40, expanded: false, overrides: {}, tick: 7, now: Date.now(), animations })
  assert.doesNotMatch(narrow.map(textOfRow).join('\n'), BRAILLE)
  assert.match(narrow.map(textOfRow).join(''), /Thinking… · 12s/)
  // The Waiting for model label carries the same mark.
  const waiting = itemRows({ kind: 'assistant', id: 'wait', reasoning: '', text: '', settled: false }, { width: 100, expanded: false, overrides: {}, tick: 7, animations })
  assert.deepEqual(waiting.slice(1).map(textOfRow), [' '.repeat(22) + frame[0], `  Waiting for model…  ${frame[1]}`, ' '.repeat(22) + frame[2]])
})

test('the Thinking mark animates with the shared tick, holds frame 0 with motion off, and leaves with the settled thought', async () => {
  const thinking = overrides => ({ status: 'running', transcript: { ...emptyTranscript(), items: [user, live()] }, ...overrides })
  const moving = harness(100, 30, thinking({ motion: true }))
  try {
    const first = shown(lines(moving), THINKING_SCENE)
    assert.ok(first !== undefined)
    await delay(450); await moving.flush()
    assert.ok(!same(THINKING_SCENE, shown(lines(moving), THINKING_SCENE).index, first.index))
  } finally { moving.dispose() }
  const store = createStore(fixture(thinking({ motion: false })))
  const still = createHarness(App, store, controller, 100, 30)
  try {
    const first = body(still)
    assert.equal(shown(lines(still), THINKING_SCENE)?.index, 0)
    await delay(350); await still.flush()
    assert.equal(body(still), first)
    store.update((state) => { state.status = 'idle'; state.transcript = { ...state.transcript, items: [user, { ...state.transcript.items[1], reasoningEndedAt: Date.now(), settled: true }] } })
    await still.flush()
    assert.doesNotMatch(body(still), BRAILLE)
    assert.match(still.text(), /◦ Thought {2}1 line/)
  } finally { still.dispose() }
})

test('a Laya pass shows its real phase label with the pruning mark after it; the status row shows the label alone', () => {
  for (const [phase, label] of [['prune', 'laya_context_pruner · pruning context'], [undefined, 'laya_context_pruner · pruning context'],
    ['release', 'DS4 · freeing cache memory'], ['start', 'Starting Laya'], ['stop', 'Stopping Laya'], ['restore', 'DS4 · restoring cache capacity']]) {
    assert.equal(layaPhaseLabel(phase), label)
    const h = harness(100, 30, pruning(phase))
    try {
      const screen = lines(h), found = shown(screen, PRUNING_SCENE)
      assert.equal(found?.index, 0, String(phase))
      assert.equal(screen[found.y + 1], `  ${label}  ${textOfRow(animations.frame(PRUNING_SCENE, 0)[1])}`.trimEnd())
      assert.ok(textOfRow(h.rows().at(-1)).startsWith(`${label} `), textOfRow(h.rows().at(-1)))
      assert.doesNotMatch(h.text(), /▞▚|[╭╮╰╯⎻⎼]/u)
    } finally { h.dispose() }
  }
  const status = statusRow(fixture(pruning('prune')), 100, 3, 0)
  assert.deepEqual(statusRow(fixture(pruning('prune')), 100, 9, 0), status)
  assert.equal(status.spans[0].text, 'laya_context_pruner · pruning context')
})

test('pruning time is local: the mark moves only in the prune phase and restarts at frame 0 after a managed phase', async () => {
  const store = createStore(fixture(pruning('start', { motion: true })))
  const h = createHarness(App, store, controller, 100, 30)
  try {
    await delay(350); await h.flush()
    assert.equal(shown(lines(h), PRUNING_SCENE)?.index, 0, 'a managed phase holds the first frame while the tick runs')
    store.update((state) => { state.transcript = { ...state.transcript, layaPhase: 'prune' } }); await h.flush()
    assert.equal(shown(lines(h), PRUNING_SCENE)?.index, 0)
    await delay(450); await h.flush()
    const later = shown(lines(h), PRUNING_SCENE)?.index
    assert.ok(later !== undefined && !same(PRUNING_SCENE, later, 0) && later <= 7, `frame ${later}`)
    store.update((state) => { state.transcript = { ...state.transcript, layaPhase: 'restore' } }); await h.flush()
    assert.equal(shown(lines(h), PRUNING_SCENE)?.index, 0)
    store.update((state) => { state.transcript = { ...state.transcript, layaPhase: 'prune' } }); await h.flush()
    assert.equal(shown(lines(h), PRUNING_SCENE)?.index, 0)
  } finally { h.dispose() }
})

test('the end of the pass removes the label and mark at once and leaves the result row unchanged', async () => {
  const store = createStore(fixture(pruning('prune', { motion: true })))
  const h = createHarness(App, store, controller, 100, 30)
  try {
    assert.ok(shown(lines(h), PRUNING_SCENE) !== undefined)
    const result = { kind: 'laya', id: 'laya-1', outcome: 'pruned', tokensBefore: 140000, tokensAfter: 98000, ms: 12000, kept: 3, truncated: 1, dropped: 2, settled: true, entries: [] }
    store.update((state) => { state.transcript = { ...state.transcript, layaPruning: false, layaPhase: undefined, layaPruneId: undefined, items: [user, result] } })
    await h.flush()
    assert.doesNotMatch(body(h), BRAILLE)
    assert.doesNotMatch(h.text(), /pruning context/)
    assert.match(h.text(), /▸ ▞▚ laya_context_pruner {2}140k → 98k tokens \(−30%\) {2}3 kept · 1 truncated · 2 dropped · 12s/)
  } finally { h.dispose() }
})

test('live labels and the welcome screen never overflow the frame', () => {
  for (const columns of [20, 30, 40, 59, 60, 64, 65, 80, 120, 200, 260]) for (const rows of [16, 24, 40]) {
    for (const state of [{}, { status: 'running', transcript: { ...emptyTranscript(), items: [user, live()] } }, pruning('prune'), pruning('restore')]) {
      const h = harness(columns, rows, state)
      try {
        for (const line of lines(h)) assert.ok(widthOf(line) <= columns - 1, `${columns}×${rows}: ${line}`)
        assert.doesNotMatch(h.text(), /tokens|→|kept|skipped/)
      } finally { h.dispose() }
    }
  }
  for (const width of [1, 8, 12, 40, 50, 51, 60, 160]) for (const elapsedMs of [0, 300, 4700, 123456]) {
    for (const value of layaPassRows({ phase: 'prune', elapsedMs }, { width, animations })) assert.ok(widthOf(textOfRow(value)) <= width, `${width}: ${textOfRow(value)}`)
    for (const value of itemRows(live(), { width, expanded: false, overrides: {}, tick: elapsedMs / 100, now: Date.now(), animations })) assert.ok(widthOf(textOfRow(value)) <= width)
  }
})
