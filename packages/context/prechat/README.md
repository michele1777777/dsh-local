---
description: "Import a prepared conversation into a new session on a configured model route."
kind: "package-reference"
---
# @deepseek-ai/dsh-prechat

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-prechat` provides `/prechat`, which seeds a new chat with prepared `USER:` / `ASSISTANT:` turns. The command is available only on the provider/model routes listed in its `routes` configuration; it is hidden and rejected on every other route.

## Table of Contents

- [Use](#use)
- [Configure routes](#configure-routes)
- [Failure and lifecycle](#failure-and-lifecycle)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use"></a>
## Use

Enter `/prechat` and paste text or a quoted `.txt` path in the terminal. `/prechat /path/to/chat.txt` opens the preview directly; a relative path resolves against the session's working directory. Large terminal pastes expand from their displayed placeholder before parsing. The Web editor accepts pasted text, file selection, and one dropped `.txt` file.

```text
USER: Help me practise fractions with short examples.
ASSISTANT: We can work through one example at a time.
USER: Explain one half plus one quarter.
ASSISTANT: One half is two quarters, so the sum is three quarters.
```

Role markers must start a line. Content may span multiple lines. Messages alternate between `USER:` and `ASSISTANT:` and end with an assistant message; an incomplete pair or an empty message leaves the input available for correction. Input is UTF-8 and limited to 256 KiB. A line beginning with a role marker always starts the next message.

Review the preview, then choose **Apply**, **Edit**, or **Cancel**. Apply creates a new saved chat and navigates to it; the previous chat remains intact. No model request runs until the user sends their next question. The Web editor uses `/prechat --apply` followed by a newline and the reviewed transcript; this explicit apply form also works from the terminal.

The imported count remains visible after reopening. Selecting another model opens a fresh chat without the imported history. Requests from an imported session to any route outside `routes` are rejected, including after context compaction.

<a id="configure-routes"></a>
## Configure routes

```yaml
- name: '@deepseek-ai/dsh-prechat'
  config:
    routes:
      - provider: my-provider
        model: my-model
```

| Field | Default | Meaning |
|---|---|---|
| `routes` | `[]` | Provider/model pairs that accept imported conversations. A route matches only when both `provider` and `model` are equal. An empty list leaves `/prechat` unavailable. |

Prepared histories are written for one model's turn format, so list only the routes they were written for. Error messages name the allowed routes as a comma-separated `provider/model` list.

<a id="failure-and-lifecycle"></a>
## Failure and lifecycle

Parsing, size, encoding, route and busy-session checks occur before a new session is created. Cancel leaves the current session intact. The agent factory owns rollback before publication; a persistence or workspace-attachment failure after publication may leave the new session in the session list and is reported as an import failure. Registrations belong to the plugin's Cordis lifetime.

<a id="model-experience"></a>
## Model Experience

### Imported conversation history

#### What the model sees

The next request contains the imported text as ordinary alternating user and assistant messages, followed by the user's new question. It is conversation history, not activation steering or an extra system prompt. The prepared assistant messages were authored by the user; the interface identifies the import. Import does not guarantee a particular model response. The session log owns the imported messages and completed turns. User messages carry `source.kind: prechat`; assistant messages carry the ordinary model source with `provider: prechat` and `model: imported`. Replaying the log reconstructs both the messages and the count projection.

#### Token effect

Imported text increases input tokens in the next request and remains until compaction.

#### KV Cache effect

Import creates a new session. The server may reuse an identical prefix, but import does not run a prefill.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Plain-text turns only** — tool calls, reasoning and message attachments cannot be imported, and roles must alternate from `USER:` to a final `ASSISTANT:`.
- **Bound to the configured routes** — an imported session cannot continue on another model; selecting one opens a fresh chat without the imported history.
- **256 KiB of UTF-8 input** — larger conversations must be shortened before import.
- **No response guarantee** — imported assistant turns are user-authored examples, and the model may answer differently from them.
- **Partial failure after publication** — a persistence or workspace-attachment failure after the new session is published can leave that session in the session list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
