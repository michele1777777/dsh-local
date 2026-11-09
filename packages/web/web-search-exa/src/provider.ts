/**
 * `ExaSearchProvider`: a `WebSearchProvider` backed by the Exa search API (`POST /search` with
 * highlight contents). It maps the first non-blank highlight to `snippet`, maps
 * `publishedDate` to `publishedAt`, drops entries without a snippet, and omits `content`
 * because Exa returns no generated answer.
 * @module @deepseek-ai/dsh-web-search-exa/provider
 */

import { MAX_TIMER_DELAY_MS, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ExaResult, ExaSearchRequest, ExaSearchResponse, ExaSearchType } from './types.ts'

/** Stable id this provider registers under; the value `searchProvider` selects. */
export const EXA_PROVIDER_ID = 'exa'

/** Default Exa API base; `/search` is the operation. */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'

/** Default credential reference holding the Exa API key. */
export const EXA_DEFAULT_API_KEY_ENV = 'EXA_API_KEY'

/** Default retrieval mode: let Exa pick between keyword and neural search. */
export const EXA_DEFAULT_SEARCH_TYPE: ExaSearchType = 'auto'

/** Default number of highlight sentences requested per result. */
export const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1

/** Default bound on one search, from credential resolution through the response body. */
export const EXA_DEFAULT_TIMEOUT_MS = 30_000

/** Error code of a search that exceeded the provider's own `timeoutMs`. */
export const EXA_SEARCH_TIMEOUT = 'WEB_SEARCH_TIMEOUT'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Where one search reads its API key; both operations run per call, so a rotated key applies to the next search. */
export interface ExaApiKeySource {
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
export interface ExaSearchProviderOptions {
  /** API key source consulted by each search and readiness check. */
  readonly apiKey: ExaApiKeySource
  /** Absolute `http:` or `https:` endpoint base; `/search` is appended. */
  readonly baseURL: string
  /** Retrieval mode sent as Exa's `type`. */
  readonly searchType: ExaSearchType
  /** Positive-integer result count sent when a request carries no `maxResults`. */
  readonly numResults?: number
  /** Positive-integer highlight sentences requested per result (Exa's `highlightsPerUrl`). */
  readonly highlightsPerResult: number
  /** Positive bound in milliseconds on one search, at most {@link MAX_TIMER_DELAY_MS}. */
  readonly timeoutMs: number
}

/**
 * Map one Exa result to a normalized source, or `undefined` when it carries no
 * non-blank highlight: the seam has no other field to derive a snippet from.
 *
 * @param result - one entry of Exa's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no non-blank highlight.
 */
export function mapExaResult(result: ExaResult): WebSearchSource | undefined {
  const snippet = result.highlights?.find(highlight => highlight.trim().length > 0)
  if (snippet === undefined) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
    ...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * Map an Exa response envelope to a normalized search result. `content` is omitted because
 * Exa returns no generated answer; `truncated` is false because the web service owns the
 * final `maxResults` bound.
 *
 * @param response - the validated `POST /search` response body.
 * @returns the normalized result; snippet-less entries are dropped ({@link mapExaResult}).
 */
export function mapExaResponse(response: ExaSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapExaResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/**
 * Validate an untrusted Exa success body against {@link ExaSearchResponse}.
 * @param value - the parsed JSON body.
 * @returns the typed response, or undefined when any declared field has another type.
 */
export function parseExaResponse(value: unknown): ExaSearchResponse | undefined {
  if (!isRecord(value)) return undefined
  const { results } = value
  if (results === undefined) return {}
  if (!Array.isArray(results)) return undefined
  const parsed: ExaResult[] = []
  for (const entry of results) {
    if (!isRecord(entry) || typeof entry.url !== 'string') return undefined
    const { title, publishedDate, highlights } = entry
    if (!isOptionalText(title) || !isOptionalText(publishedDate)) return undefined
    if (highlights !== undefined && !(Array.isArray(highlights) && highlights.every(item => typeof item === 'string'))) return undefined
    parsed.push({
      url: entry.url,
      ...title === undefined ? {} : { title },
      ...publishedDate === undefined ? {} : { publishedDate },
      ...highlights === undefined ? {} : { highlights },
    })
  }
  return { results: parsed }
}

/**
 * The Exa-backed search provider. Options are validated at construction, so `available()`
 * is always true; `ready()` reports whether an API key is configured. HTTP redirects fail as
 * `WEB_PROVIDER_ERROR` without contacting the target.
 */
export class ExaSearchProvider implements WebSearchProvider {
  readonly id = EXA_PROVIDER_ID
  readonly title = 'Exa'
  /** Picker description: what this provider suits and what it costs. */
  readonly description: NonNullable<WebSearchProvider['description']> = {
    en: 'Searches the web through Exa and returns titles, URLs, highlight snippets, and publication dates. Requires an Exa API key and may incur Exa API charges.',
    zh: '通过 Exa 搜索网页，返回标题、URL、高亮摘要与发布日期。需要 Exa API Key，可能产生 Exa API 计费。',
    ja: 'Exa でウェブを検索し、タイトル、URL、ハイライトのスニペット、公開日を返します。Exa API キーが必要で、Exa API の料金が発生する場合があります。',
    es: 'Busca en la web mediante Exa y devuelve títulos, URL, fragmentos destacados y fechas de publicación. Requiere una clave de API de Exa y puede generar cargos de la API de Exa.',
    fr: "Recherche sur le Web via Exa et renvoie titres, URL, extraits mis en évidence et dates de publication. Nécessite une clé API Exa et peut entraîner des frais d'API Exa.",
    de: 'Durchsucht das Web über Exa und liefert Titel, URLs, hervorgehobene Ausschnitte und Veröffentlichungsdaten. Erfordert einen Exa-API-Schlüssel und kann Exa-API-Kosten verursachen.',
    ru: 'Ищет в интернете через Exa и возвращает заголовки, URL, выделенные фрагменты и даты публикации. Требуется ключ API Exa; возможна оплата Exa API.',
    pt: 'Pesquisa na web pelo Exa e retorna títulos, URLs, trechos destacados e datas de publicação. Requer uma chave de API do Exa e pode gerar cobranças da API do Exa.',
  }

  /**
   * @param options - resolved options.
   * @throws TypeError when `baseURL` is not an absolute `http:`/`https:` URL, a count is not a
   *   positive integer, or `timeoutMs` is outside `1..MAX_TIMER_DELAY_MS`.
   */
  constructor(private readonly options: ExaSearchProviderOptions) {
    assertHttpUrl(options.baseURL)
    assertPositiveInteger('highlightsPerResult', options.highlightsPerResult)
    if (options.numResults !== undefined) assertPositiveInteger('numResults', options.numResults)
    assertPositiveInteger('timeoutMs', options.timeoutMs)
    if (options.timeoutMs > MAX_TIMER_DELAY_MS) throw new TypeError(`web-search-exa: timeoutMs must be at most ${MAX_TIMER_DELAY_MS}`)
  }

  available(): boolean {
    return true
  }

  async ready(): Promise<boolean> {
    try { return await this.options.apiKey.configured() }
    catch (_unreadableStore) { return false /* A store that cannot be read supplies no key to the search either. */ }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted === true) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: signal.reason })
    using bound = deadline(signal, this.options.timeoutMs, EXA_SEARCH_TIMEOUT)
    const apiKey = await this.resolveApiKey(bound.signal)
    // A per-request bound wins over the configured default; either may be absent.
    const numResults = request.maxResults ?? this.options.numResults
    const body: ExaSearchRequest = {
      query: request.query,
      type: this.options.searchType,
      contents: { highlights: { highlightsPerUrl: this.options.highlightsPerResult } },
      ...numResults === undefined ? {} : { numResults },
    }
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL.replace(/\/+$/u, '')}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: bound.signal,
      })
    } catch (error: unknown) {
      throw this.cancellation(bound.signal, error)
        ?? new WebError(`Exa search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      let message = `Exa API error (HTTP ${response.status})`
      try {
        const parsed: unknown = await response.json()
        const detail = isRecord(parsed) ? errorDetail(parsed) : undefined
        if (detail !== undefined) message = `${message}: ${detail}`
      } catch (error: unknown) {
        const cancelled = this.cancellation(bound.signal, error)
        if (cancelled !== undefined) throw cancelled
        // A non-JSON error body (normal for gateway 5xx/429s) keeps the status-line message.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      throw this.cancellation(bound.signal, error)
        ?? new WebError(`Exa returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const parsed = parseExaResponse(payload)
    if (parsed === undefined) throw new WebError('Exa returned a malformed response body', 'WEB_PROVIDER_ERROR')
    return mapExaResponse(parsed)
  }

  /**
   * Read the API key for one search under its deadline.
   * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` without a key, `WEB_PROVIDER_ERROR`
   *   when the key source fails, or the cancellation error when `signal` aborts first.
   */
  private async resolveApiKey(signal: AbortSignal): Promise<string> {
    let key: string | undefined
    try {
      key = await this.options.apiKey.resolve()
    } catch (error: unknown) {
      throw new WebError(`Exa credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const cancelled = this.cancellation(signal, undefined)
    if (cancelled !== undefined) throw cancelled
    if (key === undefined || key.length === 0) {
      throw new WebError(
        `Exa search has no API key; store one under "${this.options.apiKey.ref}" or set that environment variable`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    return key
  }

  /**
   * Classify a failure by the search's deadline signal, whose reason distinguishes this
   * provider's timeout from caller cancellation.
   * @returns the timeout or abort error, or undefined when the search was not cancelled.
   */
  private cancellation(signal: AbortSignal, error: unknown): WebError | undefined {
    const timeout = timeoutOf(signal, EXA_SEARCH_TIMEOUT)
    if (timeout !== undefined) {
      return new WebError(`Exa search timed out after ${this.options.timeoutMs} ms`, EXA_SEARCH_TIMEOUT, { cause: timeout })
    }
    if (signal.aborted || isAbortError(error)) return new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error ?? signal.reason })
    return undefined
  }
}

/** Narrow untrusted JSON to an object with readable fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for an absent, null, or string wire field. */
function isOptionalText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

/**
 * First non-empty detail of an Exa error body: `error`, then `message`.
 * @param body - the parsed error body.
 * @returns the detail, or undefined when the body carries none.
 */
function errorDetail(body: Record<string, unknown>): string | undefined {
  return [body.error, body.message].find((text): text is string => typeof text === 'string' && text.length > 0)
}

/** Reject an endpoint base that is not an absolute `http:` or `https:` URL. */
function assertHttpUrl(baseURL: string): void {
  const url = URL.parse(baseURL)
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new TypeError(`web-search-exa: baseURL "${baseURL}" must be an absolute http or https URL`)
  }
}

/** Reject a count or duration that is not a positive integer. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`web-search-exa: ${name} must be a positive integer`)
}

/** True for a fetch or body-read abort that carries no deadline reason. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
