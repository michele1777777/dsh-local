# Agent Note: The TUI reads the wheel and keeps the keyboard during a turn

Status: implemented

English | [中文](2026-09-18-tui-wheel-scrolling-and-streaming-input.zh.md)

## Problem

In the alternate screen with no mouse reporting, terminals answer the wheel with cursor keys. The composer reads those as prompt history, so scrolling replaced the draft with earlier prompts instead of moving the conversation, and the reader could not follow a running turn by wheel at all. Separately, every streamed token announced a store change and relaid out the whole growing message, which on a long transcript consumed more time than the interval between tokens and left the composer unable to accept keystrokes while an answer was being produced. An in-flight submission also swallowed every key until admission settled.

## Decision

The application enables button-event reporting with SGR coordinates (`1002`/`1006`) once Ink owns the alternate screen and hands mouse handling back when the component unmounts, which covers every exit path the runner already drives through `ink.unmount()`. `mouse.ts` classifies one input event as a wheel notch, a button or drag report, or a legacy X10 prefix; the key handler scrolls three rows a notch and a page with Ctrl held, routes unmodified primary-button presses and drags to in-application actions and text selection, and drops every other report so no coordinate byte reaches the prompt. Wheel scrolling uses the existing item-relative anchors, so it works while the model is writing and rejoins the live tail at the last row. Because reporting takes click and drag away from the terminal's own selection, `/mouse off` and `DSH_TUI_MOUSE=off` return them for the session.

Streamed tokens fold into the transcript immediately but announce one repaint per frame, and the document reuses the rows of the lines a message has already finished: Markdown at a blank line outside a fence, reasoning at any newline, both falling back to a complete layout for any other item, width or rewrite. Rows that a wrapping pass already fitted are not escaped and segmented again. On a 240-item transcript with a message growing past 16,000 characters, one repaint fell from a mean of 544 ms to 3 ms, and the rows are asserted identical to a full layout at every prefix. Typing stays enabled while a prompt is in admission; the send lock alone prevents a second submission, and a draft composed during admission is kept.

## Alternatives considered

Detecting wheel-shaped cursor-key bursts by timing was rejected: it cannot be distinguished from a held arrow key, and it would still leave the composer's history recall as the terminal's only wheel behaviour. Leaving reporting permanently on with no escape hatch was rejected because copying text out of the conversation matters more to some users than the wheel. Throttling repaints alone was not enough: the layout cost grows with message length, so a long answer would still saturate the frame. Making the wrapper incremental inside `wrapProse` and `markdownRows` would reach a finer boundary than a line, but those are the same functions replay and resize use, and reusing whole finished lines keeps one layout for streamed and replayed text.

## Consequences

While wheel reporting is on, a click or drag is consumed by the application; most terminals still select with Shift held, and the help panel and README say so. Terminals that ignore `1006` report in X10 encoding, whose coordinate bytes are dropped rather than typed, but they do not scroll. A coalesced change is visible to `getState` at once and to the screen within a frame, so a repaint can lag a token by that much; any immediate change announces the coalesced ones with it. The streamed layout keeps rows for one item at a time, so two messages growing at once alternate between reuse and a complete layout. The terminal-native presentation decisions this builds on stay in [the TUI Agent Note](../feature/2026-09-18-terminal-native-tui.md).
