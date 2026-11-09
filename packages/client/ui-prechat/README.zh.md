---
description: "在 Web 中粘贴、加载文件并预览通过 /prechat 导入的预设对话。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-prechat

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-client-ui-prechat` 为 Host 的 `/prechat` 命令提供独立的会话编辑器，由本地 Web 组合包 `@deepseek-ai/dsh-local-web` 挂载。可用性和最终验证由 [Host 导入器](../../context/prechat/README.zh.md)负责。

## 目录

- [使用](#use)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use"></a>
## 使用

选择 Host 导入器 `routes` 配置中列出的路由后输入 `/prechat`。粘贴对话文本、选择 `.txt` 文件，或将一个文件拖入对话框。预览显示角色和完整内容。编辑返回文本，取消丢弃草稿。提交期间应用按钮禁用，成功后打开新保存的会话。失败保留草稿和预览。慢文件读取不会覆盖较新的编辑，会话资源释放时会移除草稿。

重新打开会话时，导入消息提示会从会话投影恢复。切换到不支持的模型路由时，模型选择会跳转到 Host 返回的新会话。

<a id="model-experience"></a>
## 模型体验

### 导入的对话历史

#### 模型看到的内容

对话框本身不请求模型。应用会将预览过的文本提交给 `/prechat`；[Host 包](../../context/prechat/README.zh.md#model-experience)定义模型可见的持久消息。

#### Token 影响

导入文本会增加下一次请求的输入 token，并保留到上下文压缩。

#### KV Cache 影响

导入创建新会话；服务端可能复用完全相同的前缀，但导入不会主动预填充。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **遵循 Host 规则**——只能导入配置路由上的纯文本交替轮次；这些限制由 [Host 导入器](../../context/prechat/README.zh.md#known-limitations-and-deferred-work)负责。
- **单个 `.txt` 文件，最多 256 KiB**——对话框拒绝其他扩展名、非有效 UTF-8 的文件、更大的文件以及一次拖入多个文件。
- **草稿只保存在浏览器标签页中**——未应用的草稿按会话保存在内存中；重新加载页面或会话资源释放时草稿会被丢弃。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明</summary>

无。

</details>
