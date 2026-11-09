import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
test('TUI disables exactly the same global agent plane as Web and enables presets', () => {
  const tui = source('../cordis.patch.yml'), web = source('../../web-app/cordis.patch.yml')
  const disabled = text => [...text.matchAll(/^- id: ([^\n]+)\n  disabled: true/gm)].map(match => match[1]).sort()
  assert.deepEqual(disabled(tui), disabled(web.slice(web.indexOf('- id: tool-bash'))))
  assert.match(tui, /name: '@deepseek-ai\/dsh-api-session-controller'/)
  assert.match(tui, /name: '@deepseek-ai\/dsh-api-job-controller'/)
  assert.match(tui, /name: '@deepseek-ai\/dsh-agent-preset-registry'[\s\S]*default: standard/)
  assert.doesNotMatch(tui, /name: '@deepseek-ai\/dsh-host-webserver'/)
})
test('terminal runner does not duplicate model request construction or compaction', () => {
  const runner = source('../src/index.ts'), backend = source('../src/backend.ts')
  assert.doesNotMatch(runner, /createUserMessage|installModelSelection|\.followup\(|\.llm\.stream\(/)
  assert.match(backend, /this\.api\.prompt\(promptRequest/)
  assert.match(runner, /registry\.execute\(current, line, attachments, operation.signal\)/)
  assert.doesNotMatch(runner, /case 'compact':/)
})
test('bracketed paste has its own channel and async failures reach the UI', () => {
  const app = source('../src/app.tsx')
  assert.match(app, /usePaste\(\(?(?:raw)?[tT]ext(?:: string)?\)? =>/)
  assert.match(app, /\.catch\(controller.report\)/)
  assert.match(app, /renderer\.render\(/)
})

test('TUI mounts the exact Web sessionStats projection unit and has no reasoning display toggle', () => {
  const tui = source('../cordis.patch.yml'), web = source('../../web-app/cordis.patch.yml')
  for (const text of [tui, web]) assert.match(text, /id: session-stats\n\s+name: '@deepseek-ai\/dsh-session-stats'/)
  const app = source('../src/app.tsx'), commands = source('../src/commands.ts'), startup = source('../src/startup.ts')
  assert.doesNotMatch(commands, /name: 'reasoning'/)
  assert.doesNotMatch(startup, /\.option\('--no-reasoning'/)
  assert.doesNotMatch(app, /dispatch\('\/reasoning'\)/)
  assert.match(source('../src/index.ts'), /alternateScreen: true/)
})
