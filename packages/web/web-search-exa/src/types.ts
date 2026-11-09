/**
 * Wire types for the Exa search API (`POST https://api.exa.ai/search`). Exa returns a flat
 * `results[]`; each entry carries a URL, optional title, optional `publishedDate`, and, when
 * highlights are requested, a `highlights[]` array of salient sentences.
 *
 * @module @deepseek-ai/dsh-web-search-exa/types
 */

/** Retrieval mode sent as Exa's `type`: keyword, neural (embeddings), or auto (Exa decides). */
export type ExaSearchType = 'auto' | 'keyword' | 'neural'

/** Request body sent to Exa's search endpoint. */
export interface ExaSearchRequest {
  readonly query: string
  readonly type: ExaSearchType
  /** Exa's result-count control; the web service still enforces the bound on return. */
  readonly numResults?: number
  /** Ask Exa to return highlight sentences per result. */
  readonly contents: { readonly highlights: { readonly highlightsPerUrl: number } }
}

/** One entry of Exa's flat `results[]`. */
export interface ExaResult {
  readonly url: string
  readonly title?: string | null
  readonly publishedDate?: string | null
  readonly highlights?: readonly string[]
}

/** Exa's search response envelope. */
export interface ExaSearchResponse {
  readonly results?: readonly ExaResult[]
}
