/** Keyless import smoke through the production TUI profile and Loader. */
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
describe('prechat production composition', () => {
  it('replays imported roles into the next request and isolates a changed model', async () => {
    const { stdout } = await runLoaderSmoke({
      label: 'prechat tui smoke', tempDirPrefix: 'dsh-prechat-', binScript: fixture('driver.ts'), libBinScript: fixture('driver.ts'),
      configPath: fixture('prechat.patch.yml'), tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    })
    expect(stdout.split('\n').filter(line => line.startsWith('PRECHAT_'))).toMatchInlineSnapshot(`
      [
        "PRECHAT_REQUEST [{"role":"user","content":[{"type":"text","text":"Explain indexes."}]},{"role":"assistant","content":[{"type":"text","text":"Indexes speed up lookups."}]}]",
        "PRECHAT_SMOKE {"imported":2,"originalUntouched":true,"separateModelChat":true}",
      ]
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
