# Agent Note: Human steering during background job waits

Status: implemented

[English](2026-10-20-interactive-background-jobs.md) | 中文

## Problem

当 shell 工具仍在等待完成时，用户消息可以进入运行中代理的收件箱，但代理必须等到工具返回才能读取。终端也只列出任务标识，没有实时输出查看器。

## Decision

`job_output` 等待可被用户当前轮次消息解除。Bash 和 PowerShell 的前台等待仅在用户强制发送待处理输入时解除，见[强制 steering 将 shell 等待转入后台](2026-11-07-forced-steering-backgrounds-shell-waits.zh.md)。两者都保留现有任务执行、输出游标与完成通知机制。下一轮消息仍然排队。普通取消操作优先于当前轮次消息。

TUI 任务行和底栏打开有界的 `job.follow` 查看器。Web 中已结束且没有输出的任务也可展开。查看操作不会推进模型的输出游标，并随面板或会话关闭。此机制扩展现有的[所属任务生命周期记录](../bug-fix/2026-09-30-job-session-lifecycle.zh.md)，不改变其持久化与清理决策。

## Alternatives considered

**每收到用户消息就取消工具调用。** 这会取消前台 shell 工作，丢失用户希望保留的计算。

**增加另一套完成通知。** 注册表已经区分有人等待的结束与后台结束。第二套通知可能向模型重复提供结果。

## Consequences

仅已注册为任务的执行器支持此行为，不会分离任意同步文件系统工具。查看器保留最新 128 Ki UTF-16 代码单元，标注缺失片段，并在关闭流时保持任务运行。真实代理循环测试验证 shell 在用户消息后继续运行、完成通知唤醒空闲代理以及 `job_output` 收集结果。TUI 测试覆盖点击、实时输出、有界保留及关闭观察。
