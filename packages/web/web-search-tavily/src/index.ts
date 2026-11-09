/**
 * Tavily-backed `WebSearchProvider` plugin. It contributes the `tavily` search provider to the
 * `ctx.web` registry without owning the service. Each search resolves its API key from a
 * literal `apiKey`, otherwise from the `apiKeyEnv` reference through `ctx.credentials` when that
 * service is mounted, otherwise from the launch environment.
 *
 * @module @deepseek-ai/dsh-web-search-tavily
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-web'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_API_KEY_ENV,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_DEFAULT_TIMEOUT_MS,
  TAVILY_MAX_RESULTS_LIMIT,
} from './provider.ts'
import type { TavilyApiKeySource } from './provider.ts'
import type { TavilySearchDepth } from './types.ts'

export {
  TAVILY_DEFAULT_API_KEY_ENV,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_DEFAULT_TIMEOUT_MS,
  TAVILY_MAX_RESULTS_LIMIT,
  TAVILY_PROVIDER_ID,
  TAVILY_SEARCH_TIMEOUT,
  TavilySearchProvider,
} from './provider.ts'
export type { TavilyApiKeySource, TavilySearchProviderOptions } from './provider.ts'
export type { TavilySearchDepth } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config; the schema supplies every default except the optional `apiKey` and `numResults`. */
export interface Config {
  /** Literal Tavily API key; prefer {@link apiKeyEnv} so no secret enters configuration files. Wins over `apiKeyEnv` when non-empty. */
  apiKey?: string
  /** Credential reference resolved for each search. Defaults to `TAVILY_API_KEY`. */
  apiKeyEnv?: string
  /** Absolute `http:`/`https:` endpoint base; `/search` is appended. Defaults to `https://api.tavily.com`. */
  baseURL?: string
  /** Search depth sent as Tavily's `search_depth`. Defaults to `basic`. */
  searchDepth?: TavilySearchDepth
  /** Result count from 1 to 20 sent when a request carries no `maxResults`. Omitted = Tavily's default. */
  numResults?: number
  /** Bound in milliseconds on one search, including credential resolution. Defaults to 30000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(TAVILY_DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(TAVILY_DEFAULT_BASE_URL),
  searchDepth: z.union(['basic', 'advanced'] as const).default(TAVILY_DEFAULT_SEARCH_DEPTH),
  numResults: z.number().step(1).min(1).max(TAVILY_MAX_RESULTS_LIMIT),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(TAVILY_DEFAULT_TIMEOUT_MS),
})

/** Config after the schema applies its defaults. */
type ResolvedConfig = Config & Required<Pick<Config, 'apiKeyEnv' | 'baseURL' | 'searchDepth' | 'timeoutMs'>>

/**
 * Build the per-search key source. An installed credentials service is authoritative,
 * including absence; only deployments without it read the launch environment.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param ref - the validated credential reference.
 * @param literal - the configured literal key, if any.
 * @returns the key source the provider consults on each search and readiness check.
 */
function tavilyKeySource(ctx: Context, ref: CredentialRef, literal: string | undefined): TavilyApiKeySource {
  const fixed = literal === undefined || literal.length === 0 ? undefined : literal
  const credentials = () => ctx.get('credentials')
  return {
    ref,
    async resolve() {
      if (fixed !== undefined) return fixed
      const store = credentials()
      return store === undefined ? launchEnvironmentOf(ctx).get(ref)?.value : (await store.resolve(ref))?.value
    },
    async configured() {
      if (fixed !== undefined) return true
      const store = credentials()
      return store === undefined ? (launchEnvironmentOf(ctx).get(ref)?.value ?? '') !== '' : (await store.describe(ref)).configured
    },
  }
}

/**
 * Register the Tavily search provider with `ctx.web`. An invalid `apiKeyEnv` or `baseURL` fails
 * the plugin load.
 */
export function apply(ctx: Context, config: Config): void {
  // The Config schema has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  ctx.web.registerSearchProvider(new TavilySearchProvider({
    apiKey: tavilyKeySource(ctx, credentialRef(resolved.apiKeyEnv), resolved.apiKey),
    baseURL: resolved.baseURL,
    searchDepth: resolved.searchDepth,
    timeoutMs: resolved.timeoutMs,
    ...resolved.numResults === undefined ? {} : { numResults: resolved.numResults },
  }))
}
