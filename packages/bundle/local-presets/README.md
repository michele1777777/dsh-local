---
description: "Local-first standard agent preset of this distribution: the shipped standard preset with Laya pruning, summary routes for local models, and no tool-result pruning."
kind: "package-bundle"
---

# @deepseek-ai/dsh-local-presets

English | [中文](README.zh.md)

## Summary

`dsh-local-presets` adapts the `standard` agent preset to local models. It keeps the shipped standard composition and changes only its compaction group: [Laya](../../compaction/compaction-laya-pruner/README.md) pruning runs before summary compaction when `DSH_LAYA` selects it, local routes summarize through their reasoning-off `-summary` twins from [`dsh-local-base`](../local-base/README.md), and the tool-result pruner stays off so that verbatim pruning decides which tool outputs remain. The `ptc`, `minimal`, and `cordis` presets are unchanged.

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

List the bundle last, after the app bundle that declares the presets and after [`dsh-local-base`](../local-base/README.md). The shipped `tui` profile uses this order:

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-local-base", "@deepseek-ai/dsh-tui-app", "@deepseek-ai/dsh-local-presets"]
```

A Web profile lists `@deepseek-ai/dsh-web-app`, then [`@deepseek-ai/dsh-local-web`](../local-web/README.md), then this bundle. The standard preset then behaves as follows:

| Row | Setting |
|---|---|
| `laya-pruner` | Enabled when `DSH_LAYA` is `resident` or `managed`; same 80% threshold as compaction, 25% target, 120-second timeout |
| `compaction-basic` | Automatic at 80%, 16% retained, 32768-token summaries; local routes summarize through their `-summary` twin |
| `tool-result-pruner` | Disabled |
| Every other row | As in the Web app's `presets/standard.patch.yml` |

The environment variables and routes are described in [`dsh-local-base`](../local-base/README.md#environment-variables). Existing Sessions pick up the new composition at their next load.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) patches two rows by id. It replaces the `config` of `preset-standard` with a complete copy of the standard preset whose compaction group contains the changes above, because rows nested inside a preset's configuration cannot be patched by id. It also sets the host `laya-pruner` row from `dsh-local-base` to `mode: projection`: the pass runs once per Session inside the preset, and the host keeps the rewrite projection so that stored Sessions with Laya rewrites resume before their session plugins load.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The standard preset copy and the host projection switch |
| [`tests/local-presets.spec.ts`](tests/local-presets.spec.ts) | Parity with the Web app's standard preset outside the compaction group |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Local-first distribution guide](../../../docs/user/guide/local-first.md) — setup, profiles, and context pruning with a decision model.
- [`dsh-web-app` presets](../web-app/README.md) — the shipped preset declarations this bundle tracks.
- [`dsh-agent-preset`](../../preset/agent-preset/README.md) — how a preset composes per-Session plugins.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the preset's rows. Laya removes or shortens older history verbatim before any summary; summaries come from a reasoning-off route for the same model. Tool results are no longer trimmed by size.

#### KV Cache effect

Laya rewrites invalidate the KV prefix after the first changed line, as summary compaction does. Without the tool-result pruner, large tool outputs stay in the prefix until Laya or compaction removes them.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Full preset copy** — the bundle repeats the standard preset; changes to the Web app's `presets/standard.patch.yml` must be carried over by hand, and the bundle test fails until they are.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

After merging upstream changes to `packages/bundle/web-app/presets/standard.patch.yml`, copy them into this bundle and run its test.

</details>
