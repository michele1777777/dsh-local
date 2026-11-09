/**
 * Collapsed pastes in the composer.
 *
 * A large paste would bury the draft and the conversation under content the
 * writer already knows, so the composer keeps a one-line placeholder and this
 * module keeps the text behind it. The prompt that reaches the model is the
 * expanded text, always: the placeholder is display and editing state, never
 * the message. One key removes a whole placeholder, because half of one means
 * nothing, and pasting the same content again expands it in place for a reader
 * who wants to edit it.
 * @module @deepseek-ai/dsh-tui-app/paste
 */

/** Pasted text kept out of the composer, addressed by the placeholder's number. */
export interface PastedBlock { id: number; text: string }

/** Lines above which a paste is collapsed rather than shown. */
export const COLLAPSE_LINES = 4
/** Characters above which a paste is collapsed rather than shown. */
export const COLLAPSE_CHARS = 512
/** Blocks retained for expansion; older pastes drop out of reach of history. */
export const MAX_BLOCKS = 20

const PLACEHOLDER = /\[Pasted text #(\d+) \+\d+ lines?\]/gu

/**
 * Lines a paste occupies, counted the way the placeholder reports them.
 * @param text - newline-normalized text.
 * @returns the number of newline-separated lines; at least 1.
 */
export const lineCount = (text: string): number => text.split('\n').length

/**
 * Whether a paste is large enough to collapse.
 * @param text - the pasted text, newline-normalized.
 * @returns true when it exceeds the line or character bound.
 */
export function shouldCollapse(text: string): boolean {
  return lineCount(text) > COLLAPSE_LINES || text.length > COLLAPSE_CHARS
}

/**
 * The one-line token the composer shows in place of a block.
 * @param block - the collapsed paste.
 * @returns `[Pasted text #<id> +<n> line(s)]`.
 */
export function placeholder(block: PastedBlock): string {
  const lines = lineCount(block.text)
  return `[Pasted text #${block.id} +${lines} line${lines === 1 ? '' : 's'}]`
}

/**
 * Record one paste, dropping the oldest once the retention bound is reached.
 * @param blocks - blocks already retained, oldest first.
 * @param text - the pasted text.
 * @param id - the number this paste is shown under; it never repeats in one
 *   session, so a placeholder a writer has already seen keeps its meaning.
 * @returns the new block and the retained list containing it.
 */
export function addBlock(blocks: readonly PastedBlock[], text: string, id: number): { block: PastedBlock; blocks: PastedBlock[] } {
  const block = { id, text }
  return { block, blocks: [...blocks, block].slice(-MAX_BLOCKS) }
}

/**
 * The block whose text matches this paste, for a second paste of the same content.
 * @param blocks - retained blocks.
 * @param text - the new paste.
 * @returns the first block with identical text, or undefined.
 */
export function blockWithText(blocks: readonly PastedBlock[], text: string): PastedBlock | undefined {
  return blocks.find(entry => entry.text === text)
}

/**
 * The placeholder a cursor sits in or against.
 * @param text - the composer draft.
 * @param cursor - the cursor offset.
 * @param side - `before` for a backspace, `after` for a forward delete.
 * @returns the placeholder's range and block id, or undefined.
 */
export function placeholderAt(text: string, cursor: number, side: 'before' | 'after'): { start: number; end: number; id: number } | undefined {
  for (const match of text.matchAll(PLACEHOLDER)) {
    const start = match.index, end = start + match[0].length
    const touches = side === 'before' ? cursor > start && cursor <= end : cursor >= start && cursor < end
    if (touches) return { start, end, id: Number(match[1]) }
  }
  return undefined
}

/**
 * Restore every placeholder to the text it stands for.
 * @param text - the composer draft, as the writer sees it.
 * @param blocks - retained blocks.
 * @returns the prompt to submit; an unknown placeholder is left untouched.
 */
export function expandPastes(text: string, blocks: readonly PastedBlock[]): string {
  return text.replace(PLACEHOLDER, (token, id: string) => {
    const block = blocks.find(entry => entry.id === Number(id))
    return block === undefined ? token : block.text
  })
}

/**
 * Blocks a draft still refers to, so the rest can be released.
 * @param text - the composer draft.
 * @param blocks - retained blocks.
 * @returns the blocks whose placeholder appears in the draft, in retention order.
 */
export function referenced(text: string, blocks: readonly PastedBlock[]): PastedBlock[] {
  const ids = new Set([...text.matchAll(PLACEHOLDER)].map(match => Number(match[1])))
  return blocks.filter(block => ids.has(block.id))
}
