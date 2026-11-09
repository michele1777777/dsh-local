---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-laya-managed-progress

[English](2026-10-19-laya-managed-progress.md) | 中文

## 概述

为受管理的 Laya 裁剪添加实际缓存与工作进程生命周期阶段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

现有记录仍然有效。进度事件仅供参考，不改变模型历史。新读取器可回放没有进度事件的旧会话；旧读取器会拒绝未知的必需事件，而非错误重建会话。不增加降级支持。

<a id="verification"></a>
## 验证

Laya 流与 Loader/AgentLoop 回退测试、网页阶段渲染测试和 TUI 记录测试覆盖生命周期顺序及结束状态。

<a id="dev-note"></a>
## 开发备注

无。
