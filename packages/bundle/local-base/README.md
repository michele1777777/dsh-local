---
description: "Local-first host layer of this distribution: example OpenAI-compatible local model routes with summary twins, optional Laya pruning, prepared conversations, and Exa and Tavily search."
kind: "package-bundle"
---

# @deepseek-ai/dsh-local-base

English | [中文](README.zh.md)

## Summary

`dsh-local-base` connects dsh to models served on your own hardware. It layers right after [`dsh-base`](../base/README.md) and adds example routes for an OpenAI-compatible local server, a summary route for each of them, optional [Laya](../../compaction/compaction-laya-pruner/README.md) context pruning, [prepared conversations](../../context/prechat/README.md), and the [Exa](../../web/web-search-exa/README.md) and [Tavily](../../web/web-search-tavily/README.md) search providers. Server addresses and keys come from environment variables, so the bundle carries no machine-specific value. The DeepSeek routes and every other `dsh-base` default stay available.

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

| Route | Model | Reasoning | Input | Thinking wire format |
|---|---|---|---|---|
| `qwen-flash` | `qwen3.8-next-flash` | `xhigh` (`off`, `low`, `medium`, `xhigh`) | text, image | `chat_template_kwargs` |
| `qwen-27b` | `qwen3.8-27b` | `xhigh` (`off`, `low`, `medium`, `xhigh`) | text, image | `chat_template_kwargs` |
| `ds4-v4-flash` | `deepseek-v4-flash` | `high` (`off`, `high`, `max`) | text | DeepSeek `thinking` object |
| `ds4-v41-flash` | `deepseek-v4.1-flash` | `high` (`off`, `high`, `max`) | text, image | DeepSeek `thinking` object |

Each route has a `<route>-summary` twin for the same model with reasoning off, text input only, and a 32768-token output budget. Every route declares a 184320-token context window and a 36000-token output budget, so compaction starts near 80% of the window. Match `contextWindow` to the window your server loads. All routes enable [`sessionCache`](../../llm/llm-pi-ai/README.md), so requests carry a Session-derived `prompt_cache_key` and `preserve_context` when a listener asks for it; disable it for servers that reject these fields. Image input requires a server started with the matching image encoder.

Replace or extend the routes with a profile or home patch on the `llm-pi-ai` row. The patch replaces the row's whole `config`, so repeat the routes you keep:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-model:
        api: openai-completions
        baseURL: http://127.0.0.1:8000/v1
        apiKeyEnv: DSH_LOCAL_LLM_API_KEY
        models:
          - id: my-model
            contextWindow: 131072
            maxTokens: 16384
```

Pair each new conversation route with a summary twin and a `modelPolicies` entry on `compaction-basic`, as described below.

### Summary routes

The bundle replaces the host `compaction-basic` row: automatic compaction at 80% of the window, no headroom, 16% of the context retained, and a 32768-token summary budget. It disables the host `tool-result-pruner`, so tool outputs are never trimmed by size. Its `modelPolicies` send each local route's summaries to that route's `-summary` twin, which reaches the same server process and model. Other routes summarize through their own model, as in `dsh-base`. The ACP and headless profiles use this host row; Web and TUI sessions use the equivalent rows in [`dsh-local-presets`](../local-presets/README.md).

The twins exist because a summary request reuses the conversation route's reasoning level, and `compaction-basic` has no reasoning setting. A summary at `xhigh` can spend its whole output budget thinking and return no text, which fails the compaction.

### Laya pruning

`DSH_LAYA=resident` sends each pruning pass to the decision service at `LAYA_URL`; any service that implements the [decision service protocol](../../compaction/compaction-laya-pruner/README.md#decision-service-protocol) works, Laya included. `DSH_LAYA=managed` sends passes for `ds4-v41-flash`, `qwen-flash`, and `qwen-27b` to `<DSH_LOCAL_LLM_URL>/laya/compact`, where a supporting model server runs a temporary decision worker in memory that it lends from its own caches; other routes keep the resident service. Pruning runs at the compaction threshold and keeps verbatim lines; summary compaction still runs when pressure remains. The [local-first guide](../../../docs/user/guide/local-first.md#decision-model-pruning) explains how to connect a decision service.

### Prepared conversations, search, and Auto review

- **`/prechat`** imports a conversation written as `USER:` / `ASSISTANT:` turns as the start of a new chat. It is enabled for `ds4-v41-flash` / `deepseek-v4.1-flash`; set `routes` on the `prechat` row to allow other routes.
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

The bundle is one [`cordis.patch.yml`](cordis.patch.yml) applied after `dsh-base`. It patches the `llm-pi-ai` and `compaction-basic` rows by id, which replaces their `config`, disables `tool-result-pruner`, and inserts the `prechat`, `laya-pruner`, `web-search-exa`, and `web-search-tavily` rows at the root. Each route names its server address and key through `baseURLEnv` and `apiKeyEnv`, which `llm-pi-ai` reads from the launch environment and the credential store; the Laya mode and endpoints are `!!js` expressions over `process.env`, evaluated when the profile loads. Changing a variable takes effect at the next launch.

The `laya-pruner` row runs the host pass for profiles without agent presets when `DSH_LAYA` selects one; otherwise it stays mounted in `mode: projection`, which reconstructs the rewrites of stored sessions. [`dsh-local-presets`](../local-presets/README.md) moves the pass into the standard preset and switches this row to `mode: projection`.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Routes, compaction policy, and inserted rows |
| [`tests/local-base.spec.ts`](tests/local-base.spec.ts) | Route pairing, environment defaults, and the rows composed over `dsh-base` |

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
- **Example values** — context windows, output budgets, and reasoning levels match the reference servers; other servers need their own values.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep `modelPolicies` here and in [`dsh-local-presets`](../local-presets/README.md) identical; the bundle test compares them.

</details>
