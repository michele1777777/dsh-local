/**
 * The chat transcript model and the folds that build it.
 *
 * One transcript is an ordered list of items — human messages, assistant
 * text with its reasoning, tool calls with their presented views, slash
 * commands with their outcomes, and notices. Two sources feed it: the live
 * `agent/assistant-stream` frames, which grow the current assistant item as
 * text arrives, and durable session events, which own every settlement (tool
 * calls and results, command lifecycle, turn outcomes). Replaying a resumed
 * log runs the same event fold, so a resumed chat and a live one render
 * identically.
 * @module @deepseek-ai/dsh-tui-app/transcript
 */

import type { AssistantStreamRecord, ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import type { LayaPhase } from '@deepseek-ai/dsh-compaction-laya-pruner'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** A human message, shown as soon as it is submitted. */
export interface UserItem {
  kind: 'user'
  id: string
  text: string
  /** Submitted while a turn was running: delivered at the next turn boundary. */
  queued: boolean
  settled: boolean
}

/** One assistant response segment: text plus the reasoning that preceded it. */
export interface AssistantItem {
  kind: 'assistant'
  id: string
  text: string
  reasoning: string
  /** Original stream timestamps, reconstructed from packed records on resume. */
  reasoningStartedAt?: number
  reasoningEndedAt?: number
  settled: boolean
}

/** One tool call and, once it completes, its presented result. */
export interface ToolItem {
  kind: 'tool'
  id: string
  name: string
  startedAt?: number
  completedAt?: number
  /** A turn ended without a matching tool result; not a successful execution. */
  cancelled?: boolean
  /** Parsed call arguments, kept for the result presenter. */
  args: unknown
  call: ToolCallView
  result?: ToolResultView
  /** The model-facing result text, used when the tool presents no view. */
  resultText?: string
  isError: boolean
  settled: boolean
}

/** One slash command dispatched to the registry and its outcome. */
export interface CommandItem {
  kind: 'command'
  id: string
  name: string
  args: string
  result?: { kind: 'success' | 'error'; text?: string }
  settled: boolean
}

/** A chat-owned line: a local command's output, an interruption, a turn error. */
export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
  level: 'info' | 'error' | 'success'
  settled: true
}

/** One judged tool output of a Laya pruning pass. */
export interface LayaEntry {
  label: string
  action: 'KEEP' | 'TRUNCATE' | 'DROP'
  lines: number
  tokensBefore: number
  tokensAfter: number
}

/** Result of a `laya_context_pruner` pass (laya-pruner/end). */
export interface LayaItem {
  kind: 'laya'
  id: string
  outcome: 'pruned' | 'fallback'
  tokensBefore: number
  tokensAfter: number
  ms: number
  kept: number
  truncated: number
  dropped: number
  entries: LayaEntry[]
  error?: string | undefined
  settled: true
}

/** One transcript entry; `settled` items never change again. */
export type Item = UserItem | AssistantItem | ToolItem | CommandItem | NoticeItem | LayaItem

/** Token usage reported by the most recent model request. */
export interface Usage {
  input: number
  output: number
}

/** The whole transcript state. */
export interface Transcript {
  items: Item[]
  /** Id of the assistant item the live stream is currently growing, if any. */
  liveAssistant: string | undefined
  usage: Usage | undefined
  /** Monotonic id source for chat-minted items. */
  nextId: number
  compacting: boolean
  /** A laya_context_pruner pass is running (laya-pruner/start without its end). */
  layaPruning?: boolean
  layaPhase?: LayaPhase | undefined
  layaPruneId?: string | undefined
  turnStartedAt?: number | undefined
  /** Wall time since the latest admitted human message, including tools and compaction. */
  workStartedAt?: number
  workCompletedAt?: number | undefined
}

/** Presents tool calls and results through the composed tool registry. */
export interface Presenters {
  call(name: string, args: unknown): ToolCallView
  result(name: string, args: unknown, result: { content: ContentBlock[]; isError: boolean; meta?: JsonValue }): ToolResultView | undefined
}

/**
 * A transcript with no items, ids starting at 1.
 * @returns the new transcript.
 */
export function emptyTranscript(): Transcript {
  return { items: [], liveAssistant: undefined, usage: undefined, nextId: 1, compacting: false }
}

function mint(t: Transcript, prefix: string): string {
  const id = `${prefix}-${String(t.nextId)}`
  t.nextId += 1
  return id
}

/**
 * Join the text blocks of a content list.
 * @param content - the content blocks.
 * @returns the concatenated text; non-text blocks are skipped.
 */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Join the reasoning blocks of a content list, read structurally. */
function reasoningOf(content: readonly ContentBlock[]): string {
  return content
    .filter(block => block.type === 'reasoning')
    .map(block => (block as { text?: string }).text ?? '')
    .join('')
}

/**
 * Whether a `user/message` is something a person typed, not injected context.
 * @param source - the message source.
 * @returns true for `user` and `prechat` sources.
 */
export function fromPerson(source: { kind: string }): boolean {
  return source.kind === 'user' || source.kind === 'prechat'
}

/** Parse tool-call arguments, keeping the raw string when they are not JSON. */
function parseArgs(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw)
    return value
  } catch {
    return raw
  }
}

/**
 * Append a human message.
 * @param t - the transcript, mutated.
 * @param text - the message text.
 * @param queued - whether the message waits behind a running turn; a queued item stays unsettled.
 * @returns the appended item.
 */
export function addUser(t: Transcript, text: string, queued: boolean): UserItem {
  const item: UserItem = { kind: 'user', id: mint(t, 'user'), text, queued, settled: !queued }
  t.items.push(item)
  return item
}

/**
 * Append a chat-owned notice.
 * @param t - the transcript, mutated.
 * @param text - the notice text.
 * @param level - the notice severity.
 */
export function addNotice(t: Transcript, text: string, level: NoticeItem['level'] = 'info'): void {
  t.items.push({ kind: 'notice', id: mint(t, 'notice'), text, level, settled: true })
}

/** The assistant item the live stream grows, created on the first delta. */
function liveAssistant(t: Transcript): AssistantItem {
  const existing = t.items.find((item): item is AssistantItem => item.kind === 'assistant' && item.id === t.liveAssistant)
  if (existing !== undefined) return existing
  const item: AssistantItem = { kind: 'assistant', id: mint(t, 'assistant'), text: '', reasoning: '', settled: false }
  t.items.push(item)
  t.liveAssistant = item.id
  return item
}

function reasoningTime(item: AssistantItem, chunk: StreamChunk, time: number): void {
  if (chunk.type === 'reasoning-delta' && chunk.text !== '') {
    item.reasoningStartedAt ??= time
    delete item.reasoningEndedAt
  } else if (item.reasoningStartedAt !== undefined && (
    (chunk.type === 'block-end' && chunk.block.type === 'reasoning') ||
    (chunk.type === 'text-delta' && chunk.text !== '') || chunk.type === 'tool-call-delta' || chunk.type === 'finish'
  )) item.reasoningEndedAt ??= time
}

/** Read timing directly from compact records without expanding the stored stream. */
function restoreReasoningTime(item: AssistantItem, stream: readonly AssistantStreamRecord[], end: number): void {
  for (const record of stream) {
    if (record.type === 'chunk') reasoningTime(item, record.chunk, record.time)
    else if (record.type === 'tool-call-chunks') {
      if (item.reasoningStartedAt !== undefined) item.reasoningEndedAt ??= record.time0
    } else {
      let time = record.time0
      for (const [index, text] of record.texts.entries()) {
        if (index > 0) time += record.dt[index - 1] as number
        reasoningTime(item, { type: record.type === 'reasoning-chunks' ? 'reasoning-delta' : 'text-delta', index: record.index, text }, time)
      }
    }
  }
  if (item.reasoningStartedAt !== undefined) item.reasoningEndedAt ??= end
}

/**
 * Fold one live chunk at its original stream timestamp (local time for untimed callers).
 * @param t - the transcript, mutated.
 * @param chunk - the stream chunk; text and reasoning deltas grow the live assistant item.
 * @param time - the chunk's timestamp in epoch milliseconds.
 */
export function applyChunk(t: Transcript, chunk: StreamChunk, time = Date.now()): void {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta': {
      if (chunk.text === '') return
      const item = liveAssistant(t)
      reasoningTime(item, chunk, time)
      if (chunk.type === 'text-delta') item.text += chunk.text
      else item.reasoning += chunk.text
      return
    }
    case 'usage':
      t.usage = { input: chunk.usage.inputTokens, output: chunk.usage.outputTokens }
      return
    default: {
      const item = t.items.find((entry): entry is AssistantItem => entry.kind === 'assistant' && entry.id === t.liveAssistant)
      if (item !== undefined) reasoningTime(item, chunk, time)
      return
    }
  }
}

/**
 * Settle the current assistant segment, freezing its reasoning timer.
 * @param t - the transcript, mutated.
 * @param time - the end timestamp in epoch milliseconds.
 */
export function endStream(t: Transcript, time = Date.now()): void {
  const item = t.items.find((entry): entry is AssistantItem => entry.kind === 'assistant' && entry.id === t.liveAssistant)
  if (item !== undefined) {
    item.settled = true
    if (item.reasoningStartedAt !== undefined) item.reasoningEndedAt ??= time
  }
  t.liveAssistant = undefined
}

/**
 * Fold one durable session event.
 * @param t - the transcript.
 * @param event - the event, in log order.
 * @param present - the tool presenters.
 * @param replay - historical replay has no transient stream to reconcile.
 */
export function applyEvent(t: Transcript, event: SessionEvent, present: Presenters, replay: boolean): void {
  switch (event.type) {
    case 'turn/start':
      t.turnStartedAt = event.time
      t.workStartedAt ??= event.time
      t.workCompletedAt = undefined
      return
    case 'user/message': {
      // Replacement copies produced by compact/prune are model-only, not new
      // conversation. This is also how Web chooses its human transcript.
      if (event.surfaceOp !== 'append' || !fromPerson(event.data.source)) return
      const id = String(event.data.id)
      if (t.items.some(item => item.kind === 'user' && item.id === id)) return
      t.workStartedAt = event.time
      t.workCompletedAt = undefined
      const attachments = event.data.content.filter(block => block.type !== 'text').map((block) => {
        const value = block as { type: string; name?: string }
        return `[${value.type}${value.name === undefined ? '' : `: ${value.name}`}]`
      })
      const text = [textOf(event.data.content), ...attachments].filter(Boolean).join('\n')
      if (text !== '') t.items.push({ kind: 'user', id, text, queued: false, settled: true })
      return
    }
    case 'assistant/message': {
      if (event.surfaceOp !== 'append') return
      const content = event.data.message.content
      const text = textOf(content)
      const reasoning = reasoningOf(content)
      const existing = replay ? undefined : t.items.find((item): item is AssistantItem => item.kind === 'assistant' && item.id === t.liveAssistant)
      // Durable commit precedes stream/end. Replace deltas with the canonical
      // assembled message, including providers that did not publish text deltas.
      if (existing !== undefined) {
        existing.text = text; existing.reasoning = reasoning; existing.settled = true
        restoreReasoningTime(existing, event.data.stream, event.time)
      } else if (text !== '' || reasoning !== '') {
        const item: AssistantItem = { kind: 'assistant', id: mint(t, 'assistant'), text, reasoning, settled: true }
        restoreReasoningTime(item, event.data.stream, event.time)
        t.items.push(item)
      }
      if (event.data.usage !== undefined) t.usage = { input: event.data.usage.inputTokens, output: event.data.usage.outputTokens }
      t.liveAssistant = undefined
      return
    }
    case 'assistant/attempt': {
      // A failed attempt is visible, but never represented as successful model
      // history. Replay packed records only for display, using the same fold.
      if (replay) {
        for (const record of event.data.stream) {
          if (record.type === 'text-chunks') applyChunk(t, { type: 'text-delta', index: record.index, text: record.texts.join('') }, record.time0)
          else if (record.type === 'reasoning-chunks') applyChunk(t, { type: 'reasoning-delta', index: record.index, text: record.texts.join('') }, record.time0)
          else if (record.type === 'chunk') applyChunk(t, record.chunk, record.time)
        }
      }
      const item = t.items.find((entry): entry is AssistantItem => entry.kind === 'assistant' && entry.id === t.liveAssistant)
      if (item !== undefined) restoreReasoningTime(item, event.data.stream, event.time)
      endStream(t, event.time)
      addNotice(t, 'Attempt ended without a committed assistant message.', 'info')
      return
    }
    case 'compaction/start':
      t.compacting = true
      return
    case 'laya-pruner/start':
      t.layaPruning = true
      t.layaPruneId = event.data.pruneId
      t.layaPhase = undefined
      return
    case 'laya-pruner/progress':
      if (t.layaPruning && t.layaPruneId === event.data.pruneId) t.layaPhase = event.data.phase
      return
    case 'laya-pruner/end':
      t.layaPruning = false
      t.layaPhase = undefined
      t.layaPruneId = undefined
      t.items.push({
        kind: 'laya', id: mint(t, 'laya'), outcome: event.data.outcome, tokensBefore: event.data.tokensBefore,
        tokensAfter: event.data.tokensAfter, ms: event.data.ms, kept: event.data.kept, truncated: event.data.truncated,
        dropped: event.data.dropped, error: event.data.error, settled: true,
        entries: event.data.items.map(i => ({
          label: i.label, action: i.action, lines: i.lines, tokensBefore: i.tokensBefore, tokensAfter: i.tokensAfter,
        })),
      })
      return
    case 'compaction/end':
      t.compacting = false
      addNotice(t, event.data.error === undefined ? 'Context compacted · previous conversation remains in the transcript.' : `Compaction failed: ${event.data.error}`, event.data.error === undefined ? 'success' : 'error')
      return
    case 'session/end-seed':
      t.compacting = false
      t.layaPruning = false
      t.layaPhase = undefined
      t.layaPruneId = undefined
      endStream(t, event.time)
      for (const item of t.items) {
        if (item.kind === 'tool' && !item.settled) { item.cancelled = true; item.settled = true }
        else if (item.kind === 'command') item.settled = true
      }
      t.turnStartedAt = undefined
      if (t.workStartedAt !== undefined) t.workCompletedAt ??= event.time
      return
    case 'tool/call': {
      // tool/call is a log-only event: unlike tool/result it has no surfaceOp.
      if (t.items.some(item => item.kind === 'tool' && item.id === String(event.data.callId))) return
      const args = parseArgs(event.data.arguments)
      t.items.push({
        kind: 'tool',
        id: String(event.data.callId),
        name: event.data.name,
        startedAt: event.time,
        args,
        call: present.call(event.data.name, args),
        isError: false,
        settled: false,
      })
      return
    }
    case 'tool/result': {
      if (event.surfaceOp !== 'append') return
      // Session V4: the tool message itself carries the call id, error flag and content.
      const message = event.data.message
      const item = t.items.find((entry): entry is ToolItem => entry.kind === 'tool' && entry.id === String(message.toolCallId))
      if (item === undefined) return
      const isError = message.isError === true
      const meta = event.data.meta
      const view = present.result(item.name, item.args, { content: [...message.content], isError, ...meta === undefined ? {} : { meta } })
      if (view !== undefined) item.result = view
      item.resultText = textOf(message.content)
      item.isError = isError
      item.completedAt = event.time
      item.cancelled = false
      if (isError && event.data.error?.reason !== undefined) item.resultText = event.data.error.reason
      item.settled = true
      return
    }
    case 'command/run':
      t.items.push({
        kind: 'command',
        id: String(event.data.commandId),
        name: event.data.name,
        args: event.data.args ?? '',
        settled: false,
      })
      return
    case 'command/done': {
      const item = t.items.find((entry): entry is CommandItem => entry.kind === 'command' && entry.id === String(event.data.commandId))
      if (item === undefined) return
      item.result = { kind: event.data.kind, ...event.data.text === undefined ? {} : { text: event.data.text } }
      item.settled = true
      return
    }
    case 'turn/end': {
      const reason = event.data.reason
      if (reason.kind === 'error') addNotice(t, `${reason.error.code}: ${reason.error.message}`, 'error')
      else if (reason.kind === 'aborted') addNotice(t, 'interrupted', 'info')
      // A turn that ends leaves nothing streaming, whatever the stream said.
      if (t.liveAssistant !== undefined) endStream(t, event.time)
      for (const item of t.items) if (item.kind === 'tool' && !item.settled) { item.settled = true; item.cancelled = true }
      t.turnStartedAt = undefined
      if (t.workStartedAt !== undefined) t.workCompletedAt ??= event.time
      return
    }
    default:
      return
  }
}

/**
 * Split the transcript into the settled prefix, which never changes again and
 * may be committed to the terminal's own scrollback, and the live tail.
 * @param items - the transcript items.
 * @returns the leading run of settled items and every item after it.
 */
export function splitSettled(items: readonly Item[]): { settled: Item[]; live: Item[] } {
  let boundary = 0
  while (boundary < items.length && items[boundary]?.settled === true) boundary += 1
  return { settled: items.slice(0, boundary), live: items.slice(boundary) }
}
