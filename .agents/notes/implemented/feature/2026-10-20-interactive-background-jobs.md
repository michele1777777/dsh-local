# Agent Note: Human steering during background job waits

Status: implemented

English | [中文](2026-10-20-interactive-background-jobs.zh.md)

## Problem

A human message can enter the running agent's inbox while a shell tool still waits for completion. The agent cannot read it until that wait returns. The terminal also lists job ids without a live output inspector.

## Decision

`job_output` waits yield to human next-step input. Bash and PowerShell foreground waits yield only when the human forces pending input, as [Forced steering backgrounds shell waits](2026-11-07-forced-steering-backgrounds-shell-waits.md) decides. Both retain the existing job producer, output cursor, and completion reporter. Next-turn input remains queued. Ordinary cancellation still takes priority over steering.

TUI job rows and the footer open a bounded `job.follow` inspector. Web rows also open when a settled job has no output. Observation never advances the model's output cursor and closes with its panel or session. This extends the existing [owned lifecycle records](../bug-fix/2026-09-30-job-session-lifecycle.md); their persistence and teardown decisions remain unchanged.

## Alternatives considered

**Cancel the tool call on every human message.** That cancels foreground shell work and loses the running computation the user wants to preserve.

**Add another completion notifier.** The registry already distinguishes awaited settlement from background settlement. A second notifier risks duplicate model-visible results.

## Consequences

Only producers already represented as jobs can yield this way. This does not detach arbitrary synchronous filesystem tools. The observer retains a 128 Ki UTF-16 tail, marks gaps, and releases its stream without stopping the producer. A real agent-loop test proves that a running shell survives steering, its notice wakes an idle agent, and `job_output` collects the result. TUI tests cover click targets, live output, bounded retention, and closing observation.
