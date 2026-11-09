---
description: "配置本地 Laya 上下文剪枝、DS4 临时内存共享、进度反馈及摘要回退。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-laya-pruner

[English](README.md) | 中文

## 概述

先用 Laya 剪枝旧上下文，再决定是否需要生成模型摘要。内存充足时可保持 Laya 常驻，也可让 DS4.1 服务器借出专家缓存内存并临时启动它。Web 和 TUI 显示每个托管阶段。剪枝失败或效果不足时仍可执行普通摘要压缩。

## 目录

- [使用此包](#use-this-package)
- [决策服务协议](#decision-service-protocol)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在普通摘要压缩之前运行 Laya 剪枝。与 `compaction-basic` 一起挂载，并保持 `thresholdRatio` 和 `headroomTokens` 一致；读取已存会话但不运行剪枝的宿主应挂载 `mode: projection`。

`url` 选择常驻 Laya 服务，请求发送到 `/compact`。`modelEndpoints` 为精确匹配的提供方和模型覆盖完整请求 URL。未匹配的路由继续使用常驻服务。本地组合包只在 `DSH_LAYA` 为 `resident` 或 `managed` 时运行该剪枝过程，常驻服务地址为 `LAYA_URL`（默认 `http://127.0.0.1:8766`）；否则以 `mode: projection` 挂载该行，使包含改写的已存会话仍可恢复。`DSH_LAYA=managed` 时，它们还会把 `ds4-v41-flash` / `deepseek-v4.1-flash`、`qwen-flash` / `qwen3.8-next-flash` 和 `qwen-27b` / `qwen3.8-27b` 路由到 `DSH_LOCAL_LLM_URL`（默认 `http://127.0.0.1:8080/v1`）下本地模型服务器的 `/laya/compact` 端点；其他路由继续使用常驻服务。

托管端点负责 worker 的启动、停止和模型内存恢复。返回成功或失败之前，必须停止并回收临时 Laya 进程，再恢复内存。服务器必须将此操作与推理串行执行，即使客户端超时或断开也一样。本发行版不提供这样的服务器：该端点需要经过修改、实现了它的模型服务器，例如通过 `--compaction-worker PATH` 接受受信任 worker 的 DS4 构建。

服务失败或剪枝无效时，摘要压缩仍可执行。剪枝成功后，`compaction-basic` 重新测量上下文压力，超过阈值则生成摘要。剪枝不会关闭这一回退。取消请求保留既有的智能体取消行为。

托管端点通过[流式响应](#decision-service-protocol)报告进度阶段。进度持久化用于 Web/TUI 显示，不进入模型输入；减少动态效果的偏好会关闭 Web 像素动画。

<a id="decision-service-protocol"></a>
## 决策服务协议

该剪枝过程可与任何实现此 HTTP 协议的服务配合使用；它本身不加载模型。Laya 是其中一种实现。其他分类器、用作评判的模型或固定规则都可以响应同一请求。`url` 和 `modelEndpoints` 选择服务。

### 请求

dsh 发送 `POST {url}/compact`（或完整的 `modelEndpoints` URL），请求体为 JSON。请求在 `timeoutMs` 后超时。

| 字段 | 含义 |
|---|---|
| `events` | 按顺序排列的当前对话，不含系统指令 |
| `target_tokens` | 剪枝后整个请求应占用的 token 数：上下文窗口的 `targetRatio` |
| `fixed_tokens` | 被评判文本之外的请求内容（如工具定义和受保护部分）的估计 token 数 |
| `min_budget_tokens` | 始终分配给最佳被评判项的 token 数：上下文窗口的 `minBudgetRatio` |

每个事件包含以下字段：

| 字段 | 含义 |
|---|---|
| `role` | `user` 或 `assistant`；工具输出位于 `text` 为空的 `user` 事件中 |
| `text` | 消息文本 |
| `tool_uses` | `assistant` 事件的工具调用：`{ "id", "name", "input" }`；`input` 为解析后的参数，参数不是有效 JSON 时为 `{ "raw", "parseError" }` |
| `tool_results` | 工具输出：`{ "id", "text", "is_error" }`；`id` 为工具调用 id |
| `context` | 对于由 dsh 生成而非用户输入的 user 角色消息（如运行时上下文）为 `true` |
| `pinned` | 对于当前用户请求以及每个生成方的最新上下文消息为 `true`；针对它们的决策会被忽略 |

### 响应

服务以 `{ "items": [...] }` 响应，每个被评判的工具输出或消息对应一项。未列出的项保持不变。

| 字段 | 含义 |
|---|---|
| `id` | 必填。工具输出为工具调用 id，消息为 `m<index>`，指 `events` 中该位置的消息 |
| `kind` | 必填。工具输出为 `tool`；消息为任意其他字符串 |
| `action` | 必填。`KEEP`、仅保留 `keep_lines` 的 `TRUNCATE`，或 `DROP` |
| `lines` | 必填。被评判文本的行数 |
| `keep_lines` | `lines` 范围内从 1 开始、包含两端的 `[start, end]` 区间；默认 `[]` |
| `tokens_before`、`tokens_after` | 可选的非负整数，显示在 Web 和 TUI 报告中；默认 `0` |
| `label` | 可选，显示在报告中的文本；默认为空 |

dsh 在做任何修改之前验证整个响应。非 2xx 状态、超时或任意一个无效项都不会改变任何内容，由摘要压缩决定后续处理。

服务也可以使用 `content-type: application/x-ndjson` 响应：零条或多条 `{ "phase": "release" | "start" | "prune" | "stop" | "restore" }` 记录，然后是一条 `{ "result": { "items": [...] } }` 或 `{ "error": "message" }` 记录。dsh 为进度显示记录每个阶段，等待终止记录和流结束，并拒绝超过 16 MiB 的流。

### 示例

```json
{
  "events": [
    { "role": "user", "text": "Fix the failing test", "tool_uses": [], "tool_results": [] },
    { "role": "assistant", "text": "", "tool_uses": [{ "id": "call_1", "name": "bash", "input": { "command": "npm test" } }], "tool_results": [] },
    { "role": "user", "text": "", "tool_uses": [], "tool_results": [{ "id": "call_1", "text": "...", "is_error": false }] },
    { "role": "user", "text": "Now update the changelog", "tool_uses": [], "tool_results": [], "pinned": true }
  ],
  "target_tokens": 46080,
  "fixed_tokens": 12000,
  "min_budget_tokens": 46080
}
```

```json
{
  "items": [
    { "id": "call_1", "kind": "tool", "action": "TRUNCATE", "lines": 120, "keep_lines": [[1, 3], [98, 120]], "label": "bash npm test" },
    { "id": "m0", "kind": "user_msg", "action": "KEEP", "lines": 1 }
  ]
}
```

### dsh 如何应用

- **被截断的输出**保留所选行；每段被删除的内容变为一行注记。在文件 `read` 输出中，注记会写明被隐藏的文件行以及可恢复它们的 `read` 调用。
- **被丢弃的输出**变为 `[laya_context_pruner: output removed (N lines); re-run the tool if needed]`。
- **被丢弃的消息**会被移除。只有当某条 assistant 消息的全部输出也被丢弃时，才会连同其工具调用一起移除。移除操作保持工具调用与结果配对，且从不触及系统提示词。
- **被忽略的决策**：固定事件、每个 `pinnedTools` 工具的最新调用、不匹配任何事件的 id，以及针对已被先前剪枝缩短的输出的 `TRUNCATE`。
- **推理内容**：无论服务如何响应，较早的 agent 推理都会在同一次剪枝中按 `keepReasoning` 丢弃。

<a id="model-experience"></a>
## 模型体验

### 剪枝后的对话历史

#### 模型看到的内容

步骤边界的请求达到路由上下文窗口的 `thresholdRatio` 或余量上限时，下一次请求携带剪枝后的上下文。Laya 选择保留的原文行或删除可剪枝历史，不生成摘要文本。被删除的区间替换为一条以 `[laya_context_pruner: removed` 开头的用户消息，其中统计被替换的较早消息和工具输出数量；被丢弃的工具输出替换为 `[laya_context_pruner: output removed (N lines); re-run the tool if needed]`；被截断的工具输出或用户消息只保留选中的行，并带有 `[... N lines pruned by laya_context_pruner ...]` 等间隔说明，文件 `read` 输出中的说明会指出被隐藏的文件行以及可恢复它们的 `read` offset 和 limit。已结束的 agent 推理内容按 `keepReasoning` 丢弃。系统提示词、最新用户请求、每个 `pinnedTools` 工具的最新调用以及工具调用配对永远不会被剪枝。持久化的 `compaction/prune` 事件及其替换用的 `tool/result` 或 `user/message` 事件，以及 `laya-pruner/rewrite` 事件，可以重建每一项修改。

#### Token 影响

剪枝成功时，用保留行和简短说明替换已评估的历史，使输入向上下文窗口的 `targetRatio` 缩减。Laya 服务调用不是 DSH 模型请求，不增加模型 token。若压力仍超过 `compaction-basic` 的阈值，普通摘要压缩会额外发起一次模型请求。

#### KV Cache 影响

替换而非仅追加：每次剪枝都会使从第一条被修改的历史消息开始的复用失效，此前未改变的前缀仍可复用。托管的 DS4 服务器在临时 worker 运行期间保留模型和 KV，但之后必须对修改后的历史重新执行 prefill；恢复缓存容量不会立即重载每个被逐出的专家，恢复推理时按需读取会重新填充缓存。

### 剪枝进度记录

#### 模型看到的内容

无：`laya-pruner/start`、`laya-pruner/progress` 和 `laya-pruner/end` 是仅记录日志的事件，由 Web 和 TUI 显示，永远不会进入模型请求。

#### Token 影响

无；这些记录不增加请求内容。

#### KV Cache 影响

无；这些记录不改变任何请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 临时 Laya 需要 Linux CUDA V4.1 SSD 流式服务器，以非批处理模式运行，并有足够可回收的缓存内存。内存准入检查失败时端点返回错误，普通摘要回退仍可用。缓存恢复失败会停止服务器，因为继续推理不安全；继续之前需重启。默认请求超时为 120 秒，服务器将 worker 执行限制为 110 秒，之后清理。客户端超时后清理可能短暂继续，推理仍在其后串行等待。

<a id="dev-note"></a>
### 开发备注

修改生命周期处理时运行包测试及 `laya-managed-progress` 录制会话。`laya-managed-progress` SDK 场景通过公开协议投影相同的回退和阶段。
