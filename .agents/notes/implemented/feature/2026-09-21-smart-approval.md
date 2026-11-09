# Agent Note: Smart approval owns review, not agent context or sandbox execution

Status: implemented

English | [中文](2026-09-21-smart-approval.zh.md)

## Problem

Web and TUI need fewer manual permission interruptions without splitting the agent's session behavior. Asking the task model to approve itself inside the conversation changes its context and confuses task completion with authorization. The existing experimental Auto preset also changes the execution bundle to Full access, which is not the requested workspace-preserving reviewed mode.

## Decision

The [shared Smart plugin](../../../../packages/interaction/smart-approval/README.md) contributes a dynamically available current-session preset, `workspace-write` plus `ask`, and a decide-or-delegate approval answerer. Manual remains the shipped default. The reviewer uses an independent same-provider/model request with bounded authority-labelled retained input, no tools and no main-session writes. Only a low-risk allow can grant an exact pending operation; a single authorized escalation may execute beyond the workspace sandbox, but does not change the session-wide bundle.

The existing approval service owns final outcomes and durable audit pairing. Optional machine-review metadata is attached through request-local asynchronous storage, preserving the borrowed request identity and isolating concurrent requests, even when callers reuse an object. No audit event is exposed as model context. A late recommendation cannot override cancellation, an explicit core `never`, changed authorization or missing human fallback. Explicit hook asks and plan/user questions are not automatically answered.

Smart captures live registry-owned execution identity and compares it to the open-step log, retaining separate authority for human instructions, parent delegation and untrusted constraints. Incomplete, oversized or non-text authorization defers to a human rather than truncating or inventing context. Unloading drains reviewer transports and restores loaded Smart sessions to ordinary workspace permissions. Source-level approval metadata is acknowledged in the [persistence record](../../../../docs/persistence-changes/2026-09-21-smart-approval-audit.md).

## Alternatives considered

**Reusing experimental Auto.** That preset removes the normal sandbox and answers every tool execution, with different denial and disposal behavior. A separate identity avoids changing stored selections or silently granting Full access.

**A turn inside the main conversation.** This changes context, compaction input and the model's role; a one-shot auxiliary request avoids those changes but still costs tokens and server capacity.

**A prefix allowlist for tests and builds.** Repository scripts can execute arbitrary code. Deterministic checks only veto or defer; they never classify an unknown script as safe by its name.

**Truncating the conversation to fit.** Dropping a restriction can turn an unauthorized action into an apparent match. Complete bounded retained instructions or human fallback preserve the uncertainty instead.

## Consequences

Manual, Smart and Full access are explicit, shared choices rather than separate Web/TUI policy implementations. The reviewer remains probabilistic and can share the main model's errors; the prompt and lexical checks are not a security boundary. Conservative fallback can be frequent after compaction, for command-originated tasks, non-text instructions, shell scripts or sensitive operations. Delegated children retain the existing non-escalating policy.

The package ships isolated protocol/lifecycle tests and a production-services Loader composition test with an external provider fixture. The isolated suite does not certify real providers, native terminals, the entire repository build or lint. Provider cancellation is required for bounded teardown, and review latency, tokens and inference-server contention remain separate from main conversation context size.
