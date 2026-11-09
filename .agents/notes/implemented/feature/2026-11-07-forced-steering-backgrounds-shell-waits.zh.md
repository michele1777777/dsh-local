# Agent Note: Forced steering backgrounds shell waits

Status: implemented

[English](2026-11-07-forced-steering-backgrounds-shell-waits.md) | 中文

## Problem

[等待后台任务时接收用户消息](2026-10-20-interactive-background-jobs.zh.md)会在每条用户当前 step 消息到达时解除前台 Bash 或 PowerShell 等待。终端中轮次运行时按 Enter 即为 steering，因此命令运行期间发送的每条消息都会把该命令变成后台任务。本可几秒内结束的短命令成为模型必须收集的任务，而底栏统计所有任务记录，已结束的任务看起来像永不结束的工作。

## Decision

steering 消息不会解除前台 shell 命令的挂接；命令返回后，代理在下一 step 读取消息。`JobRegistry.holdWait(owner, release)` 使前台等待可被解除，`JobRegistry.releaseWaits(owner)` 解除某个所有者持有的全部等待并返回数量。`waitForForegroundJob` 以这种方式持有等待，不再监听收件箱插入。`job_output` 等待保留原有的用户当前 step 消息解除行为，因为解除它不会创建任务。

终端通过空 Enter、Ctrl+Enter 或 `/queue send` 强制发送待处理输入。当前 step 有用户输入时，终端先调用 `releaseWaits`：被解除的 shell 调用返回其后台任务句柄，代理立即读取消息，任务结束时现有完成通知机制会通知代理。若没有解除任何等待，或只有下一轮输入待处理，终端照旧中断轮次并发送待处理输入。终端底栏只统计运行中和停止中的任务。

## Alternatives considered

**每次强制发送都中断。** 这会取消用户希望保留的长时间构建或测试，[先前的记录](2026-10-20-interactive-background-jobs.zh.md)已否决此方案。

**继续在每次 steering 时解除。** 正是这一行为让每条消息都创建一个任务。

**`job_output` 等待也只在强制发送时解除。** 上游的 `job_output` 解除行为有专门的 steering 测试覆盖，且从不创建任务；改变它只会推迟消息。

## Consequences

长命令运行期间发送的 steering 消息会等待命令结束或强制发送。没有强制发送手势的宿主（例如 Web 客户端）会保持 shell 等待挂接，直到完成或超时转入后台。`wait_agent` 等其他阻塞等待仍无法解除，可改用 `holdWait`。Bash steering 测试与代理循环集成测试证明单独的 steering 会保持命令挂接，而 `releaseWaits` 会将其转入后台并只发送一次完成通知；TUI 测试覆盖解除决策与只统计运行中任务的底栏。
