/** These are isolated lifecycle/policy tests, not a provider or Web end-to-end suite. */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const directory = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).map(name => directory + name)
const result = spawnSync(process.execPath, ['--import', new URL('./register.mjs', import.meta.url).href, '--test', ...files], { stdio: 'inherit', env: process.env })
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
