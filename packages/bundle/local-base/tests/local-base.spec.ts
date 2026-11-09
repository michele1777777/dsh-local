/** The local-first host layer composed over dsh-base. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

const bundles = fileURLToPath(new URL('../..', import.meta.url))
const load = (path: string) => yaml.load(readFileSync(resolve(bundles, path), 'utf8'), { schema: entryListSchema }) as PatchOptions[]

interface Route {
  apiKeyEnv: string
  baseURL: string
  baseURLEnv: string
  reasoning: string
  sessionCache: boolean
  models: Array<{ id: string; maxTokens: number; input: string[] }>
}

interface Policy { provider: string; model: string; summarizationProvider: string; summarizationModel: string }

/** Evaluates a `!!js` value with `env` in place of the process environment. */
const withEnv = (value: unknown, env: Record<string, string>): unknown =>
  evaluate({ process: { env } }, (value as { __jsExpr: string }).__jsExpr)

function compose(): EntryOptions[] {
  const warnings: string[] = []
  const entries = applyEntryPatches([], [...load('base/cordis.patch.yml'), ...load('local-base/cordis.patch.yml')], (message) => {
    warnings.push(message)
  })
  expect(warnings).toEqual([])
  return entries
}

const row = (entries: EntryOptions[], id: string) => entries.find(entry => entry.id === id)

describe('dsh-local-base bundle', () => {
  it('pairs every local route with a reasoning-off summary twin on the same server', () => {
    const providers = (row(compose(), 'llm-pi-ai')?.config as { providers: Record<string, Route> }).providers
    const conversations = Object.keys(providers).filter(name => !name.endsWith('-summary'))
    expect(conversations).toEqual(['qwen-flash', 'qwen-27b', 'ds4-v4-flash', 'ds4-v41-flash'])
    for (const name of conversations) {
      const route = providers[name]!
      const summary = providers[`${name}-summary`]!
      expect(summary.reasoning).toBe('off')
      expect(summary.models.map(model => model.id)).toEqual(route.models.map(model => model.id))
      expect(summary.models.every(model => model.maxTokens === 32768 && model.input.join() === 'text')).toBe(true)
      for (const entry of [route, summary]) {
        expect(entry).toMatchObject({
          apiKeyEnv: 'DSH_LOCAL_LLM_API_KEY', baseURL: 'http://127.0.0.1:8080/v1', baseURLEnv: 'DSH_LOCAL_LLM_URL', sessionCache: true,
        })
      }
    }
  })

  it('summarizes each local route through its twin, other routes on their own model, without size-based pruning', () => {
    const config = row(compose(), 'compaction-basic')?.config as { summarizationProvider?: string; modelPolicies: Policy[] }
    expect(config.summarizationProvider).toBeUndefined()
    expect(row(compose(), 'tool-result-pruner')?.disabled).toBe(true)
    expect(config.modelPolicies).toEqual(['qwen-flash', 'qwen-27b', 'ds4-v4-flash', 'ds4-v41-flash'].map((provider, index) => {
      const model = ['qwen3.8-next-flash', 'qwen3.8-27b', 'deepseek-v4-flash', 'deepseek-v4.1-flash'][index]!
      return { provider, model, summarizationProvider: `${provider}-summary`, summarizationModel: model }
    }))
  })

  it('runs the Laya pass only for a selected mode and keeps the rewrite projection mounted otherwise', () => {
    const laya = row(compose(), 'laya-pruner')!
    expect(laya.disabled).toBeUndefined()
    const mode = (laya.config as { mode: unknown }).mode
    expect(withEnv(mode, {})).toBe('projection')
    expect(withEnv(mode, { DSH_LAYA: 'off' })).toBe('projection')
    expect(withEnv(mode, { DSH_LAYA: 'resident' })).toBe('pass')
    expect(withEnv(mode, { DSH_LAYA: 'managed' })).toBe('pass')
    const config = laya.config as { url: unknown; modelEndpoints: unknown }
    expect(withEnv(config.url, {})).toBe('http://127.0.0.1:8766')
    expect(withEnv(config.modelEndpoints, { DSH_LAYA: 'resident' })).toEqual([])
    expect(withEnv(config.modelEndpoints, { DSH_LAYA: 'managed', DSH_LOCAL_LLM_URL: 'http://gpu.example:8080/v1' })).toEqual([
      { provider: 'ds4-v41-flash', model: 'deepseek-v4.1-flash', url: 'http://gpu.example:8080/v1/laya/compact' },
      { provider: 'qwen-flash', model: 'qwen3.8-next-flash', url: 'http://gpu.example:8080/v1/laya/compact' },
      { provider: 'qwen-27b', model: 'qwen3.8-27b', url: 'http://gpu.example:8080/v1/laya/compact' },
    ])
  })

  it('inserts prepared conversations, Laya, and both search providers from its own dependencies', () => {
    const entries = compose()
    const manifest = JSON.parse(readFileSync(resolve(bundles, 'local-base/package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(row(entries, 'auto-review')).toBeUndefined()
    for (const id of ['prechat', 'laya-pruner', 'web-search-exa', 'web-search-tavily']) {
      expect(manifest.dependencies).toHaveProperty(row(entries, id)!.name)
    }
    expect(row(entries, 'prechat')?.config).toEqual({ routes: [{ provider: 'ds4-v41-flash', model: 'deepseek-v4.1-flash' }] })
    expect(row(entries, 'web')?.config).toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'http' })
  })
})
