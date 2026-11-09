/**
 * Human-facing `/skills` command listing the skills the receiving agent's
 * composition resolves, beside the model-facing catalog `tool-skill` publishes.
 * @module @deepseek-ai/dsh-command-skills
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

export const name = 'command-skills'
export const inject = ['commands', 'skills', 'workingDirectory']

const USAGE = 'Usage: /skills (no arguments)'
const DEFAULT_DESCRIPTION_MAX_LENGTH = 160

/** Human-facing skill list configuration. */
export interface Config {
  /** Maximum normalized description length rendered per skill; minimum 3. */
  descriptionMaxLength?: number
}

/** Validate and default the human-facing skill list configuration. */
export const Config: Schema<Config> = z.object({
  descriptionMaxLength: z.number().default(DEFAULT_DESCRIPTION_MAX_LENGTH),
})

/**
 * Register `/skills` for every composed human-command adapter. The listing is
 * invocation-neutral: it shows what the receiving agent's layered skill
 * registry resolves, including skills a model cannot load.
 * @param ctx - context carrying the command registry, the skill registry, and the working-directory service.
 * @param config - human-facing list configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const descriptionMaxLength = config.descriptionMaxLength ?? DEFAULT_DESCRIPTION_MAX_LENGTH
  assertPositiveInteger('descriptionMaxLength', descriptionMaxLength, 3)
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-skills'),
    name: 'skills',
    description: 'List installed skills',
    handler: (invocation: CommandInvocation): Promise<CommandResult> => executeSkills(ctx, invocation, descriptionMaxLength),
  }))
}

/** Execute one argument-free skill listing against the receiving agent's layers. */
async function executeSkills(
  ctx: Context,
  invocation: CommandInvocation,
  descriptionMaxLength: number,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  const lookup = {
    cwd: await ctx.workingDirectory.ensure(invocation.agent, invocation.signal),
    signal: invocation.signal,
    scope: invocation.agent,
  }
  const skills = await ctx.skills.list(lookup)
  if (skills.length === 0) return { kind: 'success', text: 'No skills are installed for this session.' }
  const lines = skills.map(skill => renderSkillLine(skill, descriptionMaxLength))
  return { kind: 'success', text: `${skills.length} installed skills:\n${lines.join('\n')}` }
}

/** Render one list line: name, truncated description, and discovery source. */
function renderSkillLine(skill: SkillSummary, descriptionMaxLength: number): string {
  return `- ${skill.name} — ${catalogDescription(skill.description, descriptionMaxLength)} [${skill.source}]`
}

/** Collapse whitespace and bound one description to the configured length. */
function catalogDescription(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

/** Validate a configured positive integer before registration. */
function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`)
  }
}
