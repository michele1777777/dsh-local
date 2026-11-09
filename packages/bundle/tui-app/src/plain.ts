/** Line-oriented fallback, with the same admission path and fail-closed approvals. */
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type { Controller } from './app.tsx'
import type { Store } from './store.ts'
import { formatTool } from './tool-format.ts'
import { safeText } from './terminal.ts'
import { splitSettled, type Item } from './transcript.ts'
/**
 * Render one transcript item as plain text for the line-oriented mode.
 * @param item - the item.
 * @param _showReasoning - unused; reasoning is always printed.
 * @param full - print tool output without truncation.
 * @returns the text, possibly multi-line and with a leading newline.
 */
export function formatItem(item: Item, _showReasoning: boolean, full = false): string {
  switch (item.kind) {
    case 'user': return `\n❯ ${item.text}`
    case 'assistant': return `\n${item.reasoning.trim() !== '' ? `  · ${item.reasoning}\n` : ''}${item.text}`
    case 'tool': return formatTool(item, full)
    case 'command': return `\n/${item.name}${item.args ? ` ${item.args.trimStart()}` : ''}${item.result?.text === undefined ? '' : `\n  ${item.result.text}`}`
    case 'notice': return `  ${item.text}`
    case 'laya': return item.outcome === 'pruned'
      ? `  ▞▚ laya_context_pruner · ${item.tokensBefore} → ${item.tokensAfter} tokens · ${item.kept} kept · ${item.truncated} truncated · ${item.dropped} dropped`
      : `  ▞▚ laya_context_pruner · skipped · regular compaction decides${item.error === undefined ? '' : ` · ${item.error}`}`
  }
}
/**
 * Line-oriented chat loop. Subscribes before the opening prompt so fast replies cannot disappear; prints each settled item once per
 * session.
 * @param store - chat state.
 * @param controller - submits prompts and commands; `exit` runs when the loop ends, with code 1 on failure.
 * @param write - output sink.
 * @param opening - optional first prompt.
 * @param input - line source; lines starting with `/` run as commands.
 */
export async function runPlain(store: Store, controller: Controller, write: (text: string) => void,
  opening?: string, input: Readable = process.stdin): Promise<void> {
  let printed = 0
  let session = store.getState().sessionId
  const flush = (): void => {
    const state = store.getState()
    if (session !== state.sessionId) { session = state.sessionId; printed = 0 }
    const { settled } = splitSettled(state.transcript.items)
    while (printed < settled.length) {
      const item = settled[printed++]
      if (item !== undefined) write(`${safeText(formatItem(item, true, state.expandedTools))}\n`)
    }
  }
  const unsubscribe = store.subscribe(flush)
  const rl = createInterface({ input, crlfDelay: Infinity })
  // Begin buffering input BEFORE an opening prompt's network work.
  const iterator = rl[Symbol.asyncIterator]()
  let next = iterator.next()
  try {
    flush()
    if (opening !== undefined) await controller.submit(opening)
    while (!store.getState().exiting) {
      const line = await next
      if (line.done === true) break
      next = iterator.next()
      const raw = line.value
      if (raw.trim() === '') continue
      if (raw.startsWith('/')) await controller.runCommand(raw)
      else await controller.submit(raw)
    }
  } catch (error) {
    controller.exit(1)
    throw error
  } finally {
    rl.close(); unsubscribe(); controller.exit()
  }
}
