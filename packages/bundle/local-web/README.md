---
description: "Web additions of the local-first distribution: Laya pruning and prepared-conversation panels and the Smart permission preset."
kind: "package-bundle"
---

# @deepseek-ai/dsh-local-web

English | [中文](README.zh.md)

## Summary

`dsh-local-web` adds the browser side of the local-first distribution to a Web profile. It mounts the [Laya pruning panel](../../client/ui-laya-pruner/README.md), the [prepared-conversation editor](../../client/ui-prechat/README.md), and the [Smart](../../interaction/smart-approval/README.md) permission preset. The host capabilities those panels display come from [`dsh-local-base`](../local-base/README.md).

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

List the bundle after `@deepseek-ai/dsh-web-app` and before [`@deepseek-ai/dsh-local-presets`](../local-presets/README.md) in `$DSH_HOME/profiles/web/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-local-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-local-web", "@deepseek-ai/dsh-local-presets"]
    }
  }
}
```

The conversation then shows each Laya pass with its phases, totals, and the kept and pruned outputs; `/prechat` opens the editor for a prepared conversation; and the permission menu offers **Smart**, in which a reviewer model approves routine calls and asks you about the rest. Sessions stay on their current permission preset until you switch.

| Smart setting | Value |
|---|---|
| `timeoutMs` | 20000 |
| `maxInputChars` / `maxOutputChars` | 48000 |
| `maxOutputTokens` | 4096 |
| `maxConcurrentReviews` | 2 |
| `humanOnlyTools` | `run_code` |
| `escalatingTools` | `plugin_manager` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the `ui-laya-pruner`, `ui-prechat`, and `smart-approval` rows at the root of the Web profile. The client rows render events that the `laya-pruner` and `prechat` host rows write to the Session log; without those host rows the panels stay empty.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The inserted client rows and the Smart preset |
| [`tests/local-web.spec.ts`](tests/local-web.spec.ts) | Inserted rows and their packages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Local-first distribution guide](../../../docs/user/guide/local-first.md) — setup, profiles, and context pruning with a decision model.
- [`dsh-web-app`](../web-app/README.md) — the Web application layer this bundle extends.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Smart preset, whose reviewer model reads pending tool calls; the panels are not model-visible.

#### KV Cache effect

None for the conversation; Smart reviews run as separate requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web only** — the terminal app inserts its own Smart preset row and renders Laya passes without these client packages.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
