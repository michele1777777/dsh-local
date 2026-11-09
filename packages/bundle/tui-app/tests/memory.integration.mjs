/** Build with the shipped renderer policy, then exercise native React/Ink in a fresh process. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'tsdown'
import ts from 'typescript'
import config from '../tsdown.config.ts'

const execute = promisify(execFile)
test('production renderer retains bounded memory across streamed frames', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-render-memory-'))
  try {
    await build({
      ...config, configFile: false, logLevel: 'error',
      entry: [fileURLToPath(new URL('./fixtures/render-memory.mjs', import.meta.url))],
      outDir: directory,
    })
    // NODE_ENV is intentionally absent: installed dsh must not need a shell workaround.
    const env = { ...process.env }
    delete env.NODE_ENV
    const { stdout, stderr } = await execute(process.execPath, ['--expose-gc', join(directory, 'render-memory.js')], {
      env, timeout: 150000, maxBuffer: 1024 * 1024,
    })
    const samples = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    assert.equal(samples.length, 4)
    assert.ok(samples.every(sample => sample.measures === 0), 'React diagnostic entries must not accumulate')
    const heaps = samples.map(sample => sample.heap)
    assert.ok(Math.max(...heaps) - Math.min(...heaps) < 4 * 1024 * 1024, JSON.stringify(samples))
    assert.doesNotMatch(stderr, /MaxPerformanceEntryBufferExceededWarning/)
    console.log(JSON.stringify(samples))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('installed TUI embeds the production renderer and ships every generated chunk', async () => {
  const entry = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(entry, /react-reconciler\.production\.js/)
  assert.doesNotMatch(entry, /react-reconciler\.development\.js|performance\.measure\(/)
  const parsed = ts.createSourceFile('index.js', entry, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) assert.doesNotMatch(statement.moduleSpecifier.text, /^(?:react|ink)(?:\/|$)/)
  }
  for (const [, path] of entry.matchAll(/(?:from\s*|import\()["'](\.\/[^"']+\.js)["']/g)) {
    await readFile(new URL(`../lib/${path}`, import.meta.url))
  }
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.files.includes('lib/*.js'))
})
