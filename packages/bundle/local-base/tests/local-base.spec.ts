/** The local-first host layer composed over dsh-base. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, parseEntryYaml, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

const bundles = fileURLToPath(new URL('../..', import.meta.url))
const load = (path: string) => parseEntryYaml(readFileSync(resolve(bundles, path), 'utf8')) as PatchOptions[]

interface LocalRoute { provider: string; model: string; summary?: string; laya?: boolean; prechat?: boolean }

/** The routes a machine's patch layer would declare on the `local-models` row. */
const routes: LocalRoute[] = [
  { provider: 'a', model: 'a-1', summary: 'a-summary', laya: true },
  { provider: 'b', model: 'b-1', summary: 'b-summary' },
  { provider: 'c', model: 'c-1', laya: true, prechat: true },
]

function compose(localRoutes?: LocalRoute[]): EntryOptions[] {
  const warnings: string[] = []
  const user: PatchOptions[] = localRoutes ? [{ id: 'local-models', config: { routes: localRoutes } }] : []
  const entries = applyEntryPatches([], [...load('base/cordis.patch.yml'), ...load('local-base/cordis.patch.yml'), ...user], (message) => {
    warnings.push(message)
  })
  expect(warnings).toEqual([])
  return entries
}

/**
 * Evaluates a `!!js` value as the loader does, with `env` in place of the process environment and a loader whose
 * tree holds the composed entries (the `local-models` row patched with `localRoutes` when given).
 */
function withEnv(value: unknown, env: Record<string, string>, localRoutes?: LocalRoute[]): unknown {
  const entries = compose(localRoutes).map(options => ({ options }))
  const ctx = { process: { env }, get: (name: string) => name === 'loader' ? { entries: () => entries.values() } : undefined }
  return evaluate(ctx, (value as { __jsExpr: string }).__jsExpr)
}

const row = (entries: EntryOptions[], id: string) => entries.find(entry => entry.id === id)

describe('dsh-local-base bundle', () => {
  it('names no model: routes come from the user layer, listed on a data row that never mounts', () => {
    const entries = compose()
    expect(row(entries, 'llm-pi-ai')?.config).toBeUndefined()
    expect(row(entries, 'local-models')).toMatchObject({ disabled: true, config: { routes: [] } })
    expect(readFileSync(resolve(bundles, 'local-base/cordis.patch.yml'), 'utf8')).not.toMatch(/qwen|deepseek-v4|inkling/u)
  })

  it('summarizes each local route through its twin, other routes on their own model, without size-based pruning', () => {
    const config = row(compose(), 'compaction-basic')?.config as { summarizationProvider?: string; modelPolicies: unknown }
    expect(config.summarizationProvider).toBeUndefined()
    expect(row(compose(), 'tool-result-pruner')?.disabled).toBe(true)
    expect(withEnv(config.modelPolicies, {})).toEqual([])
    expect(withEnv(config.modelPolicies, {}, routes)).toEqual([
      { provider: 'a', model: 'a-1', summarizationProvider: 'a-summary', summarizationModel: 'a-1' },
      { provider: 'b', model: 'b-1', summarizationProvider: 'b-summary', summarizationModel: 'b-1' },
    ])
  })

  it('runs the Laya pass only for a selected mode and sends managed passes of the marked routes to the model server', () => {
    const laya = row(compose(), 'laya-pruner')!
    expect(laya.disabled).toBeUndefined()
    const mode = (laya.config as { mode: unknown }).mode
    expect(withEnv(mode, {})).toBe('projection')
    expect(withEnv(mode, { DSH_LAYA: 'off' })).toBe('projection')
    expect(withEnv(mode, { DSH_LAYA: 'resident' })).toBe('pass')
    expect(withEnv(mode, { DSH_LAYA: 'managed' })).toBe('pass')
    const config = laya.config as { url: unknown; modelEndpoints: unknown }
    expect(withEnv(config.url, {})).toBe('http://127.0.0.1:8766')
    expect(withEnv(config.modelEndpoints, { DSH_LAYA: 'resident' }, routes)).toEqual([])
    expect(withEnv(config.modelEndpoints, { DSH_LAYA: 'managed' })).toEqual([])
    expect(withEnv(config.modelEndpoints, { DSH_LAYA: 'managed', DSH_LOCAL_LLM_URL: 'http://gpu.example:8080/v1' }, routes)).toEqual([
      { provider: 'a', model: 'a-1', url: 'http://gpu.example:8080/v1/laya/compact' },
      { provider: 'c', model: 'c-1', url: 'http://gpu.example:8080/v1/laya/compact' },
    ])
  })

  it('inserts prepared conversations, Laya, and both search providers from its own dependencies', () => {
    const entries = compose()
    const manifest = JSON.parse(readFileSync(resolve(bundles, 'local-base/package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(row(entries, 'auto-review')).toBeUndefined()
    for (const id of ['prechat', 'laya-pruner', 'web-search-exa', 'web-search-tavily']) {
      expect(manifest.dependencies).toHaveProperty(row(entries, id)!.name)
    }
    const prechat = (row(entries, 'prechat')?.config as { routes: unknown }).routes
    expect(withEnv(prechat, {})).toEqual([])
    expect(withEnv(prechat, {}, routes)).toEqual([{ provider: 'c', model: 'c-1' }])
    expect(row(entries, 'web')?.config).toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'http' })
  })
})
