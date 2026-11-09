# Agent Note: Terminal-native presentation over the shared session controller

Status: implemented

English | [中文](2026-09-18-terminal-native-tui.zh.md)

## Problem

The terminal surface needs readable long conversations, safe interactive approvals and discoverable commands without creating a second implementation of session admission, compaction, planning or goals. Browser-shaped panels and append-only output make navigation and detailed tool review difficult in a terminal.

## Decision

The TUI uses a bounded alternate-screen layout with a cached row document, stable item-relative scroll anchors, a fixed composer, searchable commands and per-tool expansion. Rendering, search and folding operate on presentation state; submitted text and attachments still pass to the existing SessionController. Preset commands use the same registry executor as Web. Provider reasoning remains visible without a toggle.

Permission sheets expose only the existing single-invocation outcomes. Reject is the initial selection; selecting allow and confirming are separate gestures. This avoids assuming that the terminal can reliably report held-key repeats. Plan reviews use the existing question waterfall and require an explicit user interaction before confirmation.

The bundle mounts Web's read-only session-stats plugin. Decode and TTFT are session averages from its counters. No prefill rate is inferred from prompt size and TTFT because that latency is not an isolated prefill duration. Plan, goal activation, current todos and jobs are read from their existing services or projections.

## Alternatives considered

Keeping Static scrollback would preserve native shell scrolling but would not support item-local folding and stable in-app search without reprinting content. Recreating browser panels would spend terminal space without improving keyboard navigation. New permission modes and TUI-owned session logic would change semantics and are not introduced. A full syntax parser and an independent Git review service are deferred; highlighting is lexical and the diff view is explicitly limited to recorded tool changes.

## Consequences

The ordinary shell screen is restored on exit; users navigate conversation history inside the TUI while it is open. The row renderer and input routing have deterministic tests, with orchestration doubles clearly separated from production. A separate real React/Ink paint suite is supplied. Real PTY behaviour, dependency-installed builds and provider-level request comparison still require verification in the supported runtime. Fixture previews are not evidence of those integrations.
