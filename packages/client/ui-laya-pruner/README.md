---
description: "Web Chat row for Laya context pruning passes: progress while running, then token totals and every judged tool output."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-laya-pruner

English | [中文](README.zh.md)

## Summary

Shows each [Laya pruning pass](../../compaction/compaction-laya-pruner/README.md) as one row in the Web Chat view. While the pass runs, the row shows an animated pixel mark, the measured request size, and the current managed-server phase. When it ends, the row shows the token reduction, the kept, truncated, and dropped counts with the elapsed time, or the fallback reason; expanding it lists every judged tool output. The package only reads Session events; it registers no tool, prompt section, or Host service.

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

Mount it in a Web client composition that provides `uiConversation`, `slots`, and `locale`, beside a Host that runs `@deepseek-ai/dsh-compaction-laya-pruner`. The local Web bundle, `@deepseek-ai/dsh-local-web`, mounts it. It has no configuration fields.

```yaml
- id: ui-laya-pruner
  name: '@deepseek-ai/dsh-client-ui-laya-pruner'
```

### What the row shows

| Pass state | Header |
|---|---|
| Running, pruning phase or no phase reported | `Pruning context · <tokens> tokens` with the animated mark |
| Running, managed phase | `DS4 · freeing cache memory`, `Starting Laya`, `Stopping Laya`, or `DS4 · restoring cache capacity` |
| Pruned | `<before> → <after> tokens (−<pct>%)`, then `<kept> kept · <truncated> truncated · <dropped> dropped · <time>` |
| Fallback | `Skipped · regular compaction decides`, followed by the recorded error when one exists |

The running phase is announced through a polite live region. The header button stays disabled while the pass runs. After the pass ends, expanding the row groups the judged outputs under kept whole, truncated to kept lines, and removed, each sorted by tokens saved; every entry shows its label, its token change, and either its kept line ranges or its line count. A reduced-motion preference stops the pixel animation. Copy ships in Chinese, English, Japanese, Spanish, French, German, Russian, and Portuguese.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

[`src/client/laya-definition.ts`](src/client/laya-definition.ts) registers one Conversation Node Definition that opens a `laya-pruner` Chat node on `laya-pruner/start`, records the phase from each `laya-pruner/progress` while the pass is running, and replaces the state with the totals and items of `laya-pruner/end`. Events of one pass share its `pruneId`. [`src/client/LayaPrunerPanel.tsx`](src/client/LayaPrunerPanel.tsx) renders the node through the `conversation.chat.node` slot, and [`src/client/locales.ts`](src/client/locales.ts) owns the `layaPruner` dictionaries. The Host entry point is empty because the feature is entirely browser-side.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-compaction-laya-pruner](../../compaction/compaction-laya-pruner/README.md) — the pruning pass, its configuration, and the events this row reads.
- [dsh-client-ui-chat](../ui-chat/README.md) — the Chat view that hosts keyed node renderers.

-----

<a id="model-experience"></a>
## Model Experience

None, as the row only renders log-only `laya-pruner/*` Session events in the browser.

#### KV Cache effect

The row adds nothing to any model request, so it leaves every request prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only tool outputs are itemized** — earlier user and agent messages removed by a pass and dropped reasoning are not listed; the counts and the expanded list cover judged tool outputs only.
- **Managed phase labels name DS4** — the release and restore phases read `DS4 · …` for every managed endpoint, including routes served by another local model.
- **The start event must be loaded** — a pass whose `laya-pruner/start` lies outside the loaded event window produces no row.
- **No pruned content** — the expanded list shows labels, token counts, and line ranges, not the text that was kept or removed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/progress.client.spec.tsx` covers progress visibility outside collapsed process groups and the matching of progress events to their pass; run it when changing the Definition or the panel.

</details>
