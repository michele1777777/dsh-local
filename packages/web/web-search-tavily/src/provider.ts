/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily Search API (`POST /search`).
 * It maps each result's extracted `content` to `snippet` and `published_date` to `publishedAt`,
 * and omits `content` from the search result because it never requests Tavily's generated answer.
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */

import { MAX_TIMER_DELAY_MS, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { TavilyResult, TavilySearchDepth, TavilySearchRequest, TavilySearchResponse } from './types.ts'

/** Stable id this provider registers under; the value `searchProvider` selects. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily API base; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Default credential reference holding the Tavily API key. */
export const TAVILY_DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/** Default search depth: one credit per search. */
export const TAVILY_DEFAULT_SEARCH_DEPTH: TavilySearchDepth = 'basic'

/** Default bound on one search, from credential resolution through the response body. */
export const TAVILY_DEFAULT_TIMEOUT_MS = 30_000

/** Largest `max_results` the Tavily Search API accepts; larger requested bounds are capped to it. */
export const TAVILY_MAX_RESULTS_LIMIT = 20

/** Error code of a search that exceeded the provider's own `timeoutMs`. */
export const TAVILY_SEARCH_TIMEOUT = 'WEB_SEARCH_TIMEOUT'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Where one search reads its API key; both operations run per call, so a rotated key applies to the next search. */
export interface TavilyApiKeySource {
  /** Credential reference named in the missing-key error. */
  readonly ref: string
  /**
   * Read the key for one search.
   * @returns the key, or undefined (or empty) when none is configured.
   */
  resolve(): Promise<string | undefined>
  /**
   * Report whether a key is configured without reading or validating its value.
   * @returns whether a search would find a key.
   */
  configured(): Promise<boolean>
}

/** Resolved provider options; the plugin's `apply` supplies every default. */
export interface TavilySearchProviderOptions {
  /** API key source consulted by each search and readiness check. */
  readonly apiKey: TavilyApiKeySource
  /** Absolute `http:` or `https:` endpoint base; `/search` is appended. */
  readonly baseURL: string
  /** Search depth sent as Tavily's `search_depth`. */
  readonly searchDepth: TavilySearchDepth
  /** Result count from 1 to {@link TAVILY_MAX_RESULTS_LIMIT} sent when a request carries no `maxResults`. */
  readonly numResults?: number
  /** Positive bound in milliseconds on one search, at most {@link MAX_TIMER_DELAY_MS}. */
  readonly timeoutMs: number
}

/**
 * Map one Tavily result to a normalized source. A blank `content` yields a URL-only source
 * rather than an invented snippet.
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource {
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.content != null && result.content.trim().length > 0 ? { snippet: result.content } : {},
    ...result.published_date != null && result.published_date.length > 0 ? { publishedAt: result.published_date } : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result. `content` is omitted because
 * the request never asks for Tavily's generated answer; `truncated` is false because the web
 * service owns the final `maxResults` bound.
 *
 * @param response - the validated `POST /search` response body.
 * @returns the normalized result in Tavily's ranking order.
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  return { sources: (response.results ?? []).map(mapTavilyResult), truncated: false }
}

/**
 * Validate an untrusted Tavily success body against {@link TavilySearchResponse}.
 * @param value - the parsed JSON body.
 * @returns the typed response, or undefined when any declared field has another type.
 */
export function parseTavilyResponse(value: unknown): TavilySearchResponse | undefined {
  if (!isJsonObject(value)) return undefined
  const { results } = value
  if (results === undefined) return {}
  if (!Array.isArray(results)) return undefined
  const parsed: TavilyResult[] = []
  for (const entry of results) {
    if (!isJsonObject(entry) || typeof entry.url !== 'string') return undefined
    const { title, content, score, published_date } = entry
    if (![title, content, published_date].every(isNullableString)) return undefined
    if (score !== undefined && score !== null && typeof score !== 'number') return undefined
    parsed.push({
      url: entry.url,
      ...typeof title === 'string' ? { title } : {},
      ...typeof content === 'string' ? { content } : {},
      ...typeof score === 'number' ? { score } : {},
      ...typeof published_date === 'string' ? { published_date } : {},
    })
  }
  return { results: parsed }
}

/**
 * The Tavily-backed search provider. Options are validated at construction, so `available()`
 * is always true; `ready()` reports whether an API key is configured. HTTP redirects fail as
 * `WEB_PROVIDER_ERROR` without contacting the target.
 */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID
  readonly title = 'Tavily'
  /** Picker description: what this provider suits and what it costs. */
  readonly description: NonNullable<WebSearchProvider['description']> = {
    en: 'Searches the web through Tavily and returns titles, URLs, query-relevant page excerpts, and publication dates. Requires a Tavily API key and consumes Tavily API credits.',
    zh: '通过 Tavily 搜索网页，返回标题、URL、与查询相关的页面摘录和发布日期。需要 Tavily API Key，会消耗 Tavily API 额度。',
    ja: 'Tavily でウェブを検索し、タイトル、URL、クエリに関連するページの抜粋、公開日を返します。Tavily API キーが必要で、Tavily API クレジットを消費します。',
    es: 'Busca en la web mediante Tavily y devuelve títulos, URL, extractos de página relevantes para la consulta y fechas de publicación. Requiere una clave de API de Tavily y consume créditos de la API de Tavily.',
    fr: "Recherche sur le Web via Tavily et renvoie titres, URL, extraits de page pertinents pour la requête et dates de publication. Nécessite une clé API Tavily et consomme des crédits d'API Tavily.",
    de: 'Durchsucht das Web über Tavily und liefert Titel, URLs, zur Anfrage passende Seitenauszüge und Veröffentlichungsdaten. Erfordert einen Tavily-API-Schlüssel und verbraucht Tavily-API-Guthaben.',
    ru: 'Ищет в интернете через Tavily и возвращает заголовки, URL, относящиеся к запросу фрагменты страниц и даты публикации. Требуется ключ API Tavily; расходуются кредиты Tavily API.',
    pt: 'Pesquisa na web pelo Tavily e retorna títulos, URLs, trechos de página relevantes para a consulta e datas de publicação. Requer uma chave de API do Tavily e consome créditos da API do Tavily.',
  }

  /**
   * @param options - resolved options.
   * @throws TypeError when `baseURL` is not an absolute `http:`/`https:` URL, `numResults` is
   *   outside `1..TAVILY_MAX_RESULTS_LIMIT`, or `timeoutMs` is outside `1..MAX_TIMER_DELAY_MS`.
   */
  constructor(private readonly options: TavilySearchProviderOptions) {
    const base = URL.parse(options.baseURL)
    if (base === null || (base.protocol !== 'http:' && base.protocol !== 'https:')) {
      throw new TypeError(`web-search-tavily: baseURL "${options.baseURL}" must be an absolute http or https URL`)
    }
    if (options.numResults !== undefined && !isIntegerInRange(options.numResults, TAVILY_MAX_RESULTS_LIMIT)) {
      throw new TypeError(`web-search-tavily: numResults must be an integer from 1 to ${TAVILY_MAX_RESULTS_LIMIT}`)
    }
    if (!isIntegerInRange(options.timeoutMs, MAX_TIMER_DELAY_MS)) {
      throw new TypeError(`web-search-tavily: timeoutMs must be an integer from 1 to ${MAX_TIMER_DELAY_MS}`)
    }
  }

  /** Reports whether an API key is configured; a key source that cannot be read answers false. */
  ready(): Promise<boolean> {
    // A store that cannot be read supplies no key to the search either.
    return this.options.apiKey.configured().catch((_unreadableStore: unknown) => false)
  }

  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted === true) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: signal.reason })
    using bound = deadline(signal, this.options.timeoutMs, TAVILY_SEARCH_TIMEOUT)
    const apiKey = await this.apiKeyFor(bound.signal)
    // A per-request bound wins over the configured default; either may be absent.
    const requested = request.maxResults ?? this.options.numResults
    const body: TavilySearchRequest = {
      query: request.query,
      search_depth: this.options.searchDepth,
      include_answer: false,
      include_raw_content: false,
      ...requested === undefined ? {} : { max_results: Math.min(requested, TAVILY_MAX_RESULTS_LIMIT) },
    }
    const response = await this.post(`${this.options.baseURL.replace(/\/+$/u, '')}/search`, apiKey, body, bound.signal)
    if (!response.ok) throw await this.httpFailure(response, bound.signal)

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      throw this.cancelled(bound.signal, error)
        ?? new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const parsed = parseTavilyResponse(payload)
    if (parsed === undefined) throw new WebError('Tavily returned a malformed response body', 'WEB_PROVIDER_ERROR')
    return mapTavilyResponse(parsed)
  }

  /**
   * Read the API key for one search under its deadline.
   * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` without a key, `WEB_PROVIDER_ERROR`
   *   when the key source fails, or the cancellation error when `signal` aborts first.
   */
  private async apiKeyFor(signal: AbortSignal): Promise<string> {
    const resolved = await this.options.apiKey.resolve().then(
      key => ({ key }),
      (error: unknown) => { throw new WebError(`Tavily credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error }) },
    )
    const cancelled = this.cancelled(signal, undefined)
    if (cancelled !== undefined) throw cancelled
    if (resolved.key === undefined || resolved.key.length === 0) {
      throw new WebError(
        `Tavily search has no API key; store one under "${this.options.apiKey.ref}" or set that environment variable`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    return resolved.key
  }

  /**
   * Dispatch one search request without following redirects.
   * @throws {@link WebError} for cancellation, or `WEB_PROVIDER_ERROR` for a transport failure.
   */
  private async post(url: string, apiKey: string, body: TavilySearchRequest, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error: unknown) {
      throw this.cancelled(signal, error)
        ?? new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Describe a non-2xx response, preferring Tavily's error detail over the bare status line.
   * @returns the `WEB_PROVIDER_ERROR`, or the cancellation error when the body read was aborted.
   */
  private async httpFailure(response: Response, signal: AbortSignal): Promise<WebError> {
    const status = `Tavily API error (HTTP ${response.status})`
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch (error: unknown) {
      // A non-JSON error body (normal for gateway 5xx/429s) keeps the status-line message.
      return this.cancelled(signal, error) ?? new WebError(status, 'WEB_PROVIDER_ERROR')
    }
    const detail = tavilyErrorDetail(parsed)
    return new WebError(detail === undefined ? status : `${status}: ${detail}`, 'WEB_PROVIDER_ERROR')
  }

  /**
   * Classify a failure by the search's deadline signal, whose reason distinguishes this
   * provider's timeout from caller cancellation.
   * @returns the timeout or abort error, or undefined when the search was not cancelled.
   */
  private cancelled(signal: AbortSignal, error: unknown): WebError | undefined {
    const timeout = timeoutOf(signal, TAVILY_SEARCH_TIMEOUT)
    if (timeout !== undefined) {
      return new WebError(`Tavily search timed out after ${this.options.timeoutMs} ms`, TAVILY_SEARCH_TIMEOUT, { cause: timeout })
    }
    const abortError = error instanceof DOMException && error.name === 'AbortError'
    return signal.aborted || abortError ? new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error ?? signal.reason }) : undefined
  }
}

/**
 * First non-empty detail of a Tavily error body: `detail.error`, a string `detail`, `error`, or `message`.
 * @param body - the parsed error body.
 * @returns the detail, or undefined when the body carries none.
 */
function tavilyErrorDetail(body: unknown): string | undefined {
  if (!isJsonObject(body)) return undefined
  const nested = isJsonObject(body.detail) ? body.detail.error : body.detail
  return [nested, body.error, body.message]
    .find((text): text is string => typeof text === 'string' && text.length > 0)
}

/** Narrow untrusted JSON to an object with readable fields. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for an absent, null, or string wire field. */
function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

/** True for an integer from 1 to `max`. */
function isIntegerInRange(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max
}
