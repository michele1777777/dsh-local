---
description: "本发行版的本地优先 standard agent preset：在内置 standard preset 基础上加入 Laya 修剪和本地模型的摘要路由，并关闭工具结果修剪。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-local-presets

[English](README.md) | 中文

## 概述

`dsh-local-presets` 让 `standard` agent preset 适配本地模型。它保留内置的 standard 组合，只修改其中的压缩分组：当 `DSH_LAYA` 选择 [Laya](../../compaction/compaction-laya-pruner/README.zh.md) 时，修剪在摘要压缩之前运行；本地路由通过 [`dsh-local-base`](../local-base/README.zh.md) 中关闭推理的 `-summary` 孪生路由生成摘要；工具结果修剪器保持关闭，由原文修剪决定保留哪些工具输出。`ptc`、`minimal` 和 `cordis` preset 保持不变。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将该 bundle 列在最后：位于声明这些 preset 的应用 bundle 之后，也位于 [`dsh-local-base`](../local-base/README.zh.md) 之后。内置的 `tui` profile 使用以下顺序：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-local-base", "@deepseek-ai/dsh-tui-app", "@deepseek-ai/dsh-local-presets"]
```

Web profile 依次列出 `@deepseek-ai/dsh-web-app`、[`@deepseek-ai/dsh-local-web`](../local-web/README.zh.md) 和本 bundle。随后 standard preset 的行为如下：

| 行 | 设置 |
|---|---|
| `laya-pruner` | `DSH_LAYA` 为 `resident` 或 `managed` 时启用；阈值与压缩相同（80%），目标 25%，超时 120 秒 |
| `compaction-basic` | 在 80% 处自动压缩，保留 16%，摘要 32768 个 token；本地路由通过各自的 `-summary` 孪生路由生成摘要 |
| `tool-result-pruner` | 禁用 |
| 其他所有行 | 与 Web 应用的 `presets/standard.patch.yml` 相同 |

环境变量和路由见 [`dsh-local-base`](../local-base/README.zh.md#environment-variables)。已有会话在下次加载时采用新的组合。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 按 id 修补两行。它用 standard preset 的完整副本替换 `preset-standard` 的 `config`，副本的压缩分组包含上述修改；之所以复制整份配置，是因为嵌套在 preset 配置中的行无法按 id 修补。它还将 `dsh-local-base` 中的 host `laya-pruner` 行设为 `mode: projection`：修剪在 preset 内对每个会话运行一次，host 保留改写投影，使带有 Laya 改写的已存会话在其会话插件加载之前即可恢复。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | standard preset 副本和 host 投影切换 |
| [`tests/local-presets.spec.ts`](tests/local-presets.spec.ts) | 压缩分组以外的部分与 Web 应用 standard preset 保持一致 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [本地优先发行版指南](../../../docs/user/guide/local-first.zh.md)——安装、profile 以及使用决策模型修剪上下文。
- [`dsh-web-app` preset](../web-app/README.zh.md)——本 bundle 跟随的内置 preset 声明。
- [`dsh-agent-preset`](../../preset/agent-preset/README.zh.md)——preset 如何组合每个会话的插件。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过 preset 中的各行体现。Laya 在任何摘要之前按原文删除或缩短较早的历史；摘要由同一模型的关闭推理路由生成。工具结果不再按大小截断。

#### KV Cache 影响

与摘要压缩一样，Laya 改写会使第一处修改行之后的 KV 前缀失效。没有工具结果修剪器时，大型工具输出会留在前缀中，直到 Laya 或压缩将其移除。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **完整的 preset 副本**——该 bundle 重复了 standard preset；Web 应用 `presets/standard.patch.yml` 的修改必须手动同步，未同步前 bundle 测试会失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

合并上游对 `packages/bundle/web-app/presets/standard.patch.yml` 的修改后，将其复制到本 bundle 并运行其测试。

</details>
