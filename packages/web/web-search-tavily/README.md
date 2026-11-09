---
description: "The Tavily-backed search provider for ctx.web: how deployments mount Tavily web search with query-relevant page excerpts, publication dates, and per-search credential resolution."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-tavily`, the harness searches the web through the Tavily Search API and gets ranked results with query-relevant page excerpts and publication dates. Choose it when a deployment has a Tavily API key and wants a search API built for agents. The provider never requests Tavily's generated answer or raw page content, so results carry no `content`, only citeable sources. The provider is not ready without a key, so `dsh-tool-web` withholds `web_search`; the model-facing tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service. It registers as the `tavily` search provider; select it with `searchProvider: tavily` on the `@deepseek-ai/dsh-web` row or `$DSH_WEB_SEARCH_PROVIDER`. Without a configured id, `ctx.web` selects it only when it is the only usable search provider, and this provider counts as usable whether or not a key is configured.

### When to choose it

Choose this backend when a deployment holds a Tavily API key and wants ranked results with page excerpts already selected for the query. Each search is one Tavily API request and consumes Tavily credits: one per `basic` search and two per `advanced` search.

### Minimal configuration

Load the web service and the provider, and store the key under `TAVILY_API_KEY` in the credential store or the launching environment.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tavily
- name: '@deepseek-ai/dsh-web-search-tavily'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Tavily API key; prefer `apiKeyEnv` so no secret enters configuration. A non-empty literal wins over `apiKeyEnv` |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the launch environment when that service is absent. A name outside the environment-variable grammar fails the plugin load |
| `baseURL` | `https://api.tavily.com` | Endpoint base; `/search` is appended. A value that is not an absolute `http:` or `https:` URL fails the plugin load |
| `searchDepth` | `basic` | Depth sent as Tavily's `search_depth`: `basic` or `advanced` |
| `numResults` | omitted | Result count from 1 to 20 sent as `max_results` when a request carries no `maxResults` |
| `timeoutMs` | `30000` | Positive-integer bound in milliseconds on one search, from key resolution through the response body |

### Authentication and readiness

Each search reads the key when it runs, so a key stored or rotated in the credential store reaches the next search without a restart. A mounted `ctx.credentials` service is authoritative, including absence; without it the provider reads the launch environment. The key is sent as `Authorization: Bearer`. The provider's `ready()` answers whether a literal key is set or the reference is configured, without reading the value; while this provider is selected, [`dsh-tool-web`](../tool-web/README.md) withholds `web_search` from each request for which it answers false. A credential store that cannot be read answers false.

### What a search returns

Each Tavily result maps to a `WebSearchSource` in Tavily's ranking order: `url`, `title`, the extracted `content` as `snippet`, and `published_date` as `publishedAt`. A blank title, content, or date is omitted rather than invented, so a result can be URL-only. A request's `maxResults` wins over `numResults`, is capped at Tavily's limit of 20, and is sent as `max_results`; the web service enforces the final bound by truncating and flagging. Every request sends `include_answer: false` and `include_raw_content: false`, and the result carries no `content`.

### Failures and recovery

Failures throw `WebError` with a machine-routable code. A search without a key fails as `WEB_PROVIDER_CREDENTIAL_MISSING` before any request is sent. Caller cancellation is `WEB_ABORTED`, and exceeding `timeoutMs` is `WEB_SEARCH_TIMEOUT`. HTTP errors (`Tavily API error (HTTP <status>): <detail>`, with the detail from Tavily's `detail.error`, `detail`, `error`, or `message` field), network failures, credential-store failures, and unparseable or malformed bodies are `WEB_PROVIDER_ERROR`. HTTP redirects are rejected before the `Location` target is contacted. The model-facing `web_search` tool surfaces failures under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Tavily's Search API with three rules:

- **Extracted excerpts only.** A source's `snippet` is Tavily's query-relevant `content` for that page; a blank excerpt leaves the source URL-only.
- **No generated answers.** The request disables Tavily's answer, so `content` is omitted rather than passing provider prose the model might trust.
- **Credentials resolved per search.** The key source is consulted on every search and readiness check, so the provider never retains a stale key.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, credential source, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `TavilySearchProvider`: option validation, request dispatch, cancellation classification, response validation and mapping |
| [`src/types.ts`](src/types.ts) | Tavily wire types: `TavilySearchRequest`, `TavilySearchResponse`, `TavilyResult` |

### Request and mapping flow

`search()` fuses the caller's signal with a `timeoutMs` deadline, resolves the key, and posts the query, search depth, optional capped result count, and disabled answer and raw-content flags to `{baseURL}/search` with `redirect: 'error'`. The deadline signal's reason distinguishes the provider's own timeout from caller cancellation at every stage. The parsed body is validated against the declared wire types and mapped entry by entry; the web service applies the final `maxResults` bound.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the search request and result vocabulary and error codes.
- [Web package map](../README.md) — the web package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.
- [Search readiness decision](../../../.agents/notes/implemented/architecture/2026-09-27-web-search-offered-by-provider-readiness.md) — why this provider reports readiness while `dsh-tool-web` withholds `web_search`.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, page excerpts, and publication dates or its exact `Tavily search has no API key; store one under "<ref>" or set that environment variable`, `Tavily search aborted`, `Tavily search timed out after <ms> ms`, `Tavily search request failed: <error>`, `Tavily API error (HTTP <status>)`, `Tavily returned an unprocessable response body: <error>`, and `Tavily returned a malformed response body` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **Only `searchDepth` and `numResults` are exposed** — Tavily's topic, time-range, and domain filters, answers, and raw content wait on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Results are capped at 20 per request** — a larger `maxResults` is sent as 20, Tavily's API limit.
- **`available()` does not check the key** — readiness is asynchronous, so when several search providers are mounted without `searchProvider`, selection reports `WEB_PROVIDER_AMBIGUOUS` even if only one has a key.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider Tavily control surface

Tavily's topic, time-range, and domain filters stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
