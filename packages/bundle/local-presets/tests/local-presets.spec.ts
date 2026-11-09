/** The local-first standard preset against the Web app's shipped standard preset. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const bundles = fileURLToPath(new URL('../..', import.meta.url))
const load = (path: string) => yaml.load(readFileSync(resolve(bundles, path), 'utf8'), { schema: entryListSchema }) as PatchOptions[]

interface Preset { id: string; plugins: EntryOptions[] }

const local = load('local-presets/cordis.patch.yml')
const localPreset = local.find(patch => patch.id === 'preset-standard')?.config as Preset
const shippedPreset = load('web-app/presets/standard.patch.yml')
  .flatMap(patch => patch.insert ?? [])
  .find(entry => entry.id === 'preset-standard')?.config as Preset
const group = (preset: Preset, id: string) => preset.plugins.find(entry => entry.id === id)?.config as EntryOptions[]

describe('dsh-local-presets bundle', () => {
  it('keeps every standard preset row outside the compaction group', () => {
    const rest = (preset: Preset) => ({ ...preset, plugins: preset.plugins.filter(entry => entry.id !== 'compaction') })
    expect(rest(localPreset)).toEqual(rest(shippedPreset))
    expect(group(localPreset, 'compaction').map(entry => entry.id))
      .toEqual(['laya-pruner', ...group(shippedPreset, 'compaction').map(entry => entry.id)])
  })

  it('runs Laya and the summary twins inside the preset and keeps only the projection on the host', () => {
    const compaction = group(localPreset, 'compaction')
    expect(compaction.find(entry => entry.id === 'tool-result-pruner')?.disabled).toBe(true)
    expect(compaction.find(entry => entry.id === 'laya-pruner')?.config).toMatchObject({ thresholdRatio: 0.8, headroomTokens: 0 })
    expect(local.find(patch => patch.id === 'laya-pruner')?.config).toEqual({ mode: 'projection' })
    const host = load('local-base/cordis.patch.yml')
    expect(compaction.find(entry => entry.id === 'compaction-basic')?.config)
      .toEqual(host.find(patch => patch.id === 'compaction-basic')?.config)
    const hostLaya = host.flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'laya-pruner')!
    const presetLaya = compaction.find(entry => entry.id === 'laya-pruner')!
    // The host row selects pass or projection from DSH_LAYA; the per-Session preset row is mounted only for a pass.
    expect(presetLaya.disabled).toEqual({ __jsExpr: "!['resident', 'managed'].includes(process.env.DSH_LAYA ?? '')" })
    const { mode: _mode, ...hostPass } = hostLaya.config as Record<string, unknown>
    expect(presetLaya.config).toEqual({ ...hostPass, headroomTokens: 0 })
  })
})
