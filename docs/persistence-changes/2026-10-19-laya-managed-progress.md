---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-laya-managed-progress

English | [中文](2026-10-19-laya-managed-progress.zh.md)

## Summary

Adds observed cache and worker lifecycle phases for managed Laya pruning.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-laya-managed-progress
baseline: false
changes:
  - root: "event:laya-pruner/progress"
    previous: null
    after: "aafcbeac8594732d10ff0507e2f4633dad8e4568a0d412104fa044db3e86eb0a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. The progress event is informational and never changes model history. New readers replay older sessions without progress. Older readers reject an unknown required event instead of reconstructing it incorrectly; no downgrade support is introduced.

<a id="verification"></a>
## Verification

Focused Laya stream and Loader/AgentLoop fallback tests, web phase rendering tests, and TUI transcript tests cover lifecycle order and terminal settlement.

<a id="dev-note"></a>
## Dev Note

None.
