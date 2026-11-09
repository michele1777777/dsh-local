---
description: "Configure local Laya context pruning, temporary DS4 memory sharing, progress feedback, and summary fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-laya-pruner

English | [中文](README.zh.md)

## Summary

Prune older context with Laya before paying for a model-generated summary. Keep Laya resident when memory permits, or let a DS4.1 server start it temporarily while lending expert-cache memory. Web and TUI show each managed phase. Failed or insufficient pruning still allows ordinary summary compaction.

## Table of Contents

- [Use this package](#use-this-package)
- [Decision service protocol](#decision-service-protocol)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Runs Laya pruning before ordinary summary compaction. Mount the pass beside `compaction-basic`, with matching `thresholdRatio` and `headroomTokens`; mount `mode: projection` on hosts that read stored sessions without the pass.

`url` selects the resident Laya service; requests go to `/compact`. `modelEndpoints` overrides the complete request URL for an exact provider/model pair. Unmatched routes retain the resident service. The local bundles run the pass only when `DSH_LAYA` is `resident` or `managed`, with the resident service at `LAYA_URL` (default `http://127.0.0.1:8766`); otherwise they mount the row in `mode: projection`, so stored sessions with rewrites still resume. With `DSH_LAYA=managed` they also route `ds4-v41-flash` / `deepseek-v4.1-flash`, `qwen-flash` / `qwen3.8-next-flash`, and `qwen-27b` / `qwen3.8-27b` to the local model server's `/laya/compact` endpoint under `DSH_LOCAL_LLM_URL` (default `http://127.0.0.1:8080/v1`); every other route keeps the resident service.

A managed endpoint owns worker startup, shutdown and model-memory restoration. It must stop and reap the temporary Laya process and restore memory before returning success or failure. The server must serialize this operation with inference, including after a client timeout or disconnect. This distribution ships no such server: the endpoint requires a model server patched to implement it, such as a DS4 build that accepts a trusted worker through `--compaction-worker PATH`.

Service failures and ineffective pruning leave summary compaction eligible. After successful pruning, `compaction-basic` remeasures context pressure and summarizes if its threshold is still exceeded. Pruning never disables this fallback. Cancellation retains the existing agent cancellation behavior.

Managed endpoints report progress phases through the [streamed response](#decision-service-protocol). Progress is persisted for Web/TUI display and does not enter model input; reduced-motion preferences disable the Web pixel animation.

<a id="decision-service-protocol"></a>
## Decision service protocol

The pass works with any service that implements this HTTP protocol; it loads no model itself. Laya is one implementation. Another classifier, a model used as a judge, or fixed rules can answer the same request. `url` and `modelEndpoints` select the service.

### Request

dsh sends `POST {url}/compact`, or the complete `modelEndpoints` URL, with a JSON body. The request times out after `timeoutMs`.

| Field | Meaning |
|---|---|
| `events` | The current conversation in order, without system instructions |
| `target_tokens` | Tokens the whole request should occupy after the pass: `targetRatio` of the context window |
| `fixed_tokens` | Estimated tokens of request content outside the judged text, such as tool definitions and protected parts |
| `min_budget_tokens` | Tokens always given to the best judged items: `minBudgetRatio` of the context window |

Each event has these fields:

| Field | Meaning |
|---|---|
| `role` | `user` or `assistant`; tool outputs arrive in `user` events with empty `text` |
| `text` | The message text |
| `tool_uses` | Tool calls of an `assistant` event: `{ "id", "name", "input" }`; `input` is the parsed arguments, or `{ "raw", "parseError" }` when they are not valid JSON |
| `tool_results` | Tool outputs: `{ "id", "text", "is_error" }`; `id` is the tool-call id |
| `context` | `true` for a user-role message produced by dsh rather than typed by the user, such as the runtime context |
| `pinned` | `true` for the current user request and the latest context message of each producer; their decisions are ignored |

### Response

A service answers with `{ "items": [...] }`, one item per judged tool output or message. Items it omits stay unchanged.

| Field | Meaning |
|---|---|
| `id` | Required. The tool-call id for a tool output, or `m<index>` for the message at that position in `events` |
| `kind` | Required. `tool` for a tool output; any other string for a message |
| `action` | Required. `KEEP`, `TRUNCATE` to keep only `keep_lines`, or `DROP` |
| `lines` | Required. The line count of the judged text |
| `keep_lines` | 1-based inclusive `[start, end]` ranges within `lines`; default `[]` |
| `tokens_before`, `tokens_after` | Optional non-negative integers shown in the Web and TUI reports; default `0` |
| `label` | Optional text shown in the reports; default empty |

dsh validates the whole answer before it changes anything. A non-2xx status, a timeout, or one invalid item changes nothing and leaves summary compaction to decide.

A service can instead answer with `content-type: application/x-ndjson`: zero or more `{ "phase": "release" | "start" | "prune" | "stop" | "restore" }` records, then one `{ "result": { "items": [...] } }` or `{ "error": "message" }` record. dsh records each phase for the progress display, waits for the terminal record and the end of the stream, and rejects streams over 16 MiB.

### Example

```json
{
  "events": [
    { "role": "user", "text": "Fix the failing test", "tool_uses": [], "tool_results": [] },
    { "role": "assistant", "text": "", "tool_uses": [{ "id": "call_1", "name": "bash", "input": { "command": "npm test" } }], "tool_results": [] },
    { "role": "user", "text": "", "tool_uses": [], "tool_results": [{ "id": "call_1", "text": "...", "is_error": false }] },
    { "role": "user", "text": "Now update the changelog", "tool_uses": [], "tool_results": [], "pinned": true }
  ],
  "target_tokens": 46080,
  "fixed_tokens": 12000,
  "min_budget_tokens": 46080
}
```

```json
{
  "items": [
    { "id": "call_1", "kind": "tool", "action": "TRUNCATE", "lines": 120, "keep_lines": [[1, 3], [98, 120]], "label": "bash npm test" },
    { "id": "m0", "kind": "user_msg", "action": "KEEP", "lines": 1 }
  ]
}
```

### What dsh applies

- **Truncated output** keeps the chosen lines; each removed gap becomes one note line. In a file `read` output, the note names the hidden file lines and the `read` call that restores them.
- **Dropped output** becomes `[laya_context_pruner: output removed (N lines); re-run the tool if needed]`.
- **Dropped messages** are removed. An assistant message is removed with its tool calls only when every one of its outputs is dropped too. Removals keep tool calls paired with their results and never touch the system prompt.
- **Ignored decisions:** pinned events, the latest call of each `pinnedTools` tool, ids that match no event, and `TRUNCATE` on an output that an earlier pass already shortened.
- **Reasoning:** earlier agent reasoning is dropped in the same pass according to `keepReasoning`, whatever the service answers.

<a id="model-experience"></a>
## Model Experience

### Pruned conversation history

#### What the model sees

When a step-boundary request reaches `thresholdRatio` of the routed context window or the headroom cap, the next request carries the pruned surface. Laya selects verbatim lines or removes eligible history; it generates no summary text. A removed span becomes one user message beginning `[laya_context_pruner: removed`, which counts the earlier messages and tool outputs it replaces; a dropped tool output becomes `[laya_context_pruner: output removed (N lines); re-run the tool if needed]`; a truncated tool output or user message keeps its chosen lines with gap notes such as `[... N lines pruned by laya_context_pruner ...]`, and in a file `read` output the note names the hidden file lines and the `read` offset and limit that restore them. Closed agent reasoning is dropped according to `keepReasoning`. The system prompt, the latest user request, the latest call of each `pinnedTools` tool, and tool-call pairing are never pruned. Durable `compaction/prune` events with their replacement `tool/result` or `user/message` events, and `laya-pruner/rewrite` events, reconstruct every change.

#### Token effect

A successful pass reduces input toward `targetRatio` of the context window by replacing judged history with kept lines and short notes. The Laya service call is not a DSH model request and adds no model tokens. If pressure still exceeds `compaction-basic`'s threshold, ordinary summary compaction makes its additional model request.

#### KV Cache effect

Replacing rather than append-only: each pass invalidates reuse from the first changed history message, while the unchanged prefix before it remains reusable. A managed DS4 server retains its model and KV during the temporary worker but must prefill the changed history afterward; restoring cache capacity does not eagerly reload every evicted expert, and demand reads refill it as inference resumes.

### Pruning progress records

#### What the model sees

Nothing: `laya-pruner/start`, `laya-pruner/progress`, and `laya-pruner/end` are log-only events that Web and TUI display, and they never enter a model request.

#### Token effect

None; the records add no request content.

#### KV Cache effect

None; the records leave every request prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Temporary Laya requires the Linux CUDA V4.1 SSD-streaming server in unbatched mode with sufficient reclaimable cache memory. Its endpoint returns an error if admission fails; ordinary summary fallback remains available. A cache-restoration failure stops the server because further inference is unsafe; restart it before continuing. The default request timeout is 120 seconds, and the server bounds worker execution to 110 seconds before cleanup. A timeout can leave cleanup briefly in progress; inference remains serialized behind it.

<a id="dev-note"></a>
### Dev Note

Run the package tests and the `laya-managed-progress` recorded session when changing lifecycle handling. The `laya-managed-progress` SDK scenario projects the same fallback and phases through the public protocol.
