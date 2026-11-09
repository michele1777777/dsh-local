---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-smart-approval-audit

English | [中文](2026-09-21-smart-approval-audit.zh.md)

## Summary

Adds optional isolated machine-review metadata to the existing approval/decided audit event. The shared Smart approval plugin does not introduce a new event or model-facing message.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-smart-approval-audit
baseline: false
changes:
  - root: "event:approval/decided"
    previous: "2026-09-11-initial"
    after: "721604861a7232e6f145a892def95c4d4f4d2b7aa270a43d6fd585fd80deedd6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records omit review and remain valid. Outcome remains the authoritative one-shot permission result; review is a recommendation and may differ after human fallback or cancellation. Older readers can ignore the optional field without changing replay. This same-version change does not alter Session headers, model context, compaction, or existing approval outcomes.

<a id="verification"></a>
## Verification

The isolated Smart suite exercises the real ApprovalService and Cordis waterfall with controlled transports: timeout, cancellation, manual policy, concurrent audit isolation and no transcript writes. Source schema extraction with local TypeScript 5.8.3 changes only event:approval/decided. Full project lint and pinned-toolchain checks remain blocked by unavailable dependencies in this environment.

<a id="dev-note"></a>
## Dev Note

None.
