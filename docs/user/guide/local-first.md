# Run DeepSeek Harness on local models

English | [中文](local-first.zh.md)

This distribution adds a terminal app and a set of local-first profile layers to DeepSeek Harness. With them, `dsh` talks to models served on your own hardware through an OpenAI-compatible server, prunes old context with a decision model such as Laya before it summarizes, and searches the web through Exa or Tavily. The DeepSeek API routes and every upstream default remain available.

## What the distribution adds

| Layer | Purpose |
|---|---|
| [`dsh-tui-app`](../../../packages/bundle/tui-app/README.md) | Interactive terminal app over the same Sessions and agent presets as the Web UI |
| [`dsh-local-base`](../../../packages/bundle/local-base/README.md) | Local model routes with summary twins, compaction policy, Laya pruning, `/prechat`, and the Exa and Tavily search providers |
| [`dsh-local-presets`](../../../packages/bundle/local-presets/README.md) | The `standard` agent preset with Laya pruning and summary routes for local models |
| [`dsh-local-web`](../../../packages/bundle/local-web/README.md) | Web panels for Laya and `/prechat`, and the Smart permission preset |

The `tui` profile composes `dsh-base`, `dsh-local-base`, `dsh-tui-app`, and `dsh-local-presets`. The `web`, `acp`, and `headless` profiles keep the upstream composition until you add the local layers, as shown in [Add the layers to other profiles](#add-the-layers-to-other-profiles).

## Prerequisites

- Node.js and pnpm, as listed in the [development guide](../../development.md).
- An OpenAI-compatible server that serves one of the example models, for example `llama.cpp`, vLLM, or TabbyAPI. The server can run on another machine.
- Optional: a [decision service](#decision-model-pruning) for context pruning, or a model server that implements the managed pruning endpoint.

## Start the terminal app

1. Build the checkout:

   ```sh
   pnpm install
   pnpm run build
   ```

2. Point dsh at your model server. Skip `DSH_LOCAL_LLM_URL` when the server listens on `http://127.0.0.1:8080/v1`. Put the exports in your shell profile, such as `~/.bashrc`, so every new terminal has them:

   ```sh
   export DSH_LOCAL_LLM_URL=http://192.0.2.10:8080/v1
   export DSH_LOCAL_LLM_API_KEY=local
   ```

   `DSH_LOCAL_LLM_API_KEY` is sent as the bearer key; set any non-empty value when the server checks no key. The terminal app and the Web UI also read it from the credential store, so instead of exporting it you can save `DSH_LOCAL_LLM_API_KEY` once under **Settings → Models** in the Web UI; the headless profile reads only the environment. dsh refuses `DSH_*` names in `.env` files, because a `.env` inside a cloned project must not choose where your requests go.

3. Start the terminal app and choose a local route with `/model`:

   ```sh
   pnpm dsh --profile tui
   ```

   To open new Sessions on a local route, add this to `$DSH_HOME/profiles/tui/cordis.patch.yml` (`$DSH_HOME` defaults to `~/.dsh`):

   ```yaml
   - id: agent-default-model
     name: '@deepseek-ai/dsh-agent-default-model'
     config:
       provider: ds4-v41-flash
       model: deepseek-v4.1-flash
   ```

<a id="on-windows"></a>
### On Windows

Run the same steps in PowerShell, preferably inside Windows Terminal, which handles the app's colors and mouse input. The differences:

- **Environment variables:** `setx` stores a variable for your user; it applies to terminals opened afterwards.

  ```powershell
  setx DSH_LOCAL_LLM_URL "http://192.0.2.10:8080/v1"
  setx DSH_LOCAL_LLM_API_KEY "local"
  ```

- **Harness home:** `$DSH_HOME` defaults to `%USERPROFILE%\.dsh`; profile and home patches live there.
- **Global command:** to start `dsh` from any directory, save a `dsh.cmd` file in a directory on your `PATH`, with the path of your checkout:

  ```bat
  @node C:\path\to\dsh-local\apps\cli\lib\bin.js %*
  ```

- **Tools:** the agent's shell tools run PowerShell instead of bash. The terminal app copies through PowerShell and opens `notepad.exe` for `Ctrl+G` unless `VISUAL` or `EDITOR` names another editor.

## Local model routes

| Route | Model id | Reasoning levels | Input |
|---|---|---|---|
| `qwen-flash` | `qwen3.8-next-flash` | `off`, `low`, `medium`, `xhigh` | text, image |
| `qwen-27b` | `qwen3.8-27b` | `off`, `low`, `medium`, `xhigh` | text, image |
| `ds4-v4-flash` | `deepseek-v4-flash` | `off`, `high`, `max` | text |
| `ds4-v41-flash` | `deepseek-v4.1-flash` | `off`, `high`, `max` | text, image |

All routes share `DSH_LOCAL_LLM_URL`, so the server answers for whichever model it has loaded. Each route has a `-summary` twin with reasoning off that writes compaction summaries for it. A summary written at a high reasoning level can spend its whole output budget thinking and return no text; the twin prevents that failure. The [`dsh-local-base` README](../../../packages/bundle/local-base/README.md#local-model-routes) lists the context windows and output budgets, and shows how to replace the routes with your own models.

<a id="decision-model-pruning"></a>
## Prune context with a decision model

Before writing a summary, dsh can ask a decision model which older tool outputs and messages to keep, shorten, or drop. Pruning keeps the original text instead of rewriting it. It runs when the context reaches 80% of the window; when context pressure remains afterwards, summary compaction still runs, and a failed or unreachable service changes nothing.

### Connect a decision service

dsh sends each pass to an HTTP service and loads no model itself. Any service that implements the [decision service protocol](../../../packages/compaction/compaction-laya-pruner/README.md#decision-service-protocol) works: a fine-tuned classifier, a language model used as a judge, or fixed rules. The protocol is one `POST /compact` request with the conversation and a token budget, answered with a `KEEP`, `TRUNCATE`, or `DROP` decision per item.

This distribution was developed with Laya, a classifier fine-tuned from `convaiinnovations/laya` (mmBERT-base) that scores every line of each item. Its weights are not published. The `laya_serve.py` service in the Laya repository implements the protocol for checkpoints with Laya's item and line heads; another model needs a service of its own.

Start the service before dsh and keep it on `127.0.0.1` or a trusted private network: the protocol has no authentication.

### Enable pruning

| `DSH_LAYA` | Behavior |
|---|---|
| unset | Pruning off; summary compaction only |
| `resident` | Every pass goes to the decision service at `LAYA_URL` (default `http://127.0.0.1:8766`) |
| `managed` | Passes for `ds4-v41-flash`, `qwen-flash`, and `qwen-27b` go to `<DSH_LOCAL_LLM_URL>/laya/compact`; other routes use `LAYA_URL` |

In `managed` mode, a model server that implements `/v1/laya/compact` (not part of this distribution; it requires a patched server) runs a temporary decision worker in memory it lends from its own caches and restores that memory afterwards, so no resident service holds GPU memory between passes. The [pruner README](../../../packages/compaction/compaction-laya-pruner/README.md) documents both endpoint types, the progress phases, and the fallback.

## Web search with Exa or Tavily

Both providers are mounted by `dsh-local-base`. Select one in `$DSH_HOME/cordis.patch.yml` and export its key:

```yaml
- id: web
  config:
    searchProvider: exa
    fetchProvider: http
```

```sh
export EXA_API_KEY=...
```

Use `searchProvider: tavily` with `TAVILY_API_KEY` for Tavily. Without a key, the `web_search` tool is not offered. The [Exa](../../../packages/web/web-search-exa/README.md) and [Tavily](../../../packages/web/web-search-tavily/README.md) READMEs list their options.

<a id="add-the-layers-to-other-profiles"></a>
## Add the layers to other profiles

Edit the `bundles` list in `$DSH_HOME/profiles/<name>/package.json`. The order matters: each layer patches rows that earlier layers insert.

| Profile | Bundles |
|---|---|
| `web` | `dsh-base`, `dsh-local-base`, `dsh-web-app`, `dsh-local-web`, `dsh-local-presets` |
| `acp` | `dsh-base`, `dsh-local-base`, `dsh-acp-app` |
| `headless` | `dsh-base`, `dsh-local-base`, `dsh-headless` |

Each entry is the full package name, for example `@deepseek-ai/dsh-local-base`. Check the result without starting the app:

```sh
pnpm dsh --profile web --dump-config
```

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `DSH_LOCAL_LLM_URL` | `http://127.0.0.1:8080/v1` | Every local route and managed pruning endpoints |
| `DSH_LOCAL_LLM_API_KEY` | none | Every local route |
| `DSH_LAYA` | unset | Pruning mode: `resident` or `managed` |
| `LAYA_URL` | `http://127.0.0.1:8766` | Resident decision service |
| `EXA_API_KEY` | none | Exa search |
| `TAVILY_API_KEY` | none | Tavily search |

Variables are read when a profile loads; restart `dsh` after changing them.
