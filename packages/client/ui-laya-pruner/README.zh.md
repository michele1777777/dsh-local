---
description: "Laya 上下文剪枝过程的 Web Chat 行：运行时显示进度，结束后显示 token 统计与每个已评估的工具输出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-laya-pruner

[English](README.md) | 中文

## 概述

将每次 [Laya 剪枝过程](../../compaction/compaction-laya-pruner/README.zh.md)显示为 Web Chat 视图中的一行。剪枝运行期间，该行显示动画像素标记、测得的请求大小以及托管服务器当前阶段。结束后，该行显示 token 缩减量、保留／截断／丢弃数量与耗时，或回退原因；展开后列出每个已评估的工具输出。本包只读取会话事件，不注册工具、提示词分节或 Host 服务。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在提供 `uiConversation`、`slots` 和 `locale` 的 Web 客户端组合中挂载本包，并让 Host 运行 `@deepseek-ai/dsh-compaction-laya-pruner`。本地 Web 组合包 `@deepseek-ai/dsh-local-web` 会挂载它。本包没有配置字段。

```yaml
- id: ui-laya-pruner
  name: '@deepseek-ai/dsh-client-ui-laya-pruner'
```

### 该行显示的内容

| 剪枝状态 | 标题行 |
|---|---|
| 运行中，处于剪枝阶段或未报告阶段 | `Pruning context · <tokens> tokens`（中文界面为「正在裁剪上下文」），并显示动画标记 |
| 运行中，处于托管阶段 | `DS4 · freeing cache memory`、`Starting Laya`、`Stopping Laya` 或 `DS4 · restoring cache capacity` |
| 已剪枝 | `<before> → <after> tokens (−<pct>%)`，随后是 `<kept> kept · <truncated> truncated · <dropped> dropped · <time>` |
| 回退 | `Skipped · regular compaction decides`，有记录的错误时随后显示该错误 |

运行阶段通过 polite 实时区域播报。剪枝运行期间标题按钮保持禁用。剪枝结束后，展开该行会把已评估的输出分为完整保留、截断为保留行和已移除三组，每组按节省的 token 排序；每个条目显示其标签、token 变化，以及保留的行范围或行数。减少动态效果的偏好会停止像素动画。界面文案提供中文、英文、日文、西班牙文、法文、德文、俄文和葡萄牙文。

-----

<a id="understand-the-implementation"></a>
## 理解实现

[`src/client/laya-definition.ts`](src/client/laya-definition.ts) 注册一个 Conversation Node Definition：它在 `laya-pruner/start` 时打开一个 `laya-pruner` Chat 节点，在剪枝运行期间记录每个 `laya-pruner/progress` 的阶段，并用 `laya-pruner/end` 的统计和条目替换状态。同一次剪枝的事件共享其 `pruneId`。[`src/client/LayaPrunerPanel.tsx`](src/client/LayaPrunerPanel.tsx) 通过 `conversation.chat.node` slot 渲染该节点，[`src/client/locales.ts`](src/client/locales.ts) 负责 `layaPruner` 词典。Host 入口为空，因为该功能完全在浏览器端实现。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-compaction-laya-pruner](../../compaction/compaction-laya-pruner/README.zh.md)——剪枝过程、其配置以及本行读取的事件。
- [dsh-client-ui-chat](../ui-chat/README.zh.md)——承载按键注册节点渲染器的 Chat 视图。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该行只在浏览器中渲染仅记录日志的 `laya-pruner/*` 会话事件。

#### KV Cache 影响

该行不向任何模型请求添加内容，因此不改变任何请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只逐项列出工具输出**——剪枝过程删除的较早用户消息和 agent 消息以及被丢弃的推理内容不会列出；统计数量和展开列表只覆盖已评估的工具输出。
- **托管阶段标签写明 DS4**——对每个托管端点，释放和恢复阶段都显示 `DS4 · …`，包括由其他本地模型提供服务的路由。
- **必须已加载开始事件**——`laya-pruner/start` 位于已加载事件窗口之外的剪枝过程不会显示为一行。
- **不显示被剪枝的内容**——展开列表显示标签、token 数量和行范围，不显示被保留或移除的文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`tests/progress.client.spec.tsx` 覆盖折叠的过程分组之外的进度可见性，以及进度事件与所属剪枝过程的匹配；修改 Definition 或面板时运行它。

</details>
