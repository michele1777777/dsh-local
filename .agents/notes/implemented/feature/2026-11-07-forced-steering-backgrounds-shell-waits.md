# Agent Note: Forced steering backgrounds shell waits

Status: implemented

English | [中文](2026-11-07-forced-steering-backgrounds-shell-waits.zh.md)

## Problem

[Human steering during background job waits](2026-10-20-interactive-background-jobs.md) released a foreground Bash or PowerShell wait on every human next-step message. In the terminal, Enter during a turn steers, so each message sent while a command ran turned that command into a background job. Short commands that would have finished in seconds became jobs the model had to collect, and the footer counted every job record, so finished jobs looked like work that never ended.

## Decision

A steer leaves a foreground shell command attached; the agent reads the message at the next step after the command returns. `JobRegistry.holdWait(owner, release)` makes a foreground wait releasable, and `JobRegistry.releaseWaits(owner)` releases every held wait of one owner and returns the count. `waitForForegroundJob` holds its wait this way and no longer observes inbox insertions. The `job_output` wait keeps its existing release on human next-step input, because releasing it creates no job.

The terminal forces pending input with an empty Enter, Ctrl+Enter, or `/queue send`. When the current step has human input, the terminal first calls `releaseWaits`: a released shell call returns its background handle, the agent reads the message at once, and the existing completion reporter notifies it when the job settles. When nothing was released, or only next-turn input is pending, the terminal interrupts the turn and sends the pending input as before. The terminal footer counts running and stopping jobs only.

## Alternatives considered

**Interrupt on every forced message.** This cancels a long build or test run the user wanted to keep, which the [earlier note](2026-10-20-interactive-background-jobs.md) rejected.

**Keep releasing on every steer.** This is the behavior that created a job for each message.

**Release `job_output` waits only on force as well.** The upstream `job_output` release is covered by its own steering tests and never creates a job; changing it would only delay the message.

## Consequences

A steer sent during a long command waits for the command or for a forced send. Hosts without a force gesture, such as the Web client, leave shell waits attached until completion or timeout promotion. Other blocking waits, such as `wait_agent`, still cannot be released; they can adopt `holdWait`. The Bash steering and agent-loop integration tests prove that a steer alone keeps the command attached and that `releaseWaits` backgrounds it with one completion notice; the TUI tests cover the release decision and the live-job footer count.
