---
description: "Web paste, file input and preview for prepared conversations imported with /prechat."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-prechat

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-ui-prechat` decorates the Host's `/prechat` command with a per-session editor. The local Web bundle, `@deepseek-ai/dsh-local-web`, mounts it. Availability and final validation belong to the [Host importer](../../context/prechat/README.md).

## Table of Contents

- [Use](#use)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use"></a>
## Use

Enter `/prechat` while a route listed in the Host importer's `routes` configuration is selected. Paste the transcript, choose a `.txt` file, or drop one file into the dialog. Preview shows the roles and complete content. Edit returns to the text; cancel discards the draft. Apply remains disabled during submission and opens the newly saved session on success. A failure preserves the draft and its preview. Slow file reads cannot overwrite newer edits, and session disposal removes its draft.

An imported-message notice is restored from the session projection when reopening a chat. Model selection navigates to the fresh session returned by the Host when leaving the supported route.

<a id="model-experience"></a>
## Model Experience

### Imported conversation history

#### What the model sees

The dialog itself sends no model request. Apply submits the reviewed text to `/prechat`; the [Host package](../../context/prechat/README.md#model-experience) defines the durable messages seen by the model.

#### Token effect

Imported text increases input tokens in the next request and remains until compaction.

#### KV Cache effect

Import creates a new session. The server may reuse an identical prefix, but import does not run a prefill.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Host rules apply** — only plain-text alternating turns on the configured routes can be imported; the [Host importer](../../context/prechat/README.md#known-limitations-and-deferred-work) owns those limits.
- **One `.txt` file of at most 256 KiB** — the dialog refuses other extensions, files that are not valid UTF-8, larger files, and drops of more than one file.
- **Drafts stay in the browser tab** — an unapplied draft lives in memory for its session; reloading the page or disposing the session discards it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
