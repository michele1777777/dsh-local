---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-laya-pruner-and-prechat-sources

English | [中文](2026-11-08-laya-pruner-and-prechat-sources.zh.md)

## Summary

Adds the Laya context pruner's log events `laya-pruner/start` and `laya-pruner/end` (one verbatim pruning pass and its per-item decisions), the `laya-pruner/rewrite` message projection (kept text lines and dropped reasoning of current agent messages), and the attribution-only `laya-pruner` message source kind used by its removal notices and truncated-message relays; and attributes prepared conversation user messages to the prechat importer through an attribution-only `prechat` source kind.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-laya-pruner-and-prechat-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "4866a55ed9db9a26e4307c47928da28e1fd5e7d576670e71ad3748ae3bcce134"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "695c89089a34c37ac3802d8fd85dcc1ebcde8570171bb2f0ded7726977c2cfbe"
    decision: same-version
  - root: "event:laya-pruner/end"
    previous: null
    after: "c913b1f76ada4545b08378303c87946617271b247cc7c57fdbb0f0d537a6a0a5"
    decision: same-version
  - root: "event:laya-pruner/rewrite"
    previous: null
    after: "901caf7fcab1bfdd36f7ab128476c344e36c7fb123cde49437085e40737dc532"
    decision: same-version
  - root: "event:laya-pruner/start"
    previous: null
    after: "844f4e5cda61a8ad9eb56e5fdebdb957885a06547376a81e0e934cd62cf5f235"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "0a16720171d425716131b280ffa63195f051ea7904749a92c2284172de51c9e8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "fbb1f43601d315321f0da2829e875f0658749383e842d07a0fc1f1a58281cf1f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All changes are additions allowed within format 4: new event types and two attribution-only source kinds; existing message and event structures keep their fields. Older readers accept the open source-kind discriminator and keep the notices, relays and imported messages as ordinary user-role context with their text; newer readers also attribute them and reconstruct the imported-message count. Neither source kind has executable semantics or required fields, and assistant messages keep the existing model source. `laya-pruner/rewrite` is a message projection, so a Session containing it is derived only where its projection is registered; the TUI and Web bundles register it at host level, and `@deepseek-ai/dsh-session-format-catalog` includes it in `currentSessionMessageProjections` for detached replay. No Session format version change is needed.

<a id="verification"></a>
## Verification

`pnpm run gen-persistence-catalog` regenerates the catalog with the three event types and both source kinds; `pnpm run verify-persistence-changes` passes with this record on top of the current history; `packages/compaction/compaction-laya-pruner/tests` cover the projection, replay through `Session.create` and `foldSurface`, token-meter repricing and a pruning pass against a fake service; the prechat import, command and model-selection suites and the keyless production-profile Loader smoke cover imported roles in the outgoing request.

<a id="dev-note"></a>
## Dev Note

None.
