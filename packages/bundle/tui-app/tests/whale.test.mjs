/** Pre-rendered whale scenes: asset validation, size selection, frame timing and the screens that show them. */
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
const { itemRows } = await import('../src/document.ts')
const { textOfRow, widthOf } = await import('../src/rich-text.ts')
const { WHALE_ASSETS, WHALE_VARIANTS, WhaleAnimations, WhaleAssetError, fitVariant, parseWhaleAnimation } = await import('../src/whale.ts')
const { ANIMATION_TICK_MS, frameIndex } = await import('../src/animation.ts')
const { fixture } = await import('./fixtures.mjs')

const whales = new WhaleAnimations(WHALE_ASSETS, error => { throw error })
const variant = file => WHALE_VARIANTS.find(value => value.file === file)
const SCENE_GLYPH = /[▀-▟]/u
const controller = { async submit() {}, async runCommand() {}, cancel() {}, exit() {}, commands: () => [], answerApproval() {}, answerQuestion() {}, hint() {}, closePicker() {}, report(error) { throw error } }
const user = { kind: 'user', id: 'user-1', text: 'Plan the change.', settled: true, queued: false }
const live = () => ({ kind: 'assistant', id: 'live', reasoning: 'Looking at the code.', text: '', settled: false, reasoningStartedAt: Date.now() })
const welcome = (columns, rows, overrides = {}, owner = whales) =>
  createHarness(App, createStore(fixture({ motion: false, ...overrides })), controller, columns, rows, undefined, owner)
const thinking = (columns, rows, overrides = {}) => welcome(columns, rows, { status: 'running', transcript: { ...emptyTranscript(), items: [user, live()] }, ...overrides })

/** The variant whose first frame appears on screen as one aligned block, or undefined. */
function shownVariant(lines) {
  for (const candidate of WHALE_VARIANTS) {
    const scene = whales.animation(candidate).frames[0].map(textOfRow)
    const anchor = scene.findIndex(line => line.trim() !== '')
    for (let y = 0; y + scene.length <= lines.length; y++) {
      const x = lines[y + anchor].indexOf(scene[anchor])
      if (x >= 0 && scene.every((line, index) => lines[y + index].slice(x, x + candidate.columns) === line)) return candidate.file
    }
  }
  return undefined
}
const screenLines = h => h.rows().map(textOfRow)

test('every packaged whale asset loads with the dimensions its variant declares', () => {
  const reports = [], owner = new WhaleAnimations(WHALE_ASSETS, error => { reports.push(error) })
  assert.deepEqual(WHALE_VARIANTS.map(value => [value.file, value.columns, value.rows]),
    [['k228.json.gz', 228, 21], ['l120.json.gz', 116, 12], ['l100.json.gz', 96, 12], ['l80.json.gz', 76, 10], ['l60.json.gz', 56, 8]])
  for (const value of WHALE_VARIANTS) {
    const animation = owner.animation(value)
    assert.ok(animation !== undefined, value.file)
    assert.equal(animation.variant, value)
    assert.equal(animation.fps, 50); assert.equal(animation.durationMs, 16000); assert.equal(animation.frames.length, 800)
    for (const frame of animation.frames) {
      assert.equal(frame.length, value.rows)
      for (const line of frame) assert.equal(widthOf(textOfRow(line)), value.columns)
    }
  }
  assert.deepEqual(reports, [])
})

/** A fresh, valid copy of the 60-column asset as parsed JSON. */
function validL60() {
  const animation = whales.animation(variant('l60.json.gz'))
  return { columns: 56, rows: 8, fps: 50, durationMs: 16000, rendering: 'solid-body-braille-water',
    frames: animation.frames.map(frame => frame.map(line => ({ spans: line.spans.map(part => ({ text: part.text, tone: part.tone })) }))) }
}
test('a malformed whale asset is rejected with the file and the problem', () => {
  const l60 = variant('l60.json.gz')
  assert.equal(parseWhaleAnimation(validL60(), l60).frames.length, 800)
  const rejects = (mutate, problem) => {
    const value = validL60(), result = mutate(value), bad = result === undefined ? value : result
    assert.throws(() => parseWhaleAnimation(bad, l60), error => error instanceof WhaleAssetError && error.file === 'l60.json.gz' && problem.test(error.message), String(problem))
  }
  rejects(() => null, /not a JSON object/)
  rejects(() => [], /not a JSON object/)
  rejects(value => { value.columns = 57 }, /declares 57×8 cells instead of 56×8/)
  rejects(value => { value.rows = 9 }, /declares 56×9 cells/)
  rejects(value => { value.fps = 0 }, /positive integers/)
  rejects(value => { value.frames.pop() }, /must hold 800 frames/)
  rejects(value => { value.frames[7].pop() }, /frame 7 does not have 8 rows/)
  rejects(value => { value.frames[3][2] = { text: 'x' } }, /frame 3 row 2 has no spans/)
  rejects(value => { value.frames[3][2].spans.push({ text: '█', tone: 'brand' }) }, /frame 3 row 2 is 57 cells wide instead of 56/)
  rejects(value => { value.frames[3][2].spans[0].text = value.frames[3][2].spans[0].text.slice(1) }, /frame 3 row 2 is 55 cells wide/)
  rejects(value => { value.frames[5][0].spans[0].tone = 'purple' }, /frame 5 row 0 has an unknown tone "purple"/)
  rejects(value => { value.frames[5][0].spans[0].text = '\x1b[31m' + value.frames[5][0].spans[0].text.slice(5) }, /frame 5 row 0 has a span outside the scene glyphs/)
  rejects(value => { value.frames[5][0].spans[0].text = '東京' + value.frames[5][0].spans[0].text.slice(2) }, /outside the scene glyphs/)
})

test('an unusable asset file is reported once and degrades to no scene, without a smaller fallback or a crash', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-whale-'))
  try {
    writeFileSync(join(directory, 'l60.json.gz'), 'not gzip')
    writeFileSync(join(directory, 'l80.json.gz'), gzipSync(JSON.stringify({ columns: 76, rows: 10 })))
    const reports = [], owner = new WhaleAnimations(pathToFileURL(directory + '/'), error => { reports.push(error) })
    assert.equal(owner.scene({ columns: 56, rows: 8 }, 60, 0), undefined)
    assert.equal(owner.scene({ columns: 56, rows: 8 }, 60, 500), undefined)
    assert.equal(reports.length, 1)
    assert.ok(reports[0] instanceof WhaleAssetError && reports[0].file === 'l60.json.gz' && reports[0].cause !== undefined)
    assert.match(reports[0].message, /Whale animation l60\.json\.gz is unusable: it cannot be read as gzip JSON\. The TUI shows no animation in its place; reinstall @deepseek-ai\/dsh-tui-app to restore it\./)
    assert.equal(owner.scene({ columns: 76, rows: 10 }, 80, 0), undefined)
    assert.equal(reports.length, 2)
    assert.match(reports[1].message, /l80\.json\.gz is unusable: fps and durationMs must be positive integers/)
    // A missing file is unusable too; the welcome screen still renders its text.
    const fresh = [], missing = new WhaleAnimations(pathToFileURL(directory + '/'), error => { fresh.push(error) })
    const h = welcome(120, 40, {}, missing)
    try {
      assert.match(h.text(), /What are we building\?/)
      assert.doesNotMatch(h.text(), SCENE_GLYPH)
      assert.deepEqual(fresh.map(error => error.file), ['l120.json.gz'])
      assert.match(fresh[0].message, /cannot be read/)
    } finally { h.dispose() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('variant selection follows the scene sizes and the room left on screen', () => {
  assert.equal(fitVariant({ columns: 55, rows: 100 }), undefined)
  assert.equal(fitVariant({ columns: 56, rows: 8 })?.file, 'l60.json.gz')
  assert.equal(fitVariant({ columns: 56, rows: 7 }), undefined)
  assert.equal(fitVariant({ columns: 228, rows: 21 })?.file, 'k228.json.gz')
  assert.equal(fitVariant({ columns: 228, rows: 20 })?.file, 'l120.json.gz')
  assert.equal(fitVariant({ columns: 227, rows: 40 })?.file, 'l120.json.gz')
  assert.equal(fitVariant({ columns: 500, rows: 11 })?.file, 'l80.json.gz')
})

// Each variant needs a terminal four columns wider than its scene. Height: the Thinking box keeps twelve rows for its edges
// and the rest of the screen; the welcome screen keeps a blank row and its seven rows of text inside the conversation area.
const WIDTHS = [[59, undefined], [60, 'l60'], [79, 'l60'], [80, 'l80'], [99, 'l80'], [100, 'l100'], [119, 'l100'], [120, 'l120'], [231, 'l120'], [232, 'k228']]
const name = file => file?.replace('.json.gz', '')
for (const [columns, expected] of WIDTHS) test(`at ${columns}×40 the Thinking box and the welcome screen both show ${expected ?? 'no scene'}`, () => {
  for (const h of [thinking(columns, 40), welcome(columns, 40)]) {
    try { assert.equal(name(shownVariant(screenLines(h))), expected, h.text()) } finally { h.dispose() }
  }
})
for (const [columns, rows, expected] of [[232, 33, 'k228'], [232, 32, 'l120'], [232, 24, 'l120'], [232, 23, 'l80'], [120, 23, 'l80'], [80, 21, 'l60'], [60, 20, 'l60'], [60, 19, undefined]]) {
  test(`a ${columns}×${rows} Thinking box shows ${expected ?? 'no scene'}`, () => {
    const h = thinking(columns, rows)
    try { assert.equal(name(shownVariant(screenLines(h))), expected, h.text()); assert.match(h.text(), /Thinking…/) } finally { h.dispose() }
  })
}
for (const [columns, rows, expected] of [[232, 34, 'k228'], [232, 33, 'l120'], [232, 24, 'l80'], [100, 25, 'l100'], [100, 24, 'l80'], [60, 21, 'l60'], [60, 20, undefined]]) {
  test(`a ${columns}×${rows} welcome screen shows ${expected ?? 'no scene'} above its text`, () => {
    const h = welcome(columns, rows)
    try {
      assert.equal(name(shownVariant(screenLines(h))), expected, h.text())
      assert.match(h.text(), /What are we building\?[\s\S]*Your conversation stays in the shared session log\./)
    } finally { h.dispose() }
  })
}

test('no scene is drawn below 60 columns, however tall the terminal', () => {
  for (const columns of [30, 40, 56, 58, 59]) for (const make of [thinking, welcome]) {
    const h = make(columns, 80)
    try { assert.doesNotMatch(h.text(), SCENE_GLYPH, `${columns} columns`) } finally { h.dispose() }
  }
})

test('the frame index follows animation time, wraps every cycle and is deterministic', () => {
  const l60 = whales.animation(variant('l60.json.gz'))
  assert.equal(ANIMATION_TICK_MS, 100)
  assert.deepEqual([0, 19, 20, 100, 15980, 16000, 16100, 32000 + 40].map(ms => frameIndex(l60, ms)), [0, 0, 1, 5, 799, 0, 5, 2])
  assert.deepEqual(Array.from({ length: 321 }, (_, tick) => frameIndex(l60, tick * ANIMATION_TICK_MS)).filter(index => index === 0).length, 3)
  const space = { columns: 56, rows: 8 }
  assert.deepEqual(whales.scene(space, 60, 1234), whales.scene(space, 60, 1234))
  assert.deepEqual(whales.scene(space, 60, 0), whales.scene(space, 60, 16000))
  assert.notDeepEqual(whales.scene(space, 60, 0), whales.scene(space, 60, ANIMATION_TICK_MS))
  // Centred: the odd spare column goes to the right.
  const rows = whales.scene(space, 61, 0)
  assert.ok(rows.every(line => widthOf(textOfRow(line)) === 61 && textOfRow(line).startsWith('  ') && textOfRow(line).endsWith('   ')))
  assert.deepEqual(rows.map(line => textOfRow(line).slice(2, 58)), l60.frames[0].map(textOfRow))
})

test('Thinking box and welcome rows never overflow the frame', () => {
  for (const columns of [30, 59, 60, 61, 63, 64, 79, 80, 81, 99, 100, 119, 120, 121, 200, 231, 232, 233, 260]) {
    for (const rows of [20, 24, 40]) for (const make of [thinking, welcome]) {
      const h = make(columns, rows)
      try { for (const line of screenLines(h)) assert.ok(widthOf(line) <= columns - 1, `${columns}×${rows}: ${widthOf(line)} cells: ${line}`) } finally { h.dispose() }
    }
  }
  // The box bounds a scene even when the offered space is wider than the box.
  for (const width of [12, 40, 58, 59, 70, 120, 240]) for (const tick of [0, 7, 160]) {
    const rows = itemRows(live(), { width, expanded: false, overrides: {}, tick, now: 0, scene: { whales, space: { columns: 1000, rows: 100 } } })
    for (const line of rows) assert.ok(widthOf(textOfRow(line)) <= width, `${width}: ${textOfRow(line)}`)
  }
})

test('the welcome scene disappears with the first message', async () => {
  const store = createStore(fixture({ motion: false }))
  const h = createHarness(App, store, controller, 120, 40, undefined, whales)
  try {
    assert.equal(shownVariant(screenLines(h)), 'l120.json.gz')
    store.update((state) => { state.transcript = { ...state.transcript, items: [user] } })
    await h.flush()
    assert.doesNotMatch(h.text(), SCENE_GLYPH)
    assert.doesNotMatch(h.text(), /What are we building\?/)
    assert.match(h.text(), /Plan the change\./)
  } finally { h.dispose() }
})

test('the Thinking scene animates with the shared tick, holds frame 0 with motion off, and leaves with the settled thought', async () => {
  const sceneRows = h => screenLines(h).slice(1, -4).filter(line => SCENE_GLYPH.test(line) || /[⠀-⣿]/u.test(line)).join('\n')
  const moving = thinking(100, 30, { motion: true })
  try {
    const first = sceneRows(moving)
    await delay(450); await moving.flush()
    assert.notEqual(sceneRows(moving), first)
  } finally { moving.dispose() }
  const store = createStore(fixture({ motion: false, status: 'running', transcript: { ...emptyTranscript(), items: [user, live()] } }))
  const still = createHarness(App, store, controller, 100, 30, undefined, whales)
  try {
    const first = sceneRows(still)
    assert.equal(shownVariant(screenLines(still)), 'l100.json.gz')
    await delay(450); await still.flush()
    assert.equal(sceneRows(still), first)
    store.update((state) => { state.status = 'idle'; state.transcript = { ...state.transcript, items: [user, { ...state.transcript.items[1], reasoningEndedAt: Date.now(), settled: true }] } })
    await still.flush()
    assert.doesNotMatch(still.text(), SCENE_GLYPH)
    assert.match(still.text(), /◦ Thought/)
  } finally { still.dispose() }
})
