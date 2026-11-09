---
description: "面向交互式组合的 /skills 命令（技能命令）：它列出什么、你会看到什么，以及如何挂载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-skills

[English](README.md) | 中文

## 概述

`dsh-command-skills` 为聊天 UI 添加 `/skills` 命令（技能命令）：输入后即可看到当前会话已安装的 skill（技能）——每个 skill 的名称、描述，以及发现它所用的目录。列表与会话 skill 注册表解析出的结果一致，因此也会列出模型无法加载的 skill。该命令不接受参数，不会向模型发送任何内容；当没有任何发现结果时，它报告 `No skills are installed for this session.`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在聊天 UI 中输入 `/skills`，即可查看当前会话可以调用的 skill（技能）。随附的 `dsh` 终端聊天已挂载该命令，因此它通常已经可用。

### 命令用法

| 输入 | 结果 |
|---|---|
| `/skills` | 每个已安装的 skill 一行——名称、描述与发现来源——位于计数行之下。 |
| 在没有任何安装项时输入 `/skills` | `No skills are installed for this session.` |
| `/skills <任意内容>` | `Usage: /skills (no arguments)`——该命令不接受参数。 |

超过 `descriptionMaxLength`（默认 160 个字符）的描述会被折叠为一行，并以 `...` 截断。

### 你会看到什么

示例输出：

```text
3 installed skills:
- design-taste-frontend — Art direction for websites... [user-dsh]
- impeccable — Use when the user wants to design... [user-dsh]
- playwright-cli — Automate browser interactions... [user-dsh]
```

方括号中的来源标明产生该条目的目录：`project-dsh`、`project-agents`、`custom`、`user-dsh`、`user-agents`、`bundled`、`runtime`，或提供方自定义标签。frontmatter（前置元数据）禁用了模型调用的 skill 仍会被列出：该命令报告的是已安装内容，而不是模型可加载的内容。

### 组合该命令

挂载命令注册表、skill 注册表、工作目录服务以及本插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: skill
  name: '@deepseek-ai/dsh-skill'
- id: working-directory
  name: '@deepseek-ai/dsh-working-directory'
- id: command-skills
  name: '@deepseek-ai/dsh-command-skills'
```

随附的 `dsh` base 挂载各注册表与工作目录服务；终端聊天挂载本命令。没有组合命令适配器的界面不存在 `/skills`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `descriptionMaxLength` | `160` | 每个 skill 渲染描述的最大长度；最小值为 3。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

本节解释命令背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

- **与面向模型的目录共用同一条读取路径。** 处理器以接收命令的 agent 作为查看作用域、以该 agent 记录的工作目录作为 `cwd` 调用 `ctx.skills.list()`——与 `tool-skill` 用于模型目录的查找完全相同——因此人类视图的列表与模型目录解析出同一份分层注册表。
- **与调用策略无关的列表。** 注册表的摘要携带模型与用户调用策略；该命令渲染每个条目，把策略过滤留给需要它的界面。
- **仅人类可见的生命周期。** `command/run` 与 `command/done` 是仅记录事件；结果文本永远不会进入模型历史。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`/skills` 注册、参数拒绝、描述截断、行渲染 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时，请阅读这些页面；它们从命令延伸到注册表、发现目录以及相邻的模型可见界面。

- [Skill 注册表](../skill/README.zh.md)——该命令读取的分层提供方注册表。
- [Skill 文件系统提供方](../skill-filesystem/README.zh.md)——发现来源所标明的目录与优先级。
- [Tool skill](../tool-skill/README.zh.md)——与这一人类视图并列的面向模型的目录与 `/name` 调用。
- [Commands 包](../../interaction/commands/README.zh.md)——聊天命令背后的注册表与分发契约。
- [Skill 子系统参考](../../../docs/subsystems/skills.zh.md)——共享的 skill 词汇表。

-----

<a id="model-experience"></a>
## 模型体验

### 人类 `/skills` 列表

#### 模型看到什么

没有任何内容。斜杠输入与渲染出的列表永远不会进入模型请求；只有仅记录的 `command/run` / `command/done` 事件对记录了这次调用。

#### Token 影响

该命令不增加任何模型 token。

#### KV Cache 影响

发现与渲染不触及模型历史，因此缓存不受影响。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了该命令不适合的场景；它们是当前包的约束。

- **仅目录视图**——`/skills` 只列出、不加载；调用 skill 仍然是 `/name` 手势或模型的 `skill` 工具。
- **没有过滤或详情参数**——无参数的形式列出每个解析出的 skill；名称过滤与单个 skill 的详情视图需要跨适配器共享的命令语法。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

这份开发备注是维护者的工作上下文，明确不具有权威性；已发布的行为存在于上面的章节与包代码中。

- **详情子命令，未决定**——`/skills <name>` 展示单个 skill 的 frontmatter（前置元数据）、路径与资源仍是开放方向；它需要与其它命令过滤器相同的参数语法决策。

</details>
