---
description: "本地优先发行版的 Web 附加层：Laya 修剪和预备对话面板，以及 Smart 权限预设。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-local-web

[English](README.md) | 中文

## 概述

`dsh-local-web` 为 Web profile 添加本地优先发行版的浏览器部分。它挂载 [Laya 修剪面板](../../client/ui-laya-pruner/README.zh.md)、[预备对话编辑器](../../client/ui-prechat/README.zh.md) 和 [Smart](../../interaction/smart-approval/README.zh.md) 权限预设。这些面板展示的 host 能力来自 [`dsh-local-base`](../local-base/README.zh.md)。

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

在 `$DSH_HOME/profiles/web/package.json` 中，将该 bundle 列在 `@deepseek-ai/dsh-web-app` 之后、[`@deepseek-ai/dsh-local-presets`](../local-presets/README.zh.md) 之前：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-local-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-local-web", "@deepseek-ai/dsh-local-presets"]
    }
  }
}
```

随后对话中会显示每次 Laya 修剪的阶段、合计以及保留和移除的输出；`/prechat` 打开预备对话编辑器；权限菜单提供 **Smart**，由审查模型批准常规调用，其余调用询问你。会话在你切换之前保持当前权限预设。

| Smart 设置 | 值 |
|---|---|
| `timeoutMs` | 20000 |
| `maxInputChars` / `maxOutputChars` | 48000 |
| `maxOutputTokens` | 4096 |
| `maxConcurrentReviews` | 2 |
| `humanOnlyTools` | `run_code` |
| `escalatingTools` | `plugin_manager` |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 Web profile 的根层插入 `ui-laya-pruner`、`ui-prechat` 和 `smart-approval` 行。客户端行渲染 `laya-pruner` 和 `prechat` host 行写入会话日志的事件；没有这些 host 行时，面板保持为空。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 插入的客户端行和 Smart 预设 |
| [`tests/local-web.spec.ts`](tests/local-web.spec.ts) | 插入的行及其包 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [本地优先发行版指南](../../../docs/user/guide/local-first.zh.md)——安装、profile 以及使用决策模型修剪上下文。
- [`dsh-web-app`](../web-app/README.zh.md)——本 bundle 扩展的 Web 应用层。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过 Smart 预设体现，其审查模型会读取待执行的工具调用；面板对模型不可见。

#### KV Cache 影响

对对话没有影响；Smart 审查作为单独的请求运行。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限 Web**——终端应用插入自己的 Smart 预设行，并在不使用这些客户端包的情况下渲染 Laya 修剪。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
