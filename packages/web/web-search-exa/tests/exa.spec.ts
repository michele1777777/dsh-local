import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import { ExaSearchProvider, EXA_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-exa'
import type { ExaApiKeySource, ExaSearchProviderOptions } from '@deepseek-ai/dsh-web-search-exa'
import * as exaPlugin from '@deepseek-ai/dsh-web-search-exa'
import { mapExaResponse, mapExaResult, parseExaResponse } from '../src/provider.ts'

function keySource(key: string | undefined): ExaApiKeySource {
  return { ref: 'EXA_API_KEY', resolve: () => Promise.resolve(key), configured: () => Promise.resolve(key !== undefined) }
}

const options: ExaSearchProviderOptions = {
  apiKey: keySource('exa-key'),
  baseURL: 'https://api.exa.test',
  searchType: 'auto',
  highlightsPerResult: 1,
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

describe('Exa result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapExaResult({
      url: 'https://a.test',
      title: 'A',
      publishedDate: '2026-01-01',
      highlights: ['salient sentence', 'second'],
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'salient sentence', publishedAt: '2026-01-01' })
  })

  it('drops a result with no usable highlight', () => {
    expect(mapExaResult({ url: 'https://a.test', highlights: [] })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test' })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test', highlights: ['  '] })).toBeUndefined()
  })

  it('omits null and empty optional fields', () => {
    expect(mapExaResult({ url: 'https://a.test', title: null, publishedDate: null, highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
    expect(mapExaResult({ url: 'https://a.test', title: '', publishedDate: '', highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapExaResponse({
      results: [
        { url: 'https://a.test', highlights: ['one'] },
        { url: 'https://b.test' },
        { url: 'https://c.test', title: 'C', highlights: ['three'] },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapExaResponse({}).sources).toEqual([])
  })

  it('keeps only the declared fields of a valid body', () => {
    expect(parseExaResponse({ results: [
      { url: 'https://a.test', title: null, publishedDate: '2026-01-01', highlights: ['a'], score: 0.5 },
      { url: 'https://b.test' },
    ] })).toEqual({ results: [
      { url: 'https://a.test', title: null, publishedDate: '2026-01-01', highlights: ['a'] },
      { url: 'https://b.test' },
    ] })
  })

  it('accepts a body without results and rejects declared fields of another type', () => {
    expect(parseExaResponse({})).toEqual({})
    expect(parseExaResponse({ results: {} })).toBeUndefined()
    expect(parseExaResponse({ results: [{ title: 'no url' }] })).toBeUndefined()
    expect(parseExaResponse({ results: [{ url: 'https://a.test', highlights: [1] }] })).toBeUndefined()
    expect(parseExaResponse({ results: [{ url: 'https://a.test', title: 3 }] })).toBeUndefined()
    expect(parseExaResponse([])).toBeUndefined()
  })
})

describe('ExaSearchProvider construction and readiness', () => {
  it('rejects an endpoint base that is not an absolute http(s) URL', () => {
    expect(() => new ExaSearchProvider({ ...options, baseURL: 'not a url' })).toThrow(/baseURL/)
    expect(() => new ExaSearchProvider({ ...options, baseURL: 'file:///tmp' })).toThrow(/baseURL/)
  })

  it('rejects counts and timeouts that are not positive integers', () => {
    expect(() => new ExaSearchProvider({ ...options, highlightsPerResult: 0 })).toThrow(/highlightsPerResult/)
    expect(() => new ExaSearchProvider({ ...options, highlightsPerResult: 1.5 })).toThrow(/highlightsPerResult/)
    expect(() => new ExaSearchProvider({ ...options, numResults: -1 })).toThrow(/numResults/)
    expect(() => new ExaSearchProvider({ ...options, timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => new ExaSearchProvider({ ...options, timeoutMs: 2 ** 31 })).toThrow(/timeoutMs/)
  })

  it('is available once constructed and ready only with a configured key', async () => {
    expect(new ExaSearchProvider(options).available()).toBe(true)
    await expect(new ExaSearchProvider(options).ready()).resolves.toBe(true)
    await expect(new ExaSearchProvider({ ...options, apiKey: keySource(undefined) }).ready()).resolves.toBe(false)
  })

  it('is not ready when the key source cannot be read', async () => {
    const apiKey: ExaApiKeySource = { ...keySource('k'), configured: () => Promise.reject(new Error('store locked')) }
    await expect(new ExaSearchProvider({ ...options, apiKey }).ready()).resolves.toBe(false)
  })
})

describe('ExaSearchProvider request mapping', () => {
  it('sends query, type, highlights, numResults and bearer auth', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [{ url: 'https://a.test', highlights: ['hi'] }] }))
    await new ExaSearchProvider({ ...options, searchType: 'neural', highlightsPerResult: 3 }).search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const { url, init, body } = sentRequest(fetchMock)
    expect(url).toBe('https://api.exa.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer exa-key')
    expect(body).toEqual({ query: 'hello', type: 'neural', contents: { highlights: { highlightsPerUrl: 3 } }, numResults: 5 })
  })

  it('does not double a trailing slash on the endpoint base', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    await new ExaSearchProvider({ ...options, baseURL: 'https://api.exa.test/' }).search({ query: 'q' })
    expect(sentRequest(fetchMock).url).toBe('https://api.exa.test/search')
  })

  it('falls back to the configured numResults when a request omits maxResults', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    await new ExaSearchProvider({ ...options, numResults: 7 }).search({ query: 'q' })
    expect(sentRequest(fetchMock).body).toMatchObject({ numResults: 7 })
  })

  it('lets a request maxResults win over the configured numResults', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    await new ExaSearchProvider({ ...options, numResults: 7 }).search({ query: 'q', maxResults: 2 })
    expect(sentRequest(fetchMock).body).toMatchObject({ numResults: 2 })
  })

  it('omits numResults when neither maxResults nor a configured default is set', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    await new ExaSearchProvider(options).search({ query: 'q' })
    expect(sentRequest(fetchMock).body).not.toHaveProperty('numResults')
  })

  it('maps a successful response into sources', async () => {
    stubFetch(async () => jsonResponse({ results: [{ url: 'https://a.test', title: 'A', highlights: ['hi'], publishedDate: '2026-02-01' }] }))
    await expect(new ExaSearchProvider(options).search({ query: 'q' })).resolves.toEqual({
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'hi', publishedAt: '2026-02-01' }],
      truncated: false,
    })
  })
})

describe('ExaSearchProvider error handling', () => {
  it('fails with WEB_PROVIDER_CREDENTIAL_MISSING without a key and sends nothing', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const failure = await failureOf(new ExaSearchProvider({ ...options, apiKey: keySource('') }).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
    expect(failure.message).toContain('EXA_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a key source failure to WEB_PROVIDER_ERROR', async () => {
    const apiKey: ExaApiKeySource = { ...keySource('k'), resolve: () => Promise.reject(new Error('store locked')) }
    const failure = await failureOf(new ExaSearchProvider({ ...options, apiKey }).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('store locked')
  })

  it('maps an abort during key resolution to WEB_ABORTED without sending', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const controller = new AbortController()
    const apiKey: ExaApiKeySource = { ...keySource('k'), resolve: () => { controller.abort(); return Promise.resolve('k') } }
    await expect(new ExaSearchProvider({ ...options, apiKey }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the status and provider message', async () => {
    stubFetch(async () => jsonResponse({ error: 'bad key' }, { status: 401 }))
    await expect(new ExaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Exa API error (HTTP 401): bad key' }))
    stubFetch(async () => jsonResponse({ message: 'quota exceeded' }, { status: 429 }))
    await expect(new ExaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Exa API error (HTTP 429): quota exceeded' }))
    stubFetch(async () => jsonResponse(['not an envelope'], { status: 400 }))
    await expect(new ExaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Exa API error (HTTP 400)' }))
  })

  it('keeps the status-line message when the error body is not JSON or carries no detail', async () => {
    stubFetch(async () => new Response('gateway down', { status: 502 }))
    await expect(new ExaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Exa API error (HTTP 502)' }))
    stubFetch(async () => jsonResponse({}, { status: 500 }))
    await expect(new ExaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Exa API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    stubFetch(() => Promise.reject(new TypeError('connection refused')))
    const failure = await failureOf(new ExaSearchProvider(options).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('connection refused')
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    stubFetch(async () => new Response('not json', { status: 200 }))
    const failure = await failureOf(new ExaSearchProvider(options).search({ query: 'q' }))
    expect(failure.code).toBe('WEB_PROVIDER_ERROR')
    expect(failure.message).toContain('unprocessable')
  })

  it('maps a well-formed body of the wrong type to WEB_PROVIDER_ERROR', async () => {
    stubFetch(async () => jsonResponse({ results: {} }))
    await expect(new ExaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Exa returned a malformed response body' }))
  })

  it('maps a caller abort before dispatch to WEB_ABORTED without sending', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const controller = new AbortController()
    controller.abort()
    await expect(new ExaSearchProvider(options).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a caller abort during the request to WEB_ABORTED', async () => {
    stubFetch(hangingFetch)
    const controller = new AbortController()
    const search = new ExaSearchProvider(options).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('custom reason'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps its own deadline to WEB_SEARCH_TIMEOUT', async () => {
    stubFetch(hangingFetch)
    await expect(new ExaSearchProvider({ ...options, timeoutMs: 10 }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_SEARCH_TIMEOUT', message: 'Exa search timed out after 10 ms' }))
  })

  it('surfaces an abort during success-body or error-body parse as WEB_ABORTED', async () => {
    stubFetch(async () => failingBody(200, new DOMException('aborted', 'AbortError')))
    await expect(new ExaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    stubFetch(async () => failingBody(500, new DOMException('aborted', 'AbortError')))
    await expect(new ExaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-exa plugin registration', () => {
  it('registers the provider into ctx.web and removes it on dispose (HMR-safe)', async () => {
    stubFetch(async () => jsonResponse({ results: [] }))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    const fiber = await ctx.plugin(exaPlugin, { apiKey: 'exa-key' })
    expect(ctx.web.listProviders().search.map(provider => provider.id)).toEqual([EXA_PROVIDER_ID])
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export form)', () => {
    expect('default' in exaPlugin).toBe(false)
  })

  it('threads searchType, highlightsPerResult and numResults config into the request', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    const fiber = await ctx.plugin(exaPlugin, { apiKey: 'exa-key', searchType: 'keyword', highlightsPerResult: 2, numResults: 9 })
    await ctx.web.search({ query: 'q' })
    expect(sentRequest(fetchMock).body).toMatchObject({ type: 'keyword', contents: { highlights: { highlightsPerUrl: 2 } }, numResults: 9 })
    await fiber.dispose()
  })

  it('resolves the key from the configured environment reference and the default base URL', async () => {
    vi.stubEnv('DSH_TEST_EXA_KEY', 'env-key')
    try {
      const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      const fiber = await ctx.plugin(exaPlugin, { apiKeyEnv: 'DSH_TEST_EXA_KEY' })
      await expect(ctx.web.searchReady()).resolves.toBe(true)
      await ctx.web.search({ query: 'q' })
      const { url, init } = sentRequest(fetchMock)
      expect(url).toBe('https://api.exa.ai/search')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer env-key')
      await fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('is not ready and fails loud when no key is configured', async () => {
    vi.stubEnv('DSH_TEST_EXA_MISSING', undefined)
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      await ctx.plugin(exaPlugin, { apiKeyEnv: 'DSH_TEST_EXA_MISSING' })
      await expect(ctx.web.searchReady()).resolves.toBe(false)
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reports a literal key as ready', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    await ctx.plugin(exaPlugin, { apiKey: 'exa-key', apiKeyEnv: 'DSH_TEST_EXA_MISSING' })
    await expect(ctx.web.searchReady()).resolves.toBe(true)
  })

  it('reads the key from a mounted credentials service on each search', async () => {
    vi.stubEnv('DSH_TEST_EXA_STORED', undefined)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-exa-'))
    const fetchMock = stubFetch(async () => jsonResponse({ results: [] }))
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(exaPlugin, { apiKeyEnv: 'DSH_TEST_EXA_STORED' })
      await expect(ctx.web.searchReady()).resolves.toBe(false)
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('DSH_TEST_EXA_STORED')
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
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    await expect(ctx.plugin(exaPlugin, { apiKey: 'k', baseURL: 'not a url' })).rejects.toThrow(/baseURL/)
    await expect(ctx.plugin(exaPlugin, { apiKeyEnv: 'not a ref' })).rejects.toThrow(/credential ref/)
  })
})
