/**
 * Wire types for the Tavily Search API (`POST https://api.tavily.com/search`). Tavily returns a
 * flat `results[]`; each entry carries a URL, title, extracted `content`, a relevance `score`,
 * and, for news results, a `published_date`.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** Search depth sent as Tavily's `search_depth`: `advanced` costs more credits and latency for more relevant content. */
export type TavilySearchDepth = 'basic' | 'advanced'

/** Request body sent to Tavily's search endpoint. */
export interface TavilySearchRequest {
  readonly query: string
  readonly search_depth: TavilySearchDepth
  /** Tavily's result-count control; the web service still enforces the bound on return. */
  readonly max_results?: number
  /** Always false: provider-generated answers are not trusted as search results. */
  readonly include_answer: false
  /** Always false: raw page content is retrieved through web fetch, not search. */
  readonly include_raw_content: false
}

/** One entry of Tavily's flat `results[]`. */
export interface TavilyResult {
  readonly url: string
  readonly title?: string | null
  /** Query-relevant content extracted from the page. */
  readonly content?: string | null
  readonly score?: number | null
  readonly published_date?: string | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  readonly results?: readonly TavilyResult[]
}
