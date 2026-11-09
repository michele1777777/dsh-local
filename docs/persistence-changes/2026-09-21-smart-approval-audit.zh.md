---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-21-smart-approval-audit

[English](2026-09-21-smart-approval-audit.md) | 中文

## 概述

为现有 approval/decided 审计事件添加可选的独立模型审查元数据。共享 Smart 审批插件不添加新事件或面向主模型的消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

现有记录可以省略 review，仍然有效。outcome 仍然是单次权限结果的权威值；review 只是建议，人工回退或取消后可能与最终结果不同。旧读取器可忽略可选字段，不影响重放。本次同版本变更不改变 Session 头、模型上下文、压缩或现有审批结果。

<a id="verification"></a>
## 验证

独立 Smart 测试在受控传输下使用真实 ApprovalService 和 Cordis waterfall（瀑布式事件），覆盖超时、取消、手动策略、并发审计隔离以及不写入 transcript（文本记录）。本地 TypeScript 5.8.3 源码模式提取仅改变 event:approval/decided。由于本环境无法获取依赖，完整项目 lint 和固定工具链检查仍被阻塞。

<a id="dev-note"></a>
## 开发备注

无。
