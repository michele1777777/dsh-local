---
description: "The Exa-backed search provider for ctx.web: how deployments mount Exa web search with highlight snippets, publication dates, and per-search credential resolution."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-exa

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-exa`, the harness searches the web through Exa and gets results with highlight snippets and publication dates. Choose it when a deployment has an Exa API key and wants Exa's keyword or neural search. Exa returns no generated answer, so results carry no `content`, only citeable sources. A result with no non-blank highlight is dropped, so a call can return fewer sources than requested. The provider is not ready without a key, so `dsh-tool-web` withholds `web_search`; the model-facing tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service. It registers as the `exa` search provider; select it with `searchProvider: exa` on the `@deepseek-ai/dsh-web` row or `$DSH_WEB_SEARCH_PROVIDER`. Without a configured id, `ctx.web` selects it only when it is the only usable search provider, and this provider counts as usable whether or not a key is configured.

### When to choose it

Choose this backend when a deployment holds an Exa API key and wants Exa's keyword or neural search with per-result highlight snippets and publication dates. Each search is one Exa API request and may incur Exa charges.

### Minimal configuration

Load the web service and the provider, and store the key under `EXA_API_KEY` in the credential store or the launching environment.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: exa
- name: '@deepseek-ai/dsh-web-search-exa'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Exa API key; prefer `apiKeyEnv` so no secret enters configuration. A non-empty literal wins over `apiKeyEnv` |
| `apiKeyEnv` | `EXA_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the launch environment when that service is absent. A name outside the environment-variable grammar fails the plugin load |
| `baseURL` | `https://api.exa.ai` | Endpoint base; `/search` is appended. A value that is not an absolute `http:` or `https:` URL fails the plugin load |
| `searchType` | `auto` | Retrieval mode sent as Exa's `type`: `auto`, `keyword`, or `neural` |
| `numResults` | omitted | Positive-integer result count sent when a request carries no `maxResults` |
| `highlightsPerResult` | `1` | Positive-integer highlight sentences requested per result (Exa's `highlightsPerUrl`) |
| `timeoutMs` | `30000` | Positive-integer bound in milliseconds on one search, from key resolution through the response body |

### Authentication and readiness

Each search reads the key when it runs, so a key stored or rotated in the credential store reaches the next search without a restart. A mounted `ctx.credentials` service is authoritative, including absence; without it the provider reads the launch environment. The key is sent as `Authorization: Bearer`. The provider's `ready()` answers whether a literal key is set or the reference is configured, without reading the value; while this provider is selected, [`dsh-tool-web`](../tool-web/README.md) withholds `web_search` from each request for which it answers false. A credential store that cannot be read answers false.

### What a search returns

Each Exa result maps to a `WebSearchSource`: `url`, `title`, the first non-blank highlight as `snippet`, and `publishedDate` as `publishedAt`; a result with no highlight has no portable snippet and is dropped. A request's `maxResults` wins over `numResults` and is sent to Exa as a cost and latency optimization; the web service enforces the final bound by truncating and flagging. The result carries no `content`.

### Failures and recovery

Failures throw `WebError` with a machine-routable code. A search without a key fails as `WEB_PROVIDER_CREDENTIAL_MISSING` before any request is sent. Caller cancellation is `WEB_ABORTED`, and exceeding `timeoutMs` is `WEB_SEARCH_TIMEOUT`. HTTP errors (`Exa API error (HTTP <status>): <detail>`), network failures, credential-store failures, and unparseable or malformed bodies are `WEB_PROVIDER_ERROR`. HTTP redirects are rejected before the `Location` target is contacted. The model-facing `web_search` tool surfaces failures under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Exa's API with three rules:

- **Portable snippets only.** A source gains a `snippet` only from a real highlight; snippet-less results are dropped rather than given invented text.
- **No invented answers.** Exa returns no generated answer, so `content` is omitted.
- **Credentials resolved per search.** The key source is consulted on every search and readiness check, so the provider never retains a stale key.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, credential source, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `ExaSearchProvider`: option validation, request dispatch, cancellation classification, response validation and mapping |
| [`src/types.ts`](src/types.ts) | Exa wire types: `ExaSearchRequest`, `ExaSearchResponse`, `ExaResult` |

### Request and mapping flow

`search()` fuses the caller's signal with a `timeoutMs` deadline, resolves the key, and posts the query, retrieval mode, highlight request, and optional result count to `{baseURL}/search` with `redirect: 'error'`. The deadline signal's reason distinguishes the provider's own timeout from caller cancellation at every stage. The parsed body is validated against the declared wire types, mapped entry by entry, and snippet-less entries are dropped; the web service applies the final `maxResults` bound.

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

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, first highlights, and publication dates or its exact `Exa search has no API key; store one under "<ref>" or set that environment variable`, `Exa search aborted`, `Exa search timed out after <ms> ms`, `Exa search request failed: <error>`, `Exa API error (HTTP <status>)`, `Exa returned an unprocessable response body: <error>`, and `Exa returned a malformed response body` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **A result with no non-blank highlight is dropped entirely** — there is no portable snippet to map, so fewer sources than requested can return.
- **Only `searchType`, `numResults`, and `highlightsPerResult` are exposed** — Exa's other controls (livecrawl, category, domain and date filters, full-text contents) wait on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **`available()` does not check the key** — readiness is asynchronous, so when several search providers are mounted without `searchProvider`, selection reports `WEB_PROVIDER_AMBIGUOUS` even if only one has a key.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider Exa control surface

Exa's livecrawl, category, domain and date filters, and full-text contents stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
