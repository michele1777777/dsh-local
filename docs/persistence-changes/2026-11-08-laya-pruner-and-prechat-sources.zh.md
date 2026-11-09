---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-laya-pruner-and-prechat-sources

[English](2026-11-08-laya-pruner-and-prechat-sources.md) | 中文

## 概述

新增 Laya 上下文剪枝器的日志事件 `laya-pruner/start` 与 `laya-pruner/end`（一次逐字剪枝流程及其逐项决策）、消息投影 `laya-pruner/rewrite`（保留的文本行与当前代理消息中被丢弃的推理），以及其移除提示和截断消息转述使用的仅归属来源类型 `laya-pruner`；并通过仅归属来源类型 `prechat` 将预先准备的对话用户消息归属到 prechat 导入器。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

所有变更均为格式 4 内允许的新增：新的事件类型与两种仅归属的来源类型；现有消息和事件结构保持其字段不变。旧读取方接受开放的来源 kind 判别值，并把提示、转述和导入消息连同文本视为普通用户角色上下文；新读取方还会为其标注来源并重建导入消息计数。两种来源类型都没有可执行语义或必填字段，助手消息继续使用现有 model 来源。`laya-pruner/rewrite` 是消息投影，含有它的会话只能在注册了该投影的地方派生；TUI 与 Web 包在宿主层注册它，`@deepseek-ai/dsh-session-format-catalog` 也将其纳入 `currentSessionMessageProjections` 以支持脱离运行时的回放。不需要修改 Session 格式版本。

<a id="verification"></a>
## 验证

`pnpm run gen-persistence-catalog` 重新生成包含三种事件类型与两种来源类型的目录；`pnpm run verify-persistence-changes` 在当前历史之上加入此记录后通过；`packages/compaction/compaction-laya-pruner/tests` 覆盖投影、经 `Session.create` 与 `foldSurface` 的回放、令牌计量重新计价，以及针对模拟服务的剪枝流程；prechat 导入、命令与模型选择测试以及无密钥的生产配置 Loader 测试覆盖发出请求中的导入角色。

<a id="dev-note"></a>
## 开发备注

无。
