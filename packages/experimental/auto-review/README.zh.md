---
description: "为 Web 或 headless profile 添加实验性逐调用 Auto review，在工具以 Full access 执行前使用当前 agent 的模型审查。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-auto-review

[English](README.md) | 中文

## 概述

为 Web 或 headless profile 添加 Auto review。Web 通过当前会话权限选择器提供它；headless 在每次调用时显式选择。每次原生或 PTC inner 工具调用前，当前 agent 的 provider 与模型会评估待执行动作；获准调用以 Full access 执行，被拒绝调用会请求用户审批。dsh 安装随附此层但默认关闭；在 Web 侧栏插件页开启或显式安装之前，默认 Web 保持三种权限模式。Auto review 是实验功能：它可能误放行不安全动作、误拒绝有用操作，并消耗额外 token。

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

评审环境记录待执行操作对应的 Session 当前工作目录。

### 安装到 profile

从源码 checkout 通过既有 CLI 将包安装到 Web profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/auto-review
```

CLI 会在需要时初始化 profile，并将本包声明的 patch 追加到 base 与 Web 层之后。Reconciliation 将 patch 激活为 profile 层；没有 `dsh.bundle.patch` 的包只是已安装依赖。在 composer 菜单或 `/permission` 选择器中选择带 `EXP` 标记的「自动审查」，并确认当前会话风险对话框。显式 `/permission auto` 命令直接切换。通用设置与未来会话默认值不提供 Auto。

通过同一 CLI 移除此层：

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
```

<a id="headless-supervision"></a>
### Headless supervision

为 headless profile 显式启用实验层：

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-auto-review
dsh headless --permission-mode auto --approval-policy never --json - < task.txt > run.jsonl
```

如需从此 checkout 单次运行，可传入 `--patch /absolute/path/to/packages/experimental/auto-review/cordis.patch.yml`，无需安装 profile 层。Auto integration 不可用时，权限预设选择会在读取 stdin 或开始模型工作前失败。Auto 使用完全主机访问权限；此模式不需要 `--add-dir`。原生工具让每个工具 body 都经过审查；PTC 的直接 Node 效果仍不在审查范围内。

Auto 将 `source.kind: 'user'` 的文本视为 `user-instruction`，不区分传输方式，也不要求消息到达时 Auto 已生效。这包括已有的 user-source 历史、SDK/ACP 调用者，以及以用户身份提交内容的插件。Child 自身的创建 prompt 和直接父级消息保留从属指令角色；继承的创建 prompt 与无法验证的创建 prompt 仍是事实。请明确动作、准确目标与范围。项目文件、工具结果和 checkpoint 不能授权动作。

在选择 Auto 后设置 `--approval-policy never`，使拒绝成为最终结果，并在 `tool_result.error` 中保留 `AUTO_REVIEW_DENIED` 及可选原始理由。`AUTO_REVIEW_FAILED` 标识不合法的 reviewer 输出或技术失败。两者都不执行 body。即使 `final.reason` 为 completed，也需审查任务报告：调用被拒绝后模型仍可结束。

恢复时使用相同工作目录与 `--session-id`。省略两个策略选项会保留已保存的策略，也可同时传入两者以显式选择无人值守 Auto。监督者可在拒绝后发送明确且限定范围的指令；新调用会重新接受审查。Headless 没有审批待执行调用的通道。`ask` 使用已组合的审批应答者，没有可用应答者时按拒绝处理；它不会把 stdin 变成审批通道。应用关闭保留 Auto。恢复其 Session 时必须加载同一 integration，即使要选择其他预设也是如此。从运行中的应用移除插件仍会将其存活 Auto Session 迁移到 Full access。

### 获得的能力

Auto 在每个受支持调用的 body 执行前审查一次，包括每个已开始的 PTC `tools.*` inner call。它按实际效果分类：普通项目内操作和精确清理本 Session 创建的对象属于 low，直接允许；不可逆删除既有对象、生产操作、外部写入和安全控制变更属于 medium，需要当前用户或直接父级明确授权动作、目标与范围。跨信任边界泄露敏感信息属于 high，始终拒绝。效果不明确和授权冲突未解决时拒绝。选择 Auto 会设置 `ask` 审批策略，因此被拒绝调用会请求用户审批，获批后才执行；审批被拒绝或取消时 body 不执行。进程内委派 child 固定 `never` 策略，其拒绝是最终结果。Reviewer 响应不合法或技术失败会重试一次，无法读取的回复会作为修复提示交还给 reviewer；重试后仍失败时以具体错误使调用失败，且从不执行。`trustedTools` 中列出的工具跳过审查。

最终拒绝使用普通工具卡片。折叠行标识 Auto review；展开输出说明 body 未执行，并显示可选理由。[Web 权限包](../../client/ui-permission-presets/README.zh.md)拥有选择器交互，[工具 UI](../../client/ui-tool/README.zh.md)拥有理由展示。

### 配置 reviewer

所有选项均可选，设置在 profile 的 `auto-review` 行上：

| 选项 | 默认值 | 作用 |
|---|---|---|
| `trustedTools` | `[]` | Auto 启用时无需审查即可运行的工具名：精确名称，或以 `*` 结尾的前缀，例如 `mcp__notes__*`。适用于效果已知且局限于本地的工具；其他调用仍完整审查。 |
| `reasoningEffort` | `off` | 审查请求的 reasoning effort。仅当被审查路由声明了该 effort 时生效，否则使用路由默认值。 |
| `maxTokens` | 路由默认值 | 审查请求的输出 token 上限。 |
| `logFile` | 无 | JSONL 文件，每次 reviewer 失败（附被拒回复）与每次拒绝（附风险、理由，以及是最终拒绝还是请求了用户审批）各写入一条运维记录。 |

失败与拒绝也会以 warning 级别写入插件 logger。日志文件与 logger 都不改变决定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml)把本包自身插入为 `auto-review` 行。[`src/index.ts`](src/index.ts)要求 approval、LLM、permission、Session 与 tools 服务，然后在同一个 effect 中安装 preset contribution 和置前的 pre-execute listener。受信任工具不经审查，直接交给后续 listener。失败的 review 会再运行一次，并把无法读取的回复作为 `REJECTED_PREVIOUS_REPLY` 带回；重试的失败即为调用的失败。Review 结束后，拒绝会读取 Session 的审批策略：`never` 下为最终拒绝；`ask` 下 listener 先交给后续 pre-execute listener，只有它们放行调用时才返回 tools 流水线的 `ask` 决定，因此后续的拒绝、取消或 `ask`（带自己的理由）优先。`ask` 决定携带英文审计理由，以及保留原始 reviewer 理由的本地化提示文本。[权限 owner](../../interaction/permission-presets/README.zh.md)提供当前身份和进程目录；Auto 使用 Full access 的沙箱值与 `ask` 审批策略，不改变工具定义。

Reviewer 以固定策略作为 system prompt，随后依次发送：一条仅含 cwd 的环境 user 消息、按 surface 顺序每个保留 Session 条目一条消息，最后是待审调用。项目指令出现在其进入 surface 的位置，并带约束角色。首次使用某个已审 schema 的调用之前有一条 `tool-schema` 条目；integration 为存活 Session 记住每次已审调用的 schema，使后续评审在同一位置重复它。原生 schema 来自最新 request header。PTC binding 冻结其 schema，经由调度器传入临时执行元数据；开始与结算事件都不序列化描述或参数 schema。主 agent 的 `system/message` 节点、assistant 正文与 reasoning、tool results 全部排除。外层评审输入是冻结的 `RequestUserInput`，不含持久身份或来源；保留历史在评审文本中仍携带原始来源。[决策记录](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md)拥有权威、生命周期与 child 继承的理由。

卸载时先关闭选择与 review admission。如果应用根 context 仍活跃，卸载随后经由既有 preset writer 将存活 Auto Session 迁移到 Full access；这包括移除和重载插件。迁移写入 `never` 审批策略，不排入策略变更通知；模型在下一次 runtime-context 快照中看到新策略。沙箱值与持久终端在迁移中保持不变。应用关闭保留选中的预设与审批策略。两种路径都会先中止并等待在途 review 结清，再撤回 listener 与 contribution。持久 Auto Session 缺少完整 integration 时不能发布，即使重新打开的请求选择了其他预设也一样。重新打开前须再次加载 integration。重装只恢复选项，不把存活 Session 切回 Auto。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验包](../README.zh.md)——发布策略与依赖隔离。
- [Web bundle](../../bundle/web-app/README.zh.md)——此 patch 扩展的稳定 profile。
- [Auto review 决策](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md)——固定风险策略、权威与生命周期。
- [Tools](../../core/tools/README.zh.md)——执行、取消与 PTC 结果传播。

-----

<a id="model-experience"></a>
## 模型体验

### 逐调用 reviewer

#### 模型看到什么

Reviewer 使用最新 `request/header.config` 的 provider 与模型，默认使用路由声明的 `off` effort 关闭 reasoning；显式配置的 `reasoningEffort` 仅在该路由声明了它时生效。固定 `REVIEW_POLICY` 替代恰好一个动作的人工审批：allow 后立即以 Full access 执行。这些 user 消息只包含上文列出的保留事实。响应为一个 JSON text 对象，包含 `risk` 与 `decision`；deny 可附字符串 `reason`。Reasoning blocks 可以位于这唯一 text block 之前。文本先整体读取（可包在一个 Markdown 代码围栏内），否则读取其中最后一个符合协议形状的对象。只有 `low + allow`、`medium + allow/deny` 和 `high + deny` 合法。

#### Token 影响

每个受审查调用额外产生一次模型请求，失败时再重试一次；不复用审查结论、不截断或压缩，`maxTokens` 可选地限制其输出。受信任工具不产生请求。超窗请求在重试后以 provider 错误使调用失败。

#### KV Cache 影响

固定 reviewer policy 可以共享前缀；保留历史与待审动作随调用变化。每次评审的消息都以上一次评审的全部消息（包括其待审调用）开头，因此按 prompt 前缀、按消息结尾或在末尾标记处回溯缓存的路由都能复用策略与先前历史。Compaction、cwd 变化、较早条目离开 surface，以及重启后的第一次评审会让复用中断一次。每个评审请求都携带被评审 Session 的 `sessionId` 和 `purpose: 'auto-review'`，作为模型不可见的传输元数据。本地路由为评审使用由会话标识派生的独立缓存键；Auto 启用期间，评审请求也通过 `llm/preserve-context` 请求保留上下文；DeepSeek Session-log 上传器排除 `auto-review` 请求。

### 主 agent 权限上下文

#### 模型看到的内容

本插件加载期间，所服务 Session 的每个 agent 都会在审批策略位置收到一个 `approval:auto-review` runtime context 分节。其他 preset 下内容为 `Current DSH permission preset: <preset>. Auto review is inactive.`。Auto 下以 `Current DSH permission preset: auto.` 开头，说明 `danger-full-access` 文件策略描述的是文件系统访问、自动授权审查处于启用状态且 `run_code` 的审查作用于其内部工具调用，列出 `trustedTools` 豁免，说明完整文件系统访问并不授予执行任意操作的许可，并说明评审拒绝是最终结果还是转而询问用户。这用于区分自动授权审查与底层 `danger-full-access` 文件策略。

#### Token 影响

每个请求增加一个简短的 runtime context 分节；Auto 文本随 `trustedTools` 列表增长。

#### KV Cache 影响

切换 preset 会更新 runtime context，而不重写稳定的 system 前缀。Auto 启用期间，插件对该 Session 的普通对话请求及其 `auto-review` 请求以 `true` 回答 `llm/preserve-context`；每次请求都根据当前 preset 解析策略，插件卸载时撤销。支持此功能的本地 pi-ai 路由随后发送模型不可见的 `preserve_context: true`；其他 preset 和其他辅助用途保持正常传输策略。实际前缀复用取决于服务端支持和可用缓存容量。

### 工具拒绝

#### 模型看到什么

在 `ask` 审批策略下，模型只看到审批结果，例如 `the user rejected tool "<name>"`，或获批调用的普通结果。最终拒绝消息为 `Auto review rejected tool "<name>"; its body was not executed`。Reviewer 失败消息为 `Auto review of tool "<name>" failed; its body was not executed: <error>`。普通原生错误渲染在每条消息前加 `Error: `。PTC 使用既有 inner-call 异常与 catch 行为；被捕获的拒绝不强制外层 `run_code` 失败。可选原始理由是面向用户的持久结构化错误详情，绝不进入主模型内容。风险、reviewer prompt、reasoning 与原始响应都不持久化。

#### Token 影响

被拒绝或失败的调用只向主对话贡献其普通错误结果。

#### KV Cache 影响

拒绝追加普通工具结果，不改写更早的上下文，也不隐藏既有模型可见信息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Auto 需要显式启用此层。默认 Web 与 Headless、通用设置及新会话默认值都不选择它。
- 模组可以提交 user-source 文本。[Claude Code 模组桥接](../claude-code-mods/README.zh.md#model-experience)赋予 `$.prompt.submit` 与 `prompt.submit` hook context 用户权威，包括未设置 `asUser: true` 的框架化提交；文本框架不会降低其权威。
- Auto 不提供文件沙箱。外层 `run_code` transport 及PTC 程序内直接 Node 效果不经过 inner-tool review。
- 模型分类可能出错。不提供持久 grant 或可配置策略；`trustedTools` 只按工具名豁免、不看参数，重试层也只有一次尝试。
- 进程内 Auto child 独立审查自身调用。进程外 child 在父委派调用获准后保留原生权限系统。
- reviewer 在带行级豁免的情况下，通过已废弃的同步 `snapshotEvents()` 读取 Session 动作历史。此前的调用、PTC start 与直接父级的初始 prompt 目前都没有投影或分页读取方，因此迁移按[同步读取决策](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md)继续延期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
