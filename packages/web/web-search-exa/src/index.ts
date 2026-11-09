/**
 * Exa-backed `WebSearchProvider` plugin. It contributes the `exa` search provider to the
 * `ctx.web` registry without owning the service. Each search resolves its API key from a
 * literal `apiKey`, otherwise from the `apiKeyEnv` reference through `ctx.credentials` when that
 * service is mounted, otherwise from the launch environment.
 *
 * @module @deepseek-ai/dsh-web-search-exa
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-web'
import {
  ExaSearchProvider,
  EXA_DEFAULT_API_KEY_ENV,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_DEFAULT_TIMEOUT_MS,
} from './provider.ts'
import type { ExaApiKeySource } from './provider.ts'
import type { ExaSearchType } from './types.ts'

export {
  EXA_DEFAULT_API_KEY_ENV,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_DEFAULT_TIMEOUT_MS,
  EXA_PROVIDER_ID,
  EXA_SEARCH_TIMEOUT,
  ExaSearchProvider,
} from './provider.ts'
export type { ExaApiKeySource, ExaSearchProviderOptions } from './provider.ts'
export type { ExaSearchType } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config; the schema supplies every default except the optional `apiKey` and `numResults`. */
export interface Config {
  /** Literal Exa API key; prefer {@link apiKeyEnv} so no secret enters configuration files. Wins over `apiKeyEnv` when non-empty. */
  apiKey?: string
  /** Credential reference resolved for each search. Defaults to `EXA_API_KEY`. */
  apiKeyEnv?: string
  /** Absolute `http:`/`https:` endpoint base; `/search` is appended. Defaults to `https://api.exa.ai`. */
  baseURL?: string
  /** Retrieval mode sent as Exa's `type`. Defaults to `auto`. */
  searchType?: ExaSearchType
  /** Result count sent when a request carries no `maxResults`. Omitted = Exa's default. */
  numResults?: number
  /** Highlight sentences requested per result. Defaults to 1. */
  highlightsPerResult?: number
  /** Bound in milliseconds on one search, including credential resolution. Defaults to 30000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(EXA_DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(EXA_DEFAULT_BASE_URL),
  searchType: z.union(['auto', 'keyword', 'neural'] as const).default(EXA_DEFAULT_SEARCH_TYPE),
  numResults: z.number().step(1).min(1),
  highlightsPerResult: z.number().step(1).min(1).default(EXA_DEFAULT_HIGHLIGHTS_PER_RESULT),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(EXA_DEFAULT_TIMEOUT_MS),
})

/** Config after the schema applies its defaults. */
type ResolvedConfig = Config & Required<Pick<Config, 'apiKeyEnv' | 'baseURL' | 'searchType' | 'highlightsPerResult' | 'timeoutMs'>>

/**
 * Build the per-search key source. An installed credentials service is authoritative,
 * including absence; only deployments without it read the launch environment.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param literal - the configured literal key, if any.
 * @param ref - the validated credential reference.
 * @returns the key source the provider consults on each search and readiness check.
 */
function apiKeySource(ctx: Context, literal: string | undefined, ref: CredentialRef): ExaApiKeySource {
  const literalKey = literal !== undefined && literal.length > 0 ? literal : undefined
  return {
    ref,
    resolve: async () => {
      if (literalKey !== undefined) return literalKey
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(ref))?.value
      return launchEnvironmentOf(ctx).get(ref)?.value
    },
    configured: async () => {
      if (literalKey !== undefined) return true
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.describe(ref)).configured
      return (launchEnvironmentOf(ctx).get(ref)?.value.length ?? 0) > 0
    },
  }
}

/**
 * Register the Exa search provider with `ctx.web`. An invalid `apiKeyEnv` or `baseURL` fails
 * the plugin load.
 */
export function apply(ctx: Context, config: Config): void {
  // The Config schema has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  ctx.web.registerSearchProvider(new ExaSearchProvider({
    apiKey: apiKeySource(ctx, resolved.apiKey, credentialRef(resolved.apiKeyEnv)),
    baseURL: resolved.baseURL,
    searchType: resolved.searchType,
    highlightsPerResult: resolved.highlightsPerResult,
    timeoutMs: resolved.timeoutMs,
    ...resolved.numResults === undefined ? {} : { numResults: resolved.numResults },
  }))
}
