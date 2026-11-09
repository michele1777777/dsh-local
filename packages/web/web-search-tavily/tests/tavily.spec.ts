import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import { TavilySearchProvider, TAVILY_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-tavily'
import type { TavilyApiKeySource, TavilySearchProviderOptions } from '@deepseek-ai/dsh-web-search-tavily'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import { mapTavilyResponse, mapTavilyResult, parseTavilyResponse } from '../src/provider.ts'

function keySource(key: string | undefined): TavilyApiKeySource {
  return { ref: 'TAVILY_API_KEY', resolve: () => Promise.resolve(key), configured: () => Promise.resolve(key !== undefined) }
}

const options: TavilySearchProviderOptions = {
  apiKey: keySource('tvly-key'),
  baseURL: 'https://api.tavily.test',
  searchDepth: 'basic',
  timeoutMs: 30_000,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function stubFetch(impl: typeof fetch): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

/** The first dispatched request: its URL, init, and parsed JSON body. */
function sentRequest(mock: ReturnType<typeof vi.fn<typeof fetch>>): { url: string; init: RequestInit; body: unknown } {
  const call = mock.mock.calls[0]
  if (call === undefined) throw new Error('fetch was not called')
  const [input, init = {}] = call
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  return { url, init, body }
}

/** The code and message of the `WebError` a search rejects with. */
async function failureOf(search: Promise<unknown>): Promise<{ code: string | undefined; message: string }> {
  const error = await search.then(() => undefined, (reason: unknown) => reason)
  if (!(error instanceof WebError)) throw new Error('expected a WebError rejection')
  return { code: error.code, message: error.message }
}

/** A response whose body read rejects, as an abort during body consumption does. */
function failingBody(status: number, error: Error): Response {
  return Object.assign(new Response('{}', { status }), { json: () => Promise.reject(error) })
}

/** A fetch that settles only when its signal aborts, rejecting with the abort reason. */
const hangingFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
  const signal = init?.signal
  signal?.addEventListener('abort', () => {
    const reason: unknown = signal.reason
    reject(reason instanceof Error ? reason : new Error(String(reason)))
  }, { once: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tavily result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapTavilyResult({
      url: 'https://a.test',
      title: 'A',
      content: 'relevant excerpt',
      score: 0.9,
      published_date: '2026-01-01',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'relevant excerpt', publishedAt: '2026-01-01' })
  })

  it('keeps a URL-only source when title and content are blank or null', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: '', content: '  ', published_date: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://a.test', title: null, content: null })).toEqual({ url: 'https://a.test' })
  })

  it('maps a response in ranking order with no content', () => {
    const result = mapTavilyResponse({
      results: [
        { url: 'https://a.test', title: 'A', content: 'one', score: 0.9 },
        { url: 'https://b.test', title: 'B', content: 'two', score: 0.4 },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'one' },
        { url: 'https://b.test', title: 'B', snippet: 'two' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapTavilyResponse({}).sources).toEqual([])
  })

  it('keeps only the declared fields of a valid body', () => {
    expect(parseTavilyResponse({ results: [
      { url: 'https://a.test', title: 'A', content: 'c', score: 0.5, published_date: '2026-01-01', raw_content: null },
      { url: 'https://b.test', title: null, score: null },
    ] })).toEqual({ results: [
      { url: 'https://a.test', title: 'A', content: 'c', score: 0.5, published_date: '2026-01-01' },
      { url: 'https://b.test' },
    ] })
  })

  it('accepts a body without results and rejects declared fields of another type', () => {
    expect(parseTavilyResponse({ query: 'q' })).toEqual({})
    expect(parseTavilyResponse({ results: {} })).toBeUndefined()
    expect(parseTavilyResponse({ results: [{ title: 'no url' }] })).toBeUndefined()
    expect(parseTavilyResponse({ results: [{ url: 'https://a.test', content: 1 }] })).toBeUndefined()
    expect(parseTavilyResponse({ results: [{ url: 'https://a.test', score: 'high' }] })).toBeUndefined()
    expect(parseTavilyResponse('results')).toBeUndefined()
  })
})

describe('TavilySearchProvider construction and readiness', () => {
  it('rejects an endpoint base that is not an absolute http(s) URL', () => {
    expect(() => new TavilySearchProvider({ ...options, baseURL: 'api.tavily.com' })).toThrow(/baseURL/)
    expect(() => new TavilySearchProvider({ ...options, baseURL: 'ftp://api.tavily.com' })).toThrow(/baseURL/)
  })

  it('rejects numResults outside 1..20 and timeouts that are not positive integers', () => {
    expect(() => new TavilySearchProvider({ ...options, numResults: 0 })).toThrow(/numResults/)
    expect(() => new TavilySearchProvider({ ...options, numResults: 21 })).toThrow(/numResults/)
    expect(() => new TavilySearchProvider({ ...options, numResults: 2.5 })).toThrow(/numResults/)
    expect(() => new TavilySearchProvider({ ...options, timeoutMs: -1 })).toThrow(/timeoutMs/)
  })

  it('is available once constructed and ready only with a configured key', async () => {
    expect(new TavilySearchProvider(options).available()).toBe(true)
    await expect(new TavilySearchProvider(options).ready()).resolves.toBe(true)
    await expect(new TavilySearchProvider({ ...options, apiKey: keySource(undefined) }).ready()).resolves.toBe(false)
  })

  it('is not ready when the key source cannot be read', async () => {
    const apiKey: TavilyApiKeySource = { ...keySource('k'), configured: () => Promise.reject(new Error('store locked')) }
    await expect(new TavilySearchProvider({ ...options, apiKey }).ready()).resolves.toBe(false)
  })
})

describe('TavilySearchProvider request mapping', () => {
  it('sends query, depth, result count, disabled answer and raw content, and bearer auth', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    await new TavilySearchProvider({ ...options, searchDepth: 'advanced' }).search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const { url, init, body } = sentRequest(fetchMock)
    expect(url).toBe('https://api.tavily.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tvly-key')
    expect(body).toEqual({
      query: 'hello', search_depth: 'advanced', max_results: 5, include_answer: false, include_raw_content: false,
    })
  })

  it('caps the requested result count at the API limit', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    await new TavilySearchProvider(options).search({ query: 'q', maxResults: 50 })
    expect(sentRequest(fetchMock).body).toMatchObject({ max_results: 20 })
  })

  it('falls back to the configured numResults and omits max_results without either bound', async () => {
    let fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    await new TavilySearchProvider({ ...options, numResults: 7 }).search({ query: 'q' })
    expect(sentRequest(fetchMock).body).toMatchObject({ max_results: 7 })
    fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    await new TavilySearchProvider(options).search({ query: 'q' })
    expect(sentRequest(fetchMock).body).not.toHaveProperty('max_results')
  })

  it('maps a successful response into sources', async () => {
    stubFetch(async () => jsonResponse({
      query: 'q',
      results: [{ url: 'https://a.test', title: 'A', content: 'excerpt', score: 0.8, published_date: '2026-02-01' }],
      response_time: 1.2,
    }))
    await expect(new TavilySearchProvider(options).search({ query: 'q' })).resolves.toEqual({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'excerpt', publishedAt: '2026-02-01' }],
      truncated: false,
    })
  })
})

describe('TavilySearchProvider error handling', () => {
  it('fails with WEB_PROVIDER_CREDENTIAL_MISSING without a key and sends nothing', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const failure = await failureOf(new TavilySearchProvider({ ...options, apiKey: keySource(undefined) }).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
    expect(failure.message).toContain('TAVILY_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a key source failure to WEB_PROVIDER_ERROR', async () => {
    const apiKey: TavilyApiKeySource = { ...keySource('k'), resolve: () => Promise.reject(new Error('store locked')) }
    const failure = await failureOf(new TavilySearchProvider({ ...options, apiKey }).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('store locked')
  })

  it('maps an abort during key resolution to WEB_ABORTED without sending', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const controller = new AbortController()
    const apiKey: TavilyApiKeySource = { ...keySource('k'), resolve: () => { controller.abort(); return Promise.resolve('k') } }
    await expect(new TavilySearchProvider({ ...options, apiKey }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the status and Tavily detail', async () => {
    stubFetch(async () => jsonResponse({ detail: { error: 'Unauthorized: missing or invalid API key.' } }, { status: 401 }))
    await expect(new TavilySearchProvider(options).search({ query: 'q' })).rejects.toThrow(expect.objectContaining({
      code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 401): Unauthorized: missing or invalid API key.',
    }))
    stubFetch(async () => jsonResponse({ detail: 'rate limited' }, { status: 429 }))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 429): rate limited' }))
  })

  it('keeps the status-line message when the error body is not JSON or carries no detail', async () => {
    stubFetch(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 502)' }))
    stubFetch(async () => jsonResponse({ detail: {} }, { status: 500 }))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 500)' }))
    stubFetch(async () => jsonResponse('not an envelope', { status: 400 }))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 400)' }))
    stubFetch(async () => jsonResponse({ error: 'bad request' }, { status: 400 }))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 400): bad request' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    const failure = await failureOf(new TavilySearchProvider(options).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('fetch failed')
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    stubFetch(async () => new Response('not json', { status: 200 }))
    const failure = await failureOf(new TavilySearchProvider(options).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('unprocessable')
  })

  it('maps a well-formed body of the wrong type to WEB_PROVIDER_ERROR', async () => {
    stubFetch(async () => jsonResponse({ results: [{ url: 42 }] }))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily returned a malformed response body' }))
  })

  it('maps a caller abort before dispatch to WEB_ABORTED without sending', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const controller = new AbortController()
    controller.abort()
    await expect(new TavilySearchProvider(options).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a caller abort during the request to WEB_ABORTED', async () => {
    stubFetch(hangingFetch)
    const controller = new AbortController()
    const search = new TavilySearchProvider(options).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('custom reason'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps its own deadline to WEB_SEARCH_TIMEOUT', async () => {
    stubFetch(hangingFetch)
    await expect(new TavilySearchProvider({ ...options, timeoutMs: 10 }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_SEARCH_TIMEOUT', message: 'Tavily search timed out after 10 ms' }))
  })

  it('surfaces an abort during success-body or error-body parse as WEB_ABORTED', async () => {
    stubFetch(async () => failingBody(200, new DOMException('aborted', 'AbortError')))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    stubFetch(async () => failingBody(500, new DOMException('aborted', 'AbortError')))
    await expect(new TavilySearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-tavily plugin registration', () => {
  it('registers the provider into ctx.web and removes it on dispose (HMR-safe)', async () => {
    stubFetch(async () => jsonResponse({ results: [] }))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tvly-key' })
    expect(ctx.web.listProviders().search).toEqual([expect.objectContaining({ id: TAVILY_PROVIDER_ID, title: 'Tavily' })])
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export form)', () => {
    expect('default' in tavilyPlugin).toBe(false)
  })

  it('threads searchDepth, numResults and baseURL config into the request', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, {
      apiKey: 'tvly-key', searchDepth: 'advanced', numResults: 9, baseURL: 'https://gateway.test/tavily',
    })
    await ctx.web.search({ query: 'q' })
    const { url, body } = sentRequest(fetchMock)
    expect(url).toBe('https://gateway.test/tavily/search')
    expect(body).toMatchObject({ search_depth: 'advanced', max_results: 9 })
    await fiber.dispose()
  })

  it('resolves the key from the configured environment reference and the default base URL', async () => {
    vi.stubEnv('DSH_TEST_TAVILY_KEY', 'env-key')
    try {
      const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      const fiber = await ctx.plugin(tavilyPlugin, { apiKeyEnv: 'DSH_TEST_TAVILY_KEY' })
      await expect(ctx.web.searchReady()).resolves.toBe(true)
      await ctx.web.search({ query: 'q' })
      const { url, init } = sentRequest(fetchMock)
      expect(url).toBe('https://api.tavily.com/search')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer env-key')
      await fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('is not ready and fails loud when no key is configured', async () => {
    vi.stubEnv('DSH_TEST_TAVILY_MISSING', undefined)
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, { apiKeyEnv: 'DSH_TEST_TAVILY_MISSING' })
      await expect(ctx.web.searchReady()).resolves.toBe(false)
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reports a literal key as ready', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    await ctx.plugin(tavilyPlugin, { apiKey: 'tvly-key', apiKeyEnv: 'DSH_TEST_TAVILY_MISSING' })
    await expect(ctx.web.searchReady()).resolves.toBe(true)
  })

  it('reads the key from a mounted credentials service on each search', async () => {
    vi.stubEnv('DSH_TEST_TAVILY_STORED', undefined)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-tavily-'))
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(tavilyPlugin, { apiKeyEnv: 'DSH_TEST_TAVILY_STORED' })
      await expect(ctx.web.searchReady()).resolves.toBe(false)
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('DSH_TEST_TAVILY_STORED')
      await ctx.credentials.set(ref, 'stored-key')
      await expect(ctx.web.searchReady()).resolves.toBe(true)
      await ctx.web.search({ query: 'q' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'q' })
      expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')))
        .toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      vi.unstubAllEnvs()
    }
  })

  it('fails the plugin load on an invalid endpoint base or key reference', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    await expect(ctx.plugin(tavilyPlugin, { apiKey: 'k', baseURL: 'not a url' })).rejects.toThrow(/baseURL/)
    await expect(ctx.plugin(tavilyPlugin, { apiKeyEnv: 'not a ref' })).rejects.toThrow(/credential ref/)
  })
})
