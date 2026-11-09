/** Run from the repository root or the package directory after pnpm install. */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const directory = fileURLToPath(new URL('.', import.meta.url))
const tests = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).map(name => directory + name)
const result = spawnSync(process.execPath, ['--import', new URL('./register.mjs', import.meta.url).href, '--test', ...tests], { stdio: 'inherit', env: process.env })
if (result.error) { console.error(result.error.message); process.exitCode = 1 }
else process.exitCode = result.status ?? 1
