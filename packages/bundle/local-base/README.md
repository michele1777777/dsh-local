---
description: "Local-first host layer of this distribution: summary twins and managed Laya for the local routes you declare, optional Laya pruning, prepared conversations, and Exa and Tavily search."
kind: "package-bundle"
---

# @deepseek-ai/dsh-local-base

English | [中文](README.zh.md)

## Summary

`dsh-local-base` connects dsh to models served on your own hardware. It layers right after [`dsh-base`](../base/README.md) and turns the local routes you declare for an OpenAI-compatible local server into summary compaction through each route's twin, optional [Laya](../../compaction/compaction-laya-pruner/README.md) context pruning, [prepared conversations](../../context/prechat/README.md), and the [Exa](../../web/web-search-exa/README.md) and [Tavily](../../web/web-search-tavily/README.md) search providers. The bundle names no model: the routes live in your own patch layer, and server addresses and keys come from environment variables, so the bundle carries no machine-specific value. The DeepSeek routes and every other `dsh-base` default stay available.

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

The shipped `tui` profile already lists this bundle. To add it to another base-backed profile, list it immediately after `@deepseek-ai/dsh-base` in that profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-local-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-local-web", "@deepseek-ai/dsh-local-presets"]
    }
  }
}
```

The file is `$DSH_HOME/profiles/<name>/package.json`. Profiles that compose the Web app's agent presets (`web`, `tui`) also list [`dsh-local-presets`](../local-presets/README.md) after the app bundle; the Web profile adds [`dsh-local-web`](../local-web/README.md) before it.

<a id="environment-variables"></a>
### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DSH_LOCAL_LLM_URL` | `http://127.0.0.1:8080/v1` | Base URL of the OpenAI-compatible server shared by every local route, read through each route's `baseURLEnv` |
| `DSH_LOCAL_LLM_API_KEY` | none | Key sent to that server; set any non-empty value when the server checks no key |
| `DSH_LAYA` | unset | `resident` or `managed` enables pruning with a decision service; unset leaves it off, while stored sessions with pruning rewrites still resume |
| `LAYA_URL` | `http://127.0.0.1:8766` | Resident decision service used by `resident` and by routes without a managed endpoint |

A route whose key variable is unset is still listed; its requests fail with a missing-key error until the variable is set.

<a id="local-model-routes"></a>
### Local model routes

The routes belong to the machine, not to the bundle. Declare them in `$DSH_HOME/cordis.patch.yml` (every profile) or `$DSH_HOME/profiles/<name>/cordis.patch.yml` (one profile), in two rows:

```yaml
# What the bundle builds from: one entry per conversation route on the local server.
- id: local-models
  config:
    routes:
      - provider: my-model            # an llm-pi-ai provider route
        model: my-model               # one of its model ids
        summary: my-model-summary     # optional: reasoning-off twin that writes the compaction summaries
        laya: true                    # optional: the server answers POST /v1/laya/compact (DSH_LAYA=managed)
        prechat: true                 # optional: the route accepts /prechat conversations

# The routes themselves. The patch replaces the row's whole config, so list every route here.
- id: llm-pi-ai
  config:
    providers:
      my-model:
        api: openai-completions
        baseURL: http://127.0.0.1:8080/v1
        baseURLEnv: DSH_LOCAL_LLM_URL
        apiKeyEnv: DSH_LOCAL_LLM_API_KEY
        sessionCache: true
        models:
          - id: my-model
            contextWindow: 131072
            maxTokens: 16384
      my-model-summary:
        api: openai-completions
        baseURL: http://127.0.0.1:8080/v1
        baseURLEnv: DSH_LOCAL_LLM_URL
        apiKeyEnv: DSH_LOCAL_LLM_API_KEY
        reasoning: 'off'
        models:
          - id: my-model
            contextWindow: 131072
            maxTokens: 32768
```

The `local-models` row never mounts; `!!js` expressions in this bundle and in [`dsh-local-presets`](../local-presets/README.md) read it when the profile loads, so its values must be literals. Give a twin the same model id, reasoning off and text input, and keep `contextWindow` equal to the window your server loads. [`sessionCache`](../../llm/llm-pi-ai/README.md) makes requests carry a Session-derived `prompt_cache_key` and `preserve_context` when a listener asks for it; leave it off for servers that reject these fields.

### Summary routes

The bundle replaces the host `compaction-basic` row: automatic compaction at 80% of the window, no headroom, 16% of the context retained, and a 32768-token summary budget. It disables the host `tool-result-pruner`, so tool outputs are never trimmed by size. Its `modelPolicies` send the summaries of each `local-models` route with a `summary` to that twin, which reaches the same server process and model. Other routes summarize through their own model, as in `dsh-base`. The ACP and headless profiles use this host row; Web and TUI sessions use the equivalent rows in [`dsh-local-presets`](../local-presets/README.md).

The twins exist because a summary request reuses the conversation route's reasoning level, and `compaction-basic` has no reasoning setting. A summary at `xhigh` can spend its whole output budget thinking and return no text, which fails the compaction.

### Laya pruning

`DSH_LAYA=resident` sends each pruning pass to the decision service at `LAYA_URL`; any service that implements the [decision service protocol](../../compaction/compaction-laya-pruner/README.md#decision-service-protocol) works, Laya included. `DSH_LAYA=managed` sends passes for the `local-models` routes marked `laya` to `<DSH_LOCAL_LLM_URL>/laya/compact`, where a supporting model server runs a temporary decision worker in memory that it lends from its own caches; other routes keep the resident service. Pruning runs at the compaction threshold and keeps verbatim lines; summary compaction still runs when pressure remains. The [local-first guide](../../../docs/user/guide/local-first.md#decision-model-pruning) explains how to connect a decision service.

### Prepared conversations, search, and Auto review

- **`/prechat`** imports a conversation written as `USER:` / `ASSISTANT:` turns as the start of a new chat. It is enabled for the `local-models` routes marked `prechat`.
- **Exa and Tavily** register as web search providers. Select one with `searchProvider` on the `web` row of a profile or home patch and supply its key as described in its README.
- **Auto** is the experimental permission preset in which an LLM reviewer authorizes each tool call. It is not part of this bundle; add `@deepseek-ai/dsh-experimental-auto-review` to a profile as described in [its README](../../experimental/auto-review/README.md). With local routes, skip review for local reads and run reviews with reasoning off by adding this to the profile or home patch:

```yaml
- id: auto-review
  config:
    trustedTools: [read, read_image, glob, grep]
    reasoningEffort: 'off'
    logFile: !!js dshHomePath('auto-review.jsonl')
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one [`cordis.patch.yml`](cordis.patch.yml) applied after `dsh-base`. It inserts the disabled `local-models` data row, patches the `compaction-basic` row by id, which replaces its `config`, disables `tool-result-pruner`, and inserts the `prechat`, `laya-pruner`, `web-search-exa`, and `web-search-tavily` rows at the root. The compaction policies, the `/prechat` routes and the Laya mode and endpoints are `!!js` expressions over `process.env` and the composed `local-models` row (found through the loader's entry tree), evaluated when the profile loads. Changing a variable or the user patch takes effect at the next launch.

The `laya-pruner` row runs the host pass for profiles without agent presets when `DSH_LAYA` selects one; otherwise it stays mounted in `mode: projection`, which reconstructs the rewrites of stored sessions. [`dsh-local-presets`](../local-presets/README.md) moves the pass into the standard preset and switches this row to `mode: projection`.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The `local-models` data row, compaction policy, and inserted rows |
| [`tests/local-base.spec.ts`](tests/local-base.spec.ts) | Values derived from `local-models`, environment defaults, and the rows composed over `dsh-base` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Local-first distribution guide](../../../docs/user/guide/local-first.md) — setup, profiles, and context pruning with a decision model.
- [`dsh-local-presets`](../local-presets/README.md) — the standard preset with Laya and summary routes.
- [`dsh-local-web`](../local-web/README.md) — the Web panels for Laya and prepared conversations.
- [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) — every route field, including `compat` and `sessionCache`.
- [`dsh-compaction-basic`](../../compaction/compaction-basic/README.md) — thresholds and `modelPolicies`.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through each inserted row's package and the selected route. The routes change which model serves the conversation and which model writes summaries; the inserted packages own their prompts and tools.

#### KV Cache effect

The bundle adds no request prefix. Session cache keys let a local server reuse the KV prefix of a Session across requests, and Laya pruning invalidates the prefix after the first changed line.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One provider dictionary** — a later patch on `llm-pi-ai` replaces every route; Cordis patches cannot add one route to the dictionary.
- **One model per server** — all routes share `DSH_LOCAL_LLM_URL`; selecting a route for a model the server has not loaded fails at the server.
- **Literal data** — `local-models` is read as written, so a `!!js` value in it is not evaluated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep `modelPolicies` here and in [`dsh-local-presets`](../local-presets/README.md) identical; the bundle test compares them.

</details>
