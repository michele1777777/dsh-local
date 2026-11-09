/** The Web additions of the local-first distribution. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('dsh-local-web bundle', () => {
  it('inserts the Laya and prechat panels and the Smart preset from its own dependencies', () => {
    const patches = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as PatchOptions[]
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const rows = patches.flatMap(patch => patch.insert ?? [])
    expect(patches.every(patch => patch.id === undefined)).toBe(true)
    expect(rows.map(entry => entry.id)).toEqual(['ui-laya-pruner', 'ui-prechat', 'smart-approval'])
    expect(rows.map(entry => entry.name).sort()).toEqual(Object.keys(manifest.dependencies).sort())
    expect(rows.find(entry => entry.id === 'smart-approval')?.config).toMatchObject({ humanOnlyTools: ['run_code'] })
  })
})
