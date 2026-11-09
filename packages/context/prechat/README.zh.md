---
description: "将预设对话导入配置的模型路由上的新会话。"
kind: "package-reference"
---
# @deepseek-ai/dsh-prechat

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-prechat` 提供 `/prechat`，用预设的 `USER:` / `ASSISTANT:` 轮次开启新会话。该命令只在 `routes` 配置列出的提供方/模型路由上可用；其他路由会隐藏并拒绝该命令。

## 目录

- [使用](#use)
- [配置路由](#configure-routes)
- [失败与生命周期](#failure-and-lifecycle)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use"></a>
## 使用

在终端输入 `/prechat`，然后粘贴文本或带引号的 `.txt` 路径。`/prechat /path/to/chat.txt` 会直接打开预览；相对路径基于会话的工作目录解析。终端的大段粘贴会在解析前从显示的占位符还原。Web 编辑器支持粘贴文本、选择文件和拖入单个 `.txt` 文件。

```text
USER: Help me practise fractions with short examples.
ASSISTANT: We can work through one example at a time.
USER: Explain one half plus one quarter.
ASSISTANT: One half is two quarters, so the sum is three quarters.
```

角色标记必须位于行首。内容可以跨行。消息在 `USER:` 和 `ASSISTANT:` 之间交替，并以助手消息结束；消息对不完整或消息为空时，输入会保留以便修正。输入使用 UTF-8，最多 256 KiB。以角色标记开头的行总是开始下一条消息。

检查预览后可以选择 **Apply**（应用）、**Edit**（编辑）或 **Cancel**（取消）。应用会创建并保存新会话并跳转，原会话保持不变。用户发送下一个问题之前不会请求模型。Web 编辑器使用 `/prechat --apply`，后跟换行和已预览文本；终端也支持此显式应用形式。

重新打开会话仍会显示导入计数。选择其他模型会打开不带导入历史的新会话。导入会话向 `routes` 之外任何路由发出的请求都会被拒绝，上下文压缩后也如此。

<a id="configure-routes"></a>
## 配置路由

```yaml
- name: '@deepseek-ai/dsh-prechat'
  config:
    routes:
      - provider: my-provider
        model: my-model
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `routes` | `[]` | 接受导入对话的提供方/模型对。只有 `provider` 与 `model` 都相同时才匹配。列表为空时 `/prechat` 不可用。 |

预设历史按某个模型的轮次格式编写，因此只应列出为其编写的路由。错误消息会以逗号分隔的 `provider/model` 列表列出允许的路由。

<a id="failure-and-lifecycle"></a>
## 失败与生命周期

解析、大小、编码、路由和会话忙碌检查均在创建新会话前执行。取消不改变当前会话。agent（智能体）工厂负责发布前的回滚；发布后若持久化或工作区关联失败，新会话可能保留在会话列表中，并报告导入失败。注册项属于插件的 Cordis 生命周期。

<a id="model-experience"></a>
## 模型体验

### 导入的对话历史

#### 模型看到的内容

下一次请求会包含作为普通用户和助手消息交替排列的导入文本，再接上用户的新问题。这是对话历史，不是激活值 steering（中途引导）或额外系统提示词。预设的助手消息由用户编写；界面会标识导入。导入不保证模型作出特定回复。会话日志保存导入消息和已完成轮次。用户消息带有 `source.kind: prechat`；助手消息使用普通 model 来源，带有 `provider: prechat` 和 `model: imported`。日志回放会重建消息和计数投影。

#### Token 影响

导入文本会增加下一次请求的输入 token，并保留到上下文压缩。

#### KV Cache 影响

导入创建新会话；服务端可能复用完全相同的前缀，但导入不会主动预填充。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅支持纯文本轮次**——工具调用、推理内容和消息附件不能导入，角色必须从 `USER:` 开始交替，并以 `ASSISTANT:` 结束。
- **绑定到配置的路由**——导入会话不能在其他模型上继续；选择其他模型会打开不带导入历史的新会话。
- **UTF-8 输入上限 256 KiB**——更长的对话必须先缩短再导入。
- **不保证回复**——导入的助手轮次是用户编写的示例，模型的回答可能与之不同。
- **发布后的部分失败**——新会话发布后若持久化或工作区关联失败，该会话可能保留在会话列表中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明</summary>

无。

</details>
