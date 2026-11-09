/** The Laya mantis: asset validation, size selection, local cutting time, phases, the status mark and the pass's end. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { register } from 'node:module'
register('./ui-loader.mjs', import.meta.url)
const { App } = await import('../src/app.tsx')
const { createHarness } = await import('./ui-harness.mjs')
const { createStore } = await import('../src/store.ts')
const { emptyTranscript } = await import('../src/transcript.ts')
const { layaPassRows } = await import('../src/document.ts')
const { statusRow } = await import('../src/screen.ts')
const { textOfRow, widthOf } = await import('../src/rich-text.ts')
const { ANIMATION_TICK_MS, frameIndex } = await import('../src/animation.ts')
const { WHALE_ASSETS, WhaleAnimations } = await import('../src/whale.ts')
const { LAYA_ASSETS, LAYA_CUT_VARIANTS, LAYA_READY_VARIANTS, LayaAnimations, LayaAssetError, layaCutting, layaMark, parseLayaAnimation } = await import('../src/laya.ts')
const { layaPhaseLabel } = await import('../src/metrics.ts')
const { fixture } = await import('./fixtures.mjs')

const laya = new LayaAnimations(LAYA_ASSETS, error => { throw error })
const whales = new WhaleAnimations(WHALE_ASSETS, error => { throw error })
const VARIANTS = [...LAYA_CUT_VARIANTS, ...LAYA_READY_VARIANTS]
const SCENE_GLYPH = /[▀-▟⠁-⣿]/u
const controller = { async submit() {}, async runCommand() {}, cancel() {}, exit() {}, commands: () => [], answerApproval() {}, answerQuestion() {}, hint() {}, closePicker() {}, report(error) { throw error } }
const user = { kind: 'user', id: 'user-1', text: 'Plan the change.', settled: true, queued: false }
const pruning = (phase, overrides = {}) => fixture({ motion: false, status: 'running', ...overrides,
  transcript: { ...emptyTranscript(), items: [user], layaPruning: true, layaPruneId: 'prune-1', layaPhase: phase } })
const harness = (columns, rows, state, owner = laya) => createHarness(App, createStore(state), controller, columns, rows, undefined, whales, owner)
const screenLines = h => h.rows().map(textOfRow)
const result = { kind: 'laya', id: 'laya-1', outcome: 'pruned', tokensBefore: 140000, tokensAfter: 98000, ms: 12000, kept: 3, truncated: 1, dropped: 2, settled: true, entries: [] }

/** The variant file and frame index whose rows appear on screen as one aligned block, or undefined. */
function shown(lines) {
  for (const variant of VARIANTS) {
    const animation = laya.animation(variant)
    for (const [index, frame] of animation.frames.entries()) {
      const scene = frame.map(textOfRow), anchor = scene.findIndex(line => line.trim() !== '')
      for (let y = 0; y + scene.length <= lines.length; y++) {
        const x = lines[y + anchor].indexOf(scene[anchor])
        if (x >= 0 && scene.every((line, offset) => lines[y + offset].slice(x, x + variant.columns) === line)) return { file: variant.file, index }
      }
    }
  }
  return undefined
}

test('every packaged mantis asset loads with its declared size, theme tones and loop timing', () => {
  const reports = [], owner = new LayaAnimations(LAYA_ASSETS, error => { reports.push(error) })
  assert.deepEqual(VARIANTS.map(value => [value.file, value.columns, value.rows]),
    [['cut76.json.gz', 76, 11], ['cut56.json.gz', 56, 11], ['ready76.json.gz', 76, 11], ['ready56.json.gz', 56, 11]])
  for (const variant of VARIANTS) {
    const animation = owner.animation(variant)
    assert.ok(animation !== undefined, variant.file)
    const loop = variant.file.startsWith('cut')
    assert.deepEqual([animation.fps, animation.durationMs, animation.frames.length], loop ? [10, 4000, 40] : [1, 1000, 1])
    const tones = new Set(animation.frames.flatMap(frame => frame.flatMap(line => line.spans.map(part => part.tone))))
    assert.deepEqual([...tones].filter(tone => !['muted', 'success', 'text', 'accent'].includes(tone)), [], variant.file)
    for (const frame of animation.frames) for (const line of frame) assert.equal(widthOf(textOfRow(line)), variant.columns)
  }
  // One frame per 100 ms tick, and the loop holds five whole 800 ms gestures.
  const cut = owner.animation(LAYA_CUT_VARIANTS[0])
  assert.deepEqual([0, 100, 3900, 4000, 4100].map(ms => frameIndex(cut, ms)), [0, 1, 39, 0, 1])
  assert.equal(new Set(cut.frames.map(frame => frame.map(textOfRow).join('\n'))).size > 30, true)
  assert.deepEqual(reports, [])
})

test('a malformed mantis asset is rejected as a Laya asset with the file and the problem', () => {
  const variant = LAYA_READY_VARIANTS[1]
  const valid = () => ({ columns: 56, rows: 11, fps: 1, durationMs: 1000,
    frames: laya.animation(variant).frames.map(frame => frame.map(line => ({ spans: line.spans.map(part => ({ ...part })) }))) })
  assert.equal(parseLayaAnimation(valid(), variant).frames.length, 1)
  const rejects = (mutate, problem) => {
    const value = valid(); mutate(value)
    assert.throws(() => parseLayaAnimation(value, variant), error => error instanceof LayaAssetError && error.file === 'ready56.json.gz'
      && /^Laya animation ready56\.json\.gz is unusable: /.test(error.message) && problem.test(error.message), String(problem))
  }
  rejects(value => { value.rows = 10 }, /declares 56×10 cells instead of 56×11/)
  rejects(value => { value.frames.push(value.frames[0]) }, /must hold 1 frames/)
  rejects(value => { value.frames[0][4].spans[0].tone = 'green' }, /frame 0 row 4 has an unknown tone "green"/)
  rejects(value => { value.frames[0][4].spans[0].text = '7' + value.frames[0][4].spans[0].text.slice(1) }, /outside the scene glyphs/)
})

test('an unusable mantis asset is reported once; the box keeps its title and the status row its mark', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-laya-'))
  try {
    writeFileSync(join(directory, 'cut76.json.gz'), 'not gzip')
    const reports = [], owner = new LayaAnimations(pathToFileURL(directory + '/'), error => { reports.push(error) })
    const h = harness(100, 30, pruning('prune'), owner)
    try {
      await h.flush()
      assert.equal(shown(screenLines(h)), undefined)
      assert.match(h.text(), /▞▚ laya_context_pruner · pruning context/)
      assert.equal(h.text().split('laya_context_pruner · pruning context').length, 3, 'box title and status label')
      assert.deepEqual(reports.map(error => [error.name, error.file]), [['LayaAssetError', 'cut76.json.gz']])
      assert.match(reports[0].message, /cannot be read as gzip JSON\. The TUI shows no animation in its place/)
    } finally { h.dispose() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

// Each scene needs a terminal four columns wider than itself and twelve rows beyond its eleven for the box edges and the screen.
const SIZES = [[59, 40, undefined], [60, 40, 56], [79, 40, 56], [80, 40, 76], [120, 40, 76], [232, 60, 76],
  [80, 23, 76], [80, 22, undefined], [60, 23, 56], [60, 22, undefined], [200, 22, undefined]]
for (const [columns, rows, expected] of SIZES) for (const phase of ['prune', 'start']) {
  test(`a ${columns}×${rows} ${phase} box shows ${expected === undefined ? 'no scene' : `the ${expected}-column ${phase === 'prune' ? 'loop' : 'still'}`}`, () => {
    const h = harness(columns, rows, pruning(phase))
    try {
      const found = shown(screenLines(h))
      assert.equal(found?.file, expected === undefined ? undefined : `${phase === 'prune' ? 'cut' : 'ready'}${expected}.json.gz`, h.text())
      if (columns >= 60) assert.match(h.text(), new RegExp(`▞▚ ${layaPhaseLabel(phase)}`))
    } finally { h.dispose() }
  })
}

test('managed phases show the ready still under their real labels; only prune and a phaseless pass cut', () => {
  assert.deepEqual(['release', 'start', 'prune', 'stop', 'restore', undefined].map(layaCutting), [false, false, true, false, false, true])
  for (const [phase, label] of [['release', 'DS4 · freeing cache memory'], ['start', 'Starting Laya'], ['stop', 'Stopping Laya'],
    ['restore', 'DS4 · restoring cache capacity'], [undefined, 'laya_context_pruner · pruning context']]) {
    const h = harness(100, 30, pruning(phase))
    try {
      assert.equal(shown(screenLines(h))?.file, phase === undefined ? 'cut76.json.gz' : 'ready76.json.gz', String(phase))
      assert.match(h.text(), new RegExp(`▞▚ ${label}`))
    } finally { h.dispose() }
  }
})

test('cutting time is local: it starts at frame 0 when the prune phase begins and advances with the tick', async () => {
  const store = createStore(pruning('start', { motion: true }))
  const h = createHarness(App, store, controller, 100, 30, undefined, whales, laya)
  try {
    await delay(650); await h.flush()
    assert.equal(shown(screenLines(h))?.file, 'ready76.json.gz', 'a managed phase holds the still while the tick runs')
    store.update((state) => { state.transcript = { ...state.transcript, layaPhase: 'prune' } })
    await h.flush()
    assert.deepEqual(shown(screenLines(h)), { file: 'cut76.json.gz', index: 0 })
    await delay(450); await h.flush()
    const later = shown(screenLines(h))
    assert.equal(later?.file, 'cut76.json.gz')
    assert.ok(later.index >= 2 && later.index <= 7, `frame ${later.index}`)
    // A managed phase in between restarts the cut from frame 0 when pruning resumes.
    store.update((state) => { state.transcript = { ...state.transcript, layaPhase: 'stop' } }); await h.flush()
    assert.equal(shown(screenLines(h))?.file, 'ready76.json.gz')
    store.update((state) => { state.transcript = { ...state.transcript, layaPhase: 'prune' } }); await h.flush()
    assert.deepEqual(shown(screenLines(h)), { file: 'cut76.json.gz', index: 0 })
  } finally { h.dispose() }
})

test('motion off holds the first cutting frame, still edges and an open mark', async () => {
  const h = harness(100, 30, pruning('prune'))
  try {
    const first = h.text()
    assert.deepEqual(shown(screenLines(h)), { file: 'cut76.json.gz', index: 0 })
    assert.doesNotMatch(first, /[⎻⎼]/u)
    await delay(350); await h.flush()
    assert.equal(h.text(), first)
    const status = textOfRow(h.rows().at(-1))
    assert.ok(status.startsWith(`${layaMark(false, 0).map(part => part.text).join('')} laya_context_pruner · pruning context`), status)
  } finally { h.dispose() }
})

test('the end of the pass removes the box at once and leaves the result row unchanged', async () => {
  const store = createStore(pruning('prune', { motion: true }))
  const h = createHarness(App, store, controller, 100, 30, undefined, whales, laya)
  try {
    assert.ok(shown(screenLines(h)) !== undefined)
    store.update((state) => { state.transcript = { ...state.transcript, layaPruning: false, layaPhase: undefined, layaPruneId: undefined, items: [user, result] } })
    await h.flush()
    assert.equal(shown(screenLines(h)), undefined)
    assert.doesNotMatch(h.text(), /pruning context/)
    assert.match(h.text(), /▸ ▞▚ laya_context_pruner {2}140k → 98k tokens \(−30%\) {2}3 kept · 1 truncated · 2 dropped · 12s/)
    assert.equal(h.text().match(/▞▚/gu).length, 1)
  } finally { h.dispose() }
})

test('the status mark is twelve cells, moves with local cutting time and is the only mantis below 60 columns', () => {
  for (const ms of [0, 100, 170, 180, 700, 800, 1234]) {
    const mark = layaMark(true, ms)
    assert.equal(widthOf(textOfRow({ spans: mark })), 12)
    assert.ok(mark.every(part => part.tone === 'success' || part.tone === 'text'))
  }
  const text = ms => layaMark(true, ms).map(part => part.text).join('')
  assert.notEqual(text(100), text(200), 'the blades close at 180 ms')
  assert.equal(text(0), layaMark(false, 0).map(part => part.text).join(''), 'the cut opens on the ready pose')
  assert.equal(text(900), text(100), 'one gesture lasts 800 ms')
  assert.deepEqual(layaMark(false, 300), layaMark(false, 0), 'a ready mantis stays still')
  const state = pruning('prune', { motion: true })
  assert.notDeepEqual(statusRow(state, 100, 0, 0, true, 0), statusRow(state, 100, 0, 0, true, 300))
  assert.deepEqual(statusRow({ ...state, motion: false }, 100, 0, 0, true, 0), statusRow({ ...state, motion: false }, 100, 0, 0, true, 300))
  for (const columns of [30, 45, 59]) {
    const h = harness(columns, 40, pruning('prune'))
    try {
      assert.equal(shown(screenLines(h)), undefined)
      assert.ok(screenLines(h).every(line => !/[▀-▟]/u.test(line.replace('▞▚', ''))), `${columns}: only the title carries block glyphs`)
      assert.match(textOfRow(h.rows().at(-1)), /^[ ⠀-⣿]{12} laya_/u)
    } finally { h.dispose() }
  }
})

test('the live box and the screen never overflow and never show demo text or counts', () => {
  for (const columns of [20, 40, 59, 60, 61, 70, 79, 80, 81, 100, 120, 200, 232]) for (const rows of [16, 23, 30, 40]) {
    for (const phase of ['prune', 'restore']) {
      const h = harness(columns, rows, pruning(phase))
      try {
        for (const line of screenLines(h)) assert.ok(widthOf(line) <= columns - 1, `${columns}×${rows}: ${line}`)
        assert.doesNotMatch(h.text(), /Anteprima|tokens|→|kept|skipped|Ready/)
      } finally { h.dispose() }
    }
  }
  for (const width of [1, 8, 12, 40, 59, 60, 79, 80, 160]) for (const elapsedMs of [0, 300, 3900, 123456]) for (const phase of ['prune', 'stop']) {
    const rows = layaPassRows({ phase, elapsedMs }, { width, tick: 7, scene: { laya, space: { columns: 1000, rows: 100 } } })
    assert.equal(textOfRow(rows[0]), '')
    for (const line of rows) assert.ok(widthOf(textOfRow(line)) <= width, `${width}: ${textOfRow(line)}`)
    // Scene rows carry only scene glyphs; letters and digits appear only in the title.
    const body = rows.slice(2, -1).map(textOfRow).join('\n')
    assert.doesNotMatch(body, /[0-9A-Za-z]/)
  }
})

test('the frame index of a cutting scene follows local time in tick steps', () => {
  const rows = ms => layaPassRows({ phase: 'prune', elapsedMs: ms }, { width: 99, scene: { laya, space: { columns: 96, rows: 30 } } }).map(textOfRow)
  assert.deepEqual(rows(0), rows(4000))
  assert.deepEqual(rows(ANIMATION_TICK_MS * 3), rows(ANIMATION_TICK_MS * 43))
  assert.notDeepEqual(rows(0), rows(ANIMATION_TICK_MS))
  assert.deepEqual(layaPassRows({ phase: 'release', elapsedMs: 0 }, { width: 99, scene: { laya, space: { columns: 96, rows: 30 } } }),
    layaPassRows({ phase: 'release', elapsedMs: 2500 }, { width: 99, scene: { laya, space: { columns: 96, rows: 30 } } }))
})
