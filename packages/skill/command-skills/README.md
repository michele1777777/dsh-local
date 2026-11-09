---
description: "The /skills command for interactive compositions: what it lists, what you see, and how to mount it."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-skills

English | [中文](README.zh.md)

## Summary

`dsh-command-skills` adds a `/skills` command to chat UIs: type it and you get the skills installed for the current session — each skill's name, description, and the root where it was discovered. The list matches what the session's skill registry resolves, so it also shows skills a model cannot load. The command takes no arguments, sends nothing to the model, and reports `No skills are installed for this session.` when nothing is discovered.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Type `/skills` in a chat UI to see which skills the current session can invoke. The shipped `dsh` terminal chat mounts the command, so it is usually already available.

### Using the command

| Input | Result |
|---|---|
| `/skills` | One line per installed skill — name, description, and discovery source — under a count line. |
| `/skills` with nothing installed | `No skills are installed for this session.` |
| `/skills <anything>` | `Usage: /skills (no arguments)` — the command takes no arguments. |

Descriptions longer than `descriptionMaxLength` (default 160 characters) are collapsed to one line and truncated with `...`.

### What you see

Example output:

```text
3 installed skills:
- design-taste-frontend — Art direction for websites... [user-dsh]
- impeccable — Use when the user wants to design... [user-dsh]
- playwright-cli — Automate browser interactions... [user-dsh]
```

The bracketed source names the root that produced the entry: `project-dsh`, `project-agents`, `custom`, `user-dsh`, `user-agents`, `bundled`, `runtime`, or a provider-specific label. Skills whose frontmatter disables model invocation are still listed: the command reports what is installed, not what a model may load.

### Composing the command

Mount the command registry, the skill registry, the working-directory service, and this plugin:

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

The shipped `dsh` base mounts the registries and the working-directory service; the terminal chat mounts this command. Surfaces that compose no command adapter have no `/skills`.

| Field | Default | Meaning |
|---|---|---|
| `descriptionMaxLength` | `160` | Maximum rendered description length per skill; minimum 3. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the command; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One read path with the model-facing catalog.** The handler calls `ctx.skills.list()` with the receiving agent as the viewing scope and the agent's recorded working directory as `cwd` — the same lookup `tool-skill` uses for the model catalog — so the human list and the model catalog resolve the same layered registry.
- **Invocation-neutral listing.** Registry summaries carry model and user invocation policy; the command renders every entry and leaves policy filtering to the surfaces that need it.
- **Human-only lifecycle.** `command/run` and `command/done` are log-only events; the result text never enters model history.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `/skills` registration, argument rejection, description truncation, line rendering |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the command to the registry, the discovery roots, and the adjacent model-facing surfaces.

- [Skill registry](../skill/README.md) — the layered provider registry this command reads.
- [Skill filesystem provider](../skill-filesystem/README.md) — the roots and ranks the discovery sources name.
- [Tool skill](../tool-skill/README.md) — the model-facing catalog and `/name` invocation beside this human view.
- [Commands package](../../interaction/commands/README.md) — the registry and dispatch contract behind chat commands.
- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the shared skill vocabulary.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/skills` listing

#### What the model sees

Nothing. The slash input and the rendered list never enter a model request; only the log-only `command/run` / `command/done` pair records the invocation.

#### Token effect

The command adds no model tokens.

#### KV Cache effect

Discovery and rendering do not touch model history, so the cache is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the command is a poor fit; they are the current package constraints.

- **Catalog view only** — `/skills` lists and does not load; invoking a skill stays the `/name` gesture or the model's `skill` tool.
- **No filters or detail arguments** — the argument-free form lists every resolved skill; name filters and per-skill detail views would need a shared command grammar across adapters.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above and the package code.

- **Detail subcommand, undecided** — `/skills <name>` showing one skill's frontmatter, path, and resources remains open; it needs the same argument-grammar decision as the other command filters.

</details>
