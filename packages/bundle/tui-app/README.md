---
description: "Full-screen terminal workspace over the Web SessionController: browsable transcript, safe permissions, recorded diffs and shared session metrics."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

## Summary

`dsh-tui-app` is the terminal profile layer of dsh: a keyboard-first, mouse-aware, full-screen workspace over the **same SessionController and per-session presets as Web**. Run `dsh` in a project directory to start a session there, or `dsh resume` to reopen a saved one. It changes how the conversation is displayed, not how model requests, session state, compaction, planning, goals or permissions are executed. It opens no HTTP listener, and without a terminal it runs a line-oriented plain-text mode.

## Table of Contents

- [Use this package](#use-this-package)
- [Build and test](#build-and-test)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The screen keeps a one-row header, a scrollable conversation, a multiline composer between two rules and a one-row status line in fixed regions. Settled messages are cached and only the visible rows are painted. Tool details and reasoning expand inline, recorded file changes have numbered hunks, and provider-supplied reasoning is always included; there is no `/reasoning` command or hide-reasoning option. The sections below cover each part of the screen in the order you meet it.

### Start and resume

```sh
dsh                                      # new session in this directory
dsh "fix the failing tests"               # opening prompt
dsh resume                               # searchable session picker
dsh resume --all                          # also show other directories
dsh resume --last                         # latest activity in this directory
dsh resume session-<uuid>                  # exact saved session
dsh resume session-<uuid> "continue here"  # resume, then send
dsh -r                                   # same picker
dsh -c                                   # continue latest session
dsh --model provider/model --effort high
dsh --preset standard                    # new sessions only
```

`dsh continue` is the long form of `dsh -c`. Resume keeps the saved preset, working directory and persisted model state; `--preset` with resume or continue is rejected rather than changing the session's tool plane, and `--resume` with `--continue` is rejected as contradictory. A resume argument that is not an exact session ID is accepted as an ID prefix or an exact title only when it matches one session.

Session selection excludes blank and delegated subagent sessions, but includes human forks. Search matches displayed titles, IDs, directories and dates, and also queries saved message content through the existing controller search API; matches stay inside the picker's current directory or all-directories scope and retain the core's result limit. Tab switches that scope. The selected row's preview shows message and tool-call counts, the directory, and first-prompt and last-answer excerpts; it reads a detached log through `sessionQuery.readSession` without activating an Agent, and it is shown beside the list from 96 columns and at least 12 rows; on a narrower terminal it is stacked under the list when the terminal has at least 18 rows. A click selects a row; Enter or **Resume** opens it. Stop the active turn and send or detach staged attachments before changing sessions.

### Screen and mouse

The UI uses the terminal's alternate screen; exiting restores the ordinary shell screen. Use the application's scrolling and search while it is open, not shell scrollback. Minimum supported dimensions are **29 columns × 12 rows**; smaller terminals display a resize notice while retaining the draft. One column is reserved to avoid bottom-right terminal autowrap. The header holds a `DSH` label, the session title, and on the right the working directory's name, hidden below 60 columns, and the agent preset. The indicator row under it shows the goal (`◎`), `▣ plan` and imported messages on the left, and the task checklist on the right as a meter with its done/total count and the task in progress. On a terminal with at least 28 rows, a blank row also sits under the header, under the indicator row and above the composer's top rule.

The UI enables button-event mouse reporting with SGR coordinates (`1002`/`1006`), so the wheel scrolls the conversation instead of sending cursor keys, left clicks reach on-screen controls, and the application draws its own drag selection; exit hands mouse handling back to the terminal. While reporting is on, click and drag belong to this application; most terminals still select text with Shift held, and `DSH_TUI_MOUSE=off` at startup leaves the mouse to the terminal. Clicks act only on currently visible targets; releases, drags, and modified or non-left clicks run no actions.

While the UI is open it owns the terminal: anything else the process would print to stdout or stderr (Node warnings, plugin diagnostics) is appended to `$DSH_HOME/logs/tui-output.log` instead, a note above the composer names that file for a few seconds, and exit prints a one-line pointer to it. Every resize invalidates pending output and the painted row cache; the next committed frame erases and redraws the alternate screen at its new dimensions, including after a shrink and grow back to the same size before React paints. Normal frames update only changed rows at up to 60 fps. The conversation keeps its previous wrapping, clipped to the frame, until the width has been stable for 80 ms, then re-wraps once. Unchanged screen rows skip React reconciliation.

### Conversation display

Every item sits behind a two-cell margin. A user prompt is bold on a tinted band across the full width, behind an accent bar `▌` in the margin, and an answer starts with an accent `•` on its first visible row. A collapsed tool call is two rows. The command row holds a status dot, the verb such as `Read`, `Edit` or `Run` padded to one width and bold in its category colour, the target, and the duration after a middle dot, muted, as in `• Run    pnpm test --filter auth · 1.8s`. The description sits on the row below, hanging under the verb on a thin connector (`└─ Run authentication tests`), in a legible secondary grey; it wraps when long and is never cut. A command too long for its row is cut in its middle with `…` and keeps the duration beside it. Both rows are the click target. The description is what the model said the call does (a command's `description` argument), from the moment the call starts; a call without one shows its result in a few words there, such as `└─ +2 −1`, `└─ 14 matches` or the last output line, and a call with neither is the command row alone. A failure or interruption follows the description in its semantic colour, as in `└─ Run authentication tests · exit 1`; a call whose tool reports an error or whose command exits non-zero or on a signal gets a red dot instead of a green one, an interrupted call a yellow dot, and a running call a ring `◌`. A settled, folded thought is one row, `✦ Thought` and `2 lines`, with its reasoning time after a middle dot when the stream recorded it. On a terminal with at least 28 rows, each collapsed tool call and folded thought has a blank row above it, and a blank row separates a thought from the answer that follows it; below 28 rows none of these blank rows are shown, apart from the single blank row that opens the conversation, and consecutive calls and thoughts form a list without them. Click a row to open its details. An open tool call has a title row such as `▾ • Run    pnpm test --filter auth · exit 0 · 1.8s`, with the command, then the exit code or other short note, then the duration, each behind a middle dot; its body stands behind a heavier dashed rail (`┇`) in the tool's colour, with no box. Click the title row to fold it back; Ctrl+O and `/expand` show every tool open. Open thoughts and slash command results stand behind a dotted rail (`┊`) in their colour. Expanded command tools show Description (when supplied), Command and Result, including background commands; their raw Arguments are omitted from the normal view, and raw inspection still contains the original arguments. Other tools show Arguments and Result, and full output remains reachable by scrolling. Ordinary result text uses the message foreground; headings, borders and metadata stay muted, while errors and warnings keep their semantic colours. A code block stands on a tinted band without borders; its header row names the language and carries **Copy**, and there is no closing rule. Reasoning stays folded until opened. Folding changes the view, never the saved messages or tool arguments. Rows, rules, cards and the status line span the whole terminal width except its last column; prose wraps at the same width, without a separate reading measure.

Manually expanded, completed tool outputs close after downward scrolling passes their final row, preserving the current reading position. Scrolling upward, streaming updates and partially visible outputs leave them open.

Notices show a red dot and a red rail for an error, titled by its error code, a green dot for a success, and `■` for information. A context pruning pass ends with a `Context pruned −N%` row, with before and after meters and one icon per judged output: `●` kept, `◐` truncated, `○` dropped. A running context compaction has one live row directly under the last item, with an activity mark, `Compacting context`, the context size in tokens and the elapsed time at the right edge.

The top line of the conversation names the prompt whose answer you are reading: the latest user message that has scrolled above the viewport, with its position among all prompts. Click it (or press Alt+Up) to bring that message to the top; the line then names the prompt before it, so repeated clicks walk back through the conversation. Alt+Down walks forward and, after the last prompt, rejoins the live tail. With no prompt above the viewport the line is absent. While the conversation is scrolled up, a centred button below it shows how many rows lie below the view; clicking it, Ctrl+End, or End with an empty draft rejoins the live tail.

An empty conversation shows the welcome whale, a 60×15-cell braille animation, above a blank row and the welcome text. The group is centred vertically in the conversation area, the whale and each row of the welcome text are centred horizontally. Under the title `What are we building?`, one muted row shows the working directory and the model with its effort. The whale plays its 6.4-second loop from the first frame, in which two clouds of dots cross, gather into a humpback whale that blows and blinks, and scatter again. It appears only when the conversation area has 64 columns, the whale's 60 plus two on each side, and 22 rows for the whale, the blank row and the six rows of text; otherwise the welcome text is centred alone. The whale leaves with the first message and returns, from its first frame, after `/clear` and on a switch to an empty session. Slash commands in the conversation are drawn in their own light-blue tone.

While the latest reasoning segment is still thinking, its label `› Thinking… · 12s · 2 lines` carries the Thinking scene, a 48×12-cell braille sky in which twenty-four constellations are drawn star by star, 6.4 seconds each, with no frame around it. The scene spans the whole width under the label: the figure is centred, and grey background stars that light up and go out with it fill both sides. The finished figure's Latin name types itself out at the right end of the label's row, before a `✧` mark. Each thought opens on a constellation chosen from its id, so consecutive thoughts start on different figures. Under the scene, the latest two rows of reasoning show behind a dotted rail (`┊`), muted and italic, with a cursor after the last row. Opening the label replaces the scene and this tail with the reasoning text, two cells in; folding it again brings the scene back. A terminal shorter than 26 rows or with fewer than 48 columns inside the margin gets the Thinking mark instead, a 12×3-cell animation of pulses cascading through twelve nodes, on the label's row, with the same two rows of reasoning below it; when the label and the mark do not fit on one row, the label wraps alone. The scene leaves when reasoning settles and the thought folds to one row. The Waiting for model label carries the same scene in the same position.

The four animations are pre-rendered gzip JSON files in `assets/anim/`: `welcome-whale.json.gz`, `thinking-constellations.json.gz`, `thinking-synapse.json.gz` and `pruning-sieve.json.gz`, each one loop at 10 frames per second with one theme tone per braille cell, advanced by the shared 100 ms animation tick. A file is read and checked the first time its animation is needed and then kept while the TUI runs. The constellation file also carries one caption per frame. A file that cannot be read, or whose size, frame count, tones, glyphs or captions differ from its declaration, is reported once to `$DSH_HOME/logs/tui-output.log`, and nothing is drawn in its place; the labels and the welcome text remain. The light theme gives every tone its own colour, and mono draws the dots in the terminal's default colour.

Thinking shows elapsed seconds from the first reasoning chunk; Thought freezes that duration when reasoning ends, reconstructed from recorded stream timestamps on resume. Clicking the label, the scene or the mark keeps the reasoning disclosure behaviour. `DSH_TUI_MOTION=off` holds the welcome whale on its fully formed pose, the Thinking scene on a finished, named figure, the Thinking and pruning marks on their first frame, and keeps the title spinner still.

While Laya prunes context, a live row follows the conversation where live Thinking would sit: the pass's real phase label, `laya_context_pruner · pruning context`, `Starting Laya`, `Stopping Laya`, `DS4 · freeing cache memory` or `DS4 · restoring cache capacity`, on the middle row of the pruning mark, a 10×3-cell braille animation two cells after it. In the mark a scanner reads grains on a dotted barrier, kept grains turn green and pass, discarded grains turn red and crumble. It moves in a 4.8-second loop only in the prune phase and for a pass that reports no phase, from its first frame each time pruning starts; the phases that manage the model show its first frame still. The mark is decoration: it does not follow the pass's progress. The label and mark leave as soon as the pass ends, and the result row follows them. The status line shows the phase label alone, without a spinner.

Themes: `DSH_TUI_THEME=light` or `mono` chooses the initial palette and `NO_COLOR` selects monochrome. In-app theme changes are local presentation state and do not modify model settings. Standard terminal colours respect the user's terminal palette; there is no forced background colour. Dark and light themes tint the prompt band, code blocks, the neutral command band, the selection, search matches and added or removed diff lines; the `mono` theme has no tints and shows selections and matches in inverse video, and tints need a terminal with 24-bit colour.

### Composer and keyboard

| Key | Action |
| --- | --- |
| Enter | Send; run an exact command, or run the highlighted slash suggestion |
| Enter while a turn runs | Steer it: the agent reads the message at its next step |
| Tab while a turn runs | Queue the draft for the next turn instead |
| Enter on an empty prompt | Send pending messages now: a running shell command moves to the background, otherwise active work is interrupted; at idle, start their turn |
| Ctrl+Enter | Submit the draft, then send it immediately as an empty Enter would, when distinguished by the terminal |
| Alt+Enter / Shift+Enter / Ctrl+J | Newline, when distinguished by the terminal |
| Backslash then Enter | Portable newline fallback; removes the final backslash |
| Left/Right, Home/End | Grapheme movement; logical line boundaries |
| Ctrl+Left/Right, Alt+Left/Right | Word movement |
| Ctrl+A/E/U/K/W | Line start/end; delete to start/end; delete previous word |
| Up/Down | Move through wrapped visual lines, then prompt history at the edges |
| Ctrl+_ / Alt+U | Undo / redo composer edits |
| Ctrl+R | Search submitted prompt history; Enter restores the newest match for editing |
| Ctrl+S | Stash the current draft, or swap it with the stashed one |
| Ctrl+G | Edit the current draft in `$VISUAL`/`$EDITOR`; return without sending |
| Alt+V | Read a local clipboard image into staged attachments; never auto-send |
| Tab / Up/Down / wheel in `/` menu | Complete / select a fuzzy command suggestion |
| Left/Right at the end of a `/` query | Switch the menu tab: All, Agent, Skills, Terminal |
| Page Up/Down, Shift+Up/Down | Scroll the conversation without changing the draft |
| Left click the prompt header / Alt+Up | Jump to the prompt named on the top line; repeat to walk back |
| Alt+Down | Jump to the next prompt; after the last one, rejoin the live tail |
| Alt+G / click the goal under the header | Open the goal panel: full objective, status, and Edit (puts `/goal edit <objective>` in the composer), Pause/Resume, Clear |
| Wheel, Ctrl+wheel | Scroll the conversation or open panel by three rows / by page |
| Wheel over the draft | Scroll the draft itself; typing returns it to the cursor |
| Left-button drag | Select painted text above the composer; releasing copies it and reports the character count |
| Click / drag in the draft | Move the cursor there / select draft text, copied on release; Backspace or Delete removes it, typing or pasting replaces it |
| Backspace/Delete on a paste placeholder | Remove the whole pasted block in one key |
| Left click **Copy** on a code block | Copy the original code block, not its rendered lines |
| Left click a tool row or thinking heading | Expand or collapse its details inline |
| Click the plan or tasks indicator under the header | Open the Tasks panel |
| `?` on an empty prompt, or click `? keys` | Show the Keys box above the composer; Esc or the next key hides it, and that key then acts as usual |
| Click `×` on a queued row or a file chip | Remove that queued message or staged file |
| Ctrl+Home / Ctrl+End | Conversation start / resume following the live tail |
| Ctrl+O | Enter/leave transcript browsing |
| Up/Down in transcript | Select previous/next conversation item |
| Enter / Space in transcript | Expand/collapse the selected item |
| `r` in transcript | Toggle raw tool arguments/results in the document |
| Ctrl+F | Search the rendered conversation rows |
| Enter, then `n` / `N` in search | Finish query editing; next / previous match |
| Esc | Close the Keys box, clear a selection, dismiss the slash menu, close search or a panel, or interrupt active work |
| Click the preset in the status line / `/permission` | Show the active session preset and choose from the live permission catalog; the status line names the preset only when it differs from the default |
| Ctrl+C | Copy the current selection, cancel running work, or clear the draft; pressed twice within 1.5 s when idle and empty, exit |
| Ctrl+D with empty draft | Cancel, save and exit |

Editor movement and deletion respect grapheme boundaries. Keyboard encodings and ambiguous-width Unicode characters depend on the terminal. Key-repeat events reported by the terminal are ignored. Queued messages and short-lived messages sit above the composer's top rule, and staged files are chips on that rule. A failed local action, such as a command without its argument, shows there with the command's correct form until the next keystroke; other messages clear after five seconds; both clear when a prompt or command is sent, and neither enters the conversation.

Queued messages are numbered rows above the composer, each with `next turn` or `this turn`, its text and a `×` that removes it; beyond three, one row reads `+N more queued · /tasks lists them`. Chips that do not fit on the top rule are counted as `+N more`, and the `×` on each chip removes its file. The command palette marks its chosen command with a selection background across the row and shows the position (`1 of N`) on the left of its footer, with the keys on the right. Search (Ctrl+F or Ctrl+R) takes the composer's line as a search field with a `⌕` mark, the match position and the keys that apply on the right; only the matched text is marked, and the first match on the row the search is on is filled in the accent colour.

### Steering and queueing

A message sent with Enter while the agent works joins the running turn at its next step. A steer waits for a running shell command to finish. Press Enter again with an empty composer to send it now: a running shell command moves to the background, the agent reads your message at once, and a completion notice tells the agent when the command finishes; with no such command, active work is interrupted and pending input is sent after cancellation finishes. Ctrl+Enter submits and forces delivery in one action when the terminal distinguishes it; otherwise use two presses of Enter. Tab holds the draft for the next turn. Interrupting with Ctrl+C or Esc preserves pending input and starts it next; interrupting again keeps the remaining input parked. An explicit empty Enter always requests delivery, including after a previous interruption.

### Pasting and prompt history

A paste longer than 4 lines or 512 characters collapses to `[Pasted text #1 +42 lines]`. The text itself is retained and expanded into the prompt at submission, so the model always receives what was pasted; the placeholder is composer state. One Backspace or Delete removes a whole placeholder, and pasting the same content again expands it in place for editing. Numbers are unique within the TUI process and the last 20 pastes stay expandable.

Bracketed paste has its own input channel: pasted newlines, `/commands` or `y` **never submit, execute or approve**. Prompt whitespace is preserved; pasted CRLF is normalized to LF. Failed admissions restore the draft for editing and keep staged attachments. An unsuccessful opening prompt is restored for editing rather than retried silently.

Prompt history is local to this TUI process (the last 100 submissions), not a new persistent session store. Undo history keeps the last 100 edits.

### Slash commands

The `/` menu has tabs for All, Agent (the session preset's registry commands), Skills (user-invocable skills) and Terminal (commands this app handles), each with its match count; Left and Right switch tabs while the cursor is at the end of the query. With nothing typed after `/`, All lists commands under Agent, Skills and Terminal headings, Terminal groups its commands under Session, Model & context, View and Settings, and Up and Down skip the headings. Typing fuzzy-matches command names and descriptions and ranks the matches, with a kind column from 60 cells. Argument hints follow command names, muted. Fuzzy matching never changes command execution semantics. A registry command wins a name collision except the reserved `/exit` control and the removed reasoning toggle; any command name wins over a skill of that name.

| Commands | Behaviour |
| --- | --- |
| `/help` | Scrollable command and keyboard reference |
| `/status`, `/context` | Session, model, context estimate, token counters and measured timings |
| `/new [preset]`, `/resume [id\|--last\|--all]`, `/sessions` | Shared session creation/resume and searchable picker |
| `/model [provider/model]`, `/effort [value\|default]` | Shared model validation/persistence; no argument opens a picker |
| `/skills` | Opens a searchable picker of the session's user-invocable skills; choosing one places `/name ` in the composer |
| `/<skill-name> [task]` | Sends the line as a prompt when it names a user-invocable skill and no command; `tool-skill` injects the skill host-side, as for Web. Skills also appear in the `/` menu |
| `/rename title`, `/fork` | Shared title persistence; fork at the last completed turn |
| `/expand` | Expand/collapse all tools |
| `/permissions` | Read-only policy and pending-request inspection |
| `/tasks`, `/jobs` | Read-only plan/goal/todo/job/queue inspection with clickable job rows |
| `/theme [dark\|light\|mono]` | Change presentation colours only; no argument opens a picker |
| `/copy [code\|raw]` | Copy the last assistant Markdown; `code` copies its most recent fenced block |
| `/clear`, `/cwd` | Clear display only / show recorded working directory |
| `/export path.md` | Export the complete transcript, including reasoning; refuse existing files |
| `/exit` | Cancel, flush owned sessions, restore terminal and exit |

`/compact`, `/goal`, `/plan`, `/permission` and other registry commands use the same scoped `registry.execute(agent, line, attachments, signal)` as Web. The TUI does not invent commands absent from the current preset. In an interactive terminal, `/skills` opens the picker above instead of the registry's chat listing, and `/permission` without an argument opens the live preset picker. `/permissions` is a read-only UI inspector; it is **not** a second policy setter and does not replace a registry-provided `/permission` command.

### Recorded changes

An edit tool's details show **the changes that tool reported**, not the current Git working-tree diff. Expanded hunks switch to a paired **BEFORE / AFTER** view at 110 available content columns and unified below that. Added and removed lines stand on green and red tints, with the changed part on a stronger tint, and each line has one line-number column. Both sides retain wrapped content and line numbers; no working-tree read or model request is added. Very large replacements use a labelled non-minimal comparison; full content is retained. Unknown tool results remain accessible through raw details. Syntax highlighting is lightweight lexical highlighting, not a full language parser. Images are represented by attachment labels, not rendered inline.

### Copy, links, images and local editing

Every assistant code block's top border has a clickable **Copy**. The target references the original message and block index, not wrapped or sanitized display rows. It preserves indentation, tabs, Unicode, CRLF/LF and trailing newlines; fences, box borders and ANSI colours are never copied. Streaming blocks copy what is available **at that click**. `/copy` and `/copy raw` copy the last nonempty assistant answer as raw Markdown; `/copy code` copies the latest assistant code block. Neither command includes hidden or provider-unavailable reasoning or runs the copied text. Code blocks in plan-review and question cards also have **Copy**, and the permission card has a `Copy` button at the right of its directory row that copies a shell command without approving or executing it.

Native clipboard adapters: Windows/WSL `powershell.exe` (Windows Forms), macOS `pbcopy`, Linux Wayland `wl-copy`, or X11 `xclip`/`xsel`. Helpers are invoked without shell-evaluating message content. If native copying is unavailable, OSC 52 is attempted only on a TTY, including an escaped tmux passthrough. Native success displays **Copied**; OSC 52 displays **Sent**, because a terminal may refuse clipboard writes. Over SSH, only the terminal fallback is used; the server's desktop clipboard is not touched. DSH installs no helper.

`DSH_TUI_CLIPBOARD=auto|native|osc52|off` controls text copying. OSC 52 is capped at 100,000 UTF-8 bytes; use a native helper or `/export` for larger blocks. Mouse reporting needs to be on to use buttons; Shift+drag or `DSH_TUI_MOUSE=off` allows ordinary emulator selection, depending on the terminal.

`Alt+V` explicitly reads a PNG-compatible local clipboard image: Windows/WSL Windows Forms, macOS AppKit via `osascript`, Linux `wl-paste` or `xclip`. Size limits come from the existing Web image admission settings. It stages the same image content part as Web; it does **not** submit a message. The `×` beside each staged file above the composer removes it. Clipboard-image reading over SSH is deliberately unavailable. Images still appear as labels in the TUI, not inline pixels.

`Ctrl+G` lends the terminal to `$VISUAL`, then `$EDITOR` (fallback: Windows `notepad.exe`, otherwise `vi`). Quote paths with spaces. Common Code, Cursor and Sublime launchers receive `--wait`; other GUI editors must be configured to wait until the file is closed. Launch failure, nonzero exit, interruption or an edited draft over 8 MiB keeps the original draft. Edited text returns to the composer only; the user must still send it. Temporary files are private and removed on completion. This local UI action is not an agent shell command.

HTTP/HTTPS links and generated local file references use OSC 8. Open them with the emulator's link gesture (often Ctrl+click), not an agent tool. Unsupported terminals display normal text; the associated file opener may ignore line fragments. No `javascript:` links, raw model escape sequences or implicit UNC network-share targets are emitted. `DSH_TUI_LINKS=off` or `TERM=dumb` disables links.

### Text selection

Drag within the conversation and scroll with the wheel or page keys to extend the selection across offscreen rows. Releasing copies the selected text and keeps its highlight while scrolling; Ctrl+C copies it again and Esc clears it. Selection holds the rendered text stable during streaming and excludes the composer and status bars.

### Panels and attention

A permission request, a question or plan review, and the short pickers (`/model`, `/effort`, `/theme`, `/permission`) take the composer's place as a card; the conversation stays visible above the card and the status row stays below it. The help, context, tasks, jobs and goal panels, the session picker with its preview, and the skills picker take the whole screen above the status row; they never split the screen. Esc returns to the chat. Page Up/Down, Up/Down, Home/End and the wheel scroll an open help, context, tasks, jobs or goal panel; in a picker, Up/Down moves the selection and typing filters the rows. The `/help` panel lists keys by section, `/context` shows the context meter, token use and session averages, `/tasks` shows the checklist with one row per task (a finished task has a green dot and `done`, one in progress `◐`, one pending `○`) and the queued messages, `/permissions` lists recent requests with their decisions, and `/jobs` counts jobs by status on its first row. A short picker's card marks the current row with `●`. `DSH_TUI_LAYOUT=auto|single|split` records a layout mode, but every mode currently renders this single-column view.

`DSH_TUI_NOTIFY=off|bell|desktop` defaults to bell; `DSH_TUI_TITLE=off` disables title changes. These are presentation settings, not persisted session state. Alerts fire on new permission or question requests, or on a running-to-idle transition, only when the terminal reports loss of focus. **Turn ended** does not claim task success. Desktop alerts use opt-in OSC 9 and require emulator support; without focus reports or notification support no alert is guaranteed. Tab titles use sanitized session names and `working` / `attention` / `ready` status, with title-stack restoration requested on exit. While a turn runs, a small circle of braille dots (`⣾⣽⣻⢿⡿⣟⣯⣷`) turns before `DSH` every 100 ms. Neither feature changes a model prompt or publishes data to an external notification service.

### Permissions and interactive questions

The permission card shows tool, owner session, working directory, reason and available complete arguments, followed after one blank row by the choice and its keys, which stay pinned to the bottom only while long details scroll; the card has a yellow border titled `! Permission required`, and the current choice is filled in the warning colour. Descendant subagent requests retain their actual owner. Each new request defaults to **Reject**. The card takes the composer's place, as described under Panels and attention. A command is shown whole on a neutral band with its directory and a `Copy` button; the complete arguments sit under an `▸ Arguments · N fields` fold that is closed when a command is shown, and `a` or a click opens or folds it.

`y` selects **Allow once**; Left, Right or Tab switches between the two choices; **Enter** confirms the selection. Clicking a choice selects it, and clicking **Enter confirm** in the keys confirms it, under the same guard. Copying a displayed command does not select or confirm permission. `n` or Esc rejects. Page Up/Down scroll details. Confirmation and `n` ignore key-repeat events and the first 250 ms of a new request, and the two-key allow gesture avoids held-`y` auto-approval in terminals without explicit repeat metadata.

These are the core's existing `allowed-once` / `rejected` outcomes. There is **no invented "allow for session"**, no added auto-allow mode and no bypass of shared policy. The core's `never` policy means deny, not unrestricted access.

Question and plan-review cards display full Markdown and option descriptions; the option in focus stands on the selection background. Options are numbered, and digits 1–9 pick the option with that number, so a custom answer that starts with a digit is opened with Tab first. Up/Down navigates options; Space toggles the highlighted option; Tab switches to custom text, and typing also starts it; Enter confirms, after the same 250 ms guard. A single-select question sends either the highlighted option or the custom text, whichever has focus; multi-select keeps checked options beside custom text. Multiple questions retain the existing answer fields. Page Up/Down scroll details. Esc cancels through the existing waterfall. Pending requests hide the composer without discarding its draft.

### Smart approval

`/auto-approve smart` selects the shared same-model reviewer; `/auto-approve manual` restores ordinary workspace approval. `/auto-approve status` reports the effective mode and `/auto-approve history` shows the recorded decisions. The status line reports reviewer activity; `/permissions` shows the authoritative outcomes, including human fallback and cancellations. The bundle mounts the reviewer with its default limits, keeps `run_code` human-only, and lists `plugin_manager` in `escalatingTools`; sessions stay manual until explicitly switched. See [Smart approval](../../interaction/smart-approval/README.md) for the exact scope, extra token use and one-call escalation semantics. Plan reviews remain interactive.

### Prepared conversations

When the composition registers `/prechat` from [dsh-prechat](../../context/prechat/README.md), it accepts pasted `USER:` / `ASSISTANT:` pairs or a `.txt` path on the routes listed in that plugin's `routes` configuration, then previews them before opening a new chat. A multiline `/prechat` draft runs as a command on Enter instead of being sent as a prompt. The indicator row below the header counts the imported messages of the current session.

### Background jobs

Click the job count in the status line or run `/jobs`, then click a job to inspect its current status and retained output. Each job takes two rows: a status dot in its semantic colour (a ring `◌` while it runs), what the job does (the description the model gave the command that started it, else the command) and its running or final time, then the command and its progress or end reason, muted. Running jobs come first, then finished jobs, most recent first. `/tasks` offers the same clickable rows. The first row of `/jobs` counts jobs by status, for example `1 running · 1 failed · 2 done`. Output follows live without consuming the agent's read cursor; closing the panel releases only the observer. The display keeps the latest 128 Ki UTF-16 code units and marks missing earlier output.

Enter during a registered shell command keeps the command attached; the agent reads your message when the command finishes. An empty Enter afterwards moves the command to the background so the agent reads your message at once; the job continues and its existing completion notice lets the agent collect the result. Enter during a `job_output` wait releases that wait at once. Tab still queues for the next turn. Explicit interruption still cancels foreground work. The status line counts running jobs only and shows nothing once they finish; finished jobs remain listed in the panel.

### Context, activity and performance

The status line is one row; as the terminal narrows, its separators tighten and then the `? keys` control, the model, the prefill and decode speeds, jobs and the work timer leave before the context bar, token counts and percentage, and the non-default permission preset leaves last. Detailed values remain in `/context`. While a turn runs, it shows a work timer: wall time from the latest admitted human message, including model calls, tools, pruning and approval waits.

- Context pressure is an **approximate** projected token count/window ratio, labelled `~` in `/context`, from shared projections; it is not a newly calculated request size.
- Token usage uses the shared provider counters. Output already includes reasoning tokens; cache counters are not counted twice.
- The status line shows `prefill N · decode N tok/s` over the **latest 10 model responses**, replayed history included: summed tokens over summed wall time, so long responses weigh more than short ones. Each response is timed from its log events. Prefill is the uncached input tokens over the time from `step/start` to the first streamed token; decode is the output tokens, reasoning included, over the time from the first token to the committed message. `/context` shows the same two figures, then the session averages below.
- Session decode speed is `1000 × decodeTokens / decodeMs` over every step carrying usable core timing and usage, and TTFT is `ttftMs / ttftSteps`; both appear in `/context` only. Missing or invalid denominators produce no displayed rate, and a response whose prompt was fully cached adds no prefill figure.

The bundle mounts the same read-only `session-stats` plugin as Web so those measurements can reach the control feed. The goal, plan and task indicators under the header and the job count read existing projections. A persisted but disarmed goal is shown as `paused · /goal resume`, not running. The interface never starts goal rounds to drive a badge.

### Without a terminal

Non-TTY mode remains line-oriented and plain-text. Each nonblank line submits one prompt or command, input is buffered before opening-prompt execution, and EOF saves sessions. Interactive approvals fail closed; questions can fall through to other composed answerers. Use explicit session and model IDs in scripts instead of pickers. Provider reasoning is included here and in exports too.

-----

<a id="build-and-test"></a>
## Build and test

Use the Node version and pinned pnpm declared by the root `package.json` (`engines.node` and `packageManager`). Do not accidentally run an older globally installed `dsh`.

```sh
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-tui-app run test:terminal
pnpm --filter @deepseek-ai/dsh-tui-app run test:ink
pnpm run build
pnpm --filter @deepseek-ai/dsh-tui-app run test:memory
pnpm run dsh --profile tui
pnpm run dsh --profile tui resume
```

The installed TUI bundles React, its reconciler and Ink in production mode, independently of the shell's `NODE_ENV`. This prevents React's development component timings from accumulating throughout a long conversation. Other plugins and subprocesses keep their environment unchanged. Direct source renderer tests can still use React's development diagnostics.

The pinned Ink patch adds an explicit, non-painting `invalidate()` operation for the resize owner and bounds both text measurement and wrapping caches to 4,096 entries each; evicted text is recomputed without changing the display. `test:memory` checks the installed bundle and streams 4,000 changing frames through a renderer built with the same configuration, checking retained heap and diagnostic entries after each 1,000 frames. It requires current build artifacts and does not contact a model.

To run the built CLI from another workspace:

```sh
cd /path/to/workspace
node /path/to/deepseek-harness/apps/cli/lib/bin.js --profile tui
```

`test:terminal` tests real pure renderers, editor, layout, diff and metrics code, service adapters and App input routing. App tests use **explicit test-only React/Ink orchestration doubles**: they verify generated rows and actions, not native React scheduling, Yoga layout or PTY behaviour. These doubles never enter the production bundle. `test:ink` separately imports **real React and Ink** and checks their painting of generated rows. Its xterm emulator covers rapid resize bursts, unchanged frames after a shrink/grow cycle, pending streaming writes and selection highlighting. It requires installed dependencies and does not replace a smoke test in the user's terminal emulator.

`preview:snapshots` exports deterministic fixture rows, not screenshots of a live provider. The TypeScript test loader also accepts `DSH_TEST_TYPESCRIPT` and `DSH_TEST_COMMANDER` paths for constrained environments; normal tests resolve the installed dependencies. Shared controller integration tests:

```sh
pnpm exec vitest run packages/api/session-controller/tests
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Shared services and admission

The [`cordis.patch.yml`](cordis.patch.yml) layer inserts the startup provider and runner, the carrier-neutral Web business services (session and job controllers, workspace, file and session references, `session-stats`), the preset registry with `standard` as its default, and the Smart approval row. It disables the globally mounted agent-plane rows (tools, skills, planning, compaction, subagents, workflow), because each Session's recorded preset selects them, exactly as on Web. No webserver, browser runtime or browser UI is mounted; calls are in-process, not an alternate LLM client.

`backend.ts` delegates prompt admission and create, resume, model, queue and fork operations to the shared controller. `index.ts` adapts existing command registries, projections and approval and question waterfalls. The pending queue is read from the shared `inbox` projection and background jobs from the Job Controller's `job.list` roster stream, the same sources the Web client uses. `queue.ts` chooses the shared `queue`/`steer` admission mode and, after an interrupt, re-delivers the last parked inbox message with a wake (the remove and re-delivery the controller's queue Steer performs) so the Agent starts the turn its kept input was waiting for; it never builds a message. The preset owns system prompts, tools, compaction, pruning, plan and goal. No model input is reconstructed from terminal-rendered text.

### Transcript rendering

`transcript.ts` reconciles streamed deltas and durable events without repeating compact or prune replacement copies. Tool events retain start, end and interruption status. `document.ts` caches item rows; `viewport.ts` anchors the scroll position to item IDs so streaming above the viewport does not pull the reader away. A growing message reuses the rows of the lines it has already finished, and streamed tokens repaint on a frame instead of once per token, so a long answer does not consume the time the terminal needs to read the keyboard. Tool folding, raw views, search and display clearing are local presentation state only. Control, escape and bidirectional characters are sanitized for display, not rewritten in the original submitted prompt.

### Source map

| Files | Responsibility |
| --- | --- |
| `backend.ts`, `index.ts`, `startup.ts` | Shared services, lifecycle, subscriptions, routing, answerers and command-line options |
| `app.tsx`, `components.tsx` | Focus and input orchestration and visible Ink rows |
| `screen.ts`, `animation.ts`, `metrics.ts`, `theme.ts` | Layout, the loader of the three pre-rendered braille animations, read-only indicators and semantic colours |
| `document.ts`, `markdown-layout.ts`, `syntax.ts`, `diff.ts`, `diff-layout.ts`, `tool-format.ts` | Transcript, Markdown, code, tool details and adaptive recorded changes |
| `actions.ts`, `code-blocks.ts`, `panes.ts`, `links.ts`, `selection.ts` | Semantic copy targets, exact fenced content, hit testing, safe hyperlinks and drag selection |
| `clipboard.ts`, `local-process.ts`, `external-editor.ts`, `terminal-signals.ts` | Explicit local OS adapters, bounded subprocesses, draft editing and attention signals |
| `terminal-guard.ts`, `terminal.ts` | Exclusive terminal ownership: diverts foreign stdout/stderr writes and delivers resizes to the App instead of Ink; display sanitizing |
| `session-browser.ts`, `browser-view.ts`, `sessions.ts` | Cold-safe shared search and inspection, cancellable preview UI and session candidates |
| `rich-text.ts`, `layout.ts`, `viewport.ts`, `mouse.ts` | Cell and grapheme sizing, wrapping, stable scroll anchors and mouse reports |
| `editor.ts`, `editor-history.ts`, `paste.ts`, `commands.ts` | Prompt editing, undo, paste placeholders and command discovery |
| `store.ts`, `transcript.ts`, `interaction.ts`, `plain.ts`, `queue.ts`, `job-observer.ts`, `permission-audit.ts` | Local UI state, event replay, pending UI, non-TTY mode, queue delivery, job output and approval records |

This package publishes no separate runtime invariant companion: durable session state belongs to the controller, terminal state only presents authoritative services, and the document cache is a disposable projection checked by layout and input tests. The design decision is recorded in [the terminal-native TUI Agent Note](../../../.agents/notes/implemented/feature/2026-09-18-terminal-native-tui.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the shared services behind the terminal and the decisions that shaped it.

- [dsh-web-app](../web-app/README.md) — the browser surface whose controller and presets the terminal shares.
- [dsh-api-session-controller](../../api/session-controller/README.md) — prompt admission, queue and session operations.
- [Smart approval](../../interaction/smart-approval/README.md) — the reviewer behind `/auto-approve smart`.
- [Terminal-native TUI Agent Note](../../../.agents/notes/implemented/feature/2026-09-18-terminal-native-tui.md) — the design decision for this package.

Terminal interaction references (not dependencies):

- Codex CLI: https://developers.openai.com/codex/cli/features
- Claude Code interactive mode: https://code.claude.com/docs/en/interactive-mode
- Gemini CLI keyboard shortcuts: https://geminicli.com/docs/reference/keyboard-shortcuts/
- Ink 7.1.1 API: https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md

-----

<a id="model-experience"></a>
## Model Experience

### Deployment persona fallback

#### What the model sees

The bundle sets the base `system-prompt` row's `personaPrefix` and `personaSuffix` to the two sections below, with `{{model}}` and `{{cwd}}` interpolated; every shipped preset (`standard`, `ptc`, `minimal`, `cordis`) mounts a `persona` row that shadows both sections for its sessions, so these sections reach the model only in a session whose preset composes no persona row.

##### Persona prefix

```markdown
You are a coding agent powered by the {{model}} model.
```

##### Persona suffix

```markdown
Your working directory is {{cwd}}.
```

#### Token effect

None for sessions on the shipped presets; otherwise one short sentence before and one after the first-party guidance in every request's system prompt.

#### KV Cache effect

The rendered sections are constant for a fixed model and working directory, so they stay inside the cached prefix; only a model or working-directory change re-renders them.

### Terminal prompts

#### What the model sees

The composer sends the draft through the shared SessionController with the `queue` or `steer` admission mode, so the model receives the same user message Web would send; collapsed paste placeholders such as `[Pasted text #1 +42 lines]` are expanded to the pasted text before submission and never reach the model, and terminal rendering, folding, themes, search and selection add nothing to the request.

#### Token effect

Equal to the submitted text and staged attachments; displaying provider reasoning requests no additional provider content and does not change the configured reasoning effort.

#### KV Cache effect

Admission appends user messages after the existing history and steering joins at the next step boundary, as on Web; the terminal never rewrites, reorders or reconstructs earlier messages.

### Smart approval row

#### What the model sees

The bundle mounts `smart-approval` with its default limits and `escalatingTools: [plugin_manager]`; when a session selects `/auto-approve smart`, the reviewer request it sends is documented in the [Smart approval README](../../interaction/smart-approval/README.md).

#### Token effect

None while a session stays manual; with Smart selected, one bounded reviewer request per eligible escalation.

#### KV Cache effect

The reviewer request is separate from the session's own requests and leaves the session's cached prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what the terminal does not provide and where its behaviour depends on the emulator or host. They are current package constraints, not a general CLI comparison or a task backlog.

- **No browser-only features** — plugin panels, inline image rendering, workspace trees and browser terminals are not reproduced; images appear as attachment labels.
- **No new editing or review layers** — the package implements no shell language, Git review service, permission policy, Vim mode or screen-reader mode.
- **Single-column layout only** — `DSH_TUI_LAYOUT=split` is accepted and recorded, but tool details, pickers and previews always open in-page.
- **Diff line numbers are relative to the shown change** — recorded changes store the old and new text, not file positions, so numbering starts at the first line of each shown change.
- **Session search does not report truncation** — content search keeps the controller's result limit, and the picker shows no notice when that limit is reached; narrow the query if an expected session is missing.
- **Process-local drafts and history** — sent sessions persist in the shared store; unsent drafts, the stash and prompt history (the last 100 submissions) are lost when the process exits.
- **Emulator-dependent signals** — OSC 8 links, OSC 52 clipboard writes, focus reports, desktop notifications and modified Enter keys depend on emulator settings; clipboard and image adapters require their OS helpers.
- **No native end-to-end validation** — Windows and macOS adapter argv and UI interactions are covered by isolated tests, not by end-to-end runs on those systems.
- **Outbound equality is not byte-tested** — equality of real outbound LLM traffic with Web must be checked against the same provider and session configuration; shared source alone is not a byte-for-byte end-to-end test.
- **Prefill speed is an estimate** — the core exposes no isolated prefill timer, so the time to the first token also counts request preparation, queueing, transport and any pruning before the request; the figure reads low after a Laya pass or a slow request start, and is closest to the server's own prefill rate on a local server.
- **Fixed animation sizes** — the four animations in `assets/anim/` are rendered outside this package at fixed sizes; the welcome whale needs 64 columns and 22 rows of conversation area and the Thinking scene a 26-row terminal, and neither is scaled for smaller terminals; new artwork or tones require new files.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
