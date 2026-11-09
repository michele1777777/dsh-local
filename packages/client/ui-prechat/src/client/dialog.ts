/** One per-session import draft; asynchronous file reads cannot replace a newer draft. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { parsePrechat, PRECHAT_MAX_BYTES, type PrechatMessage } from '@deepseek-ai/dsh-prechat/text'
/** Editable text and preview state of one import dialog. */
export interface Draft {
  readonly open: boolean
  readonly text: string
  readonly messages: readonly PrechatMessage[] | null
  readonly busy: boolean
  readonly error: string | null
}
const initial: Draft = { open: false, text: '', messages: null, busy: false, error: null }
/** Owns one session draft, validation and submission lifetime. */
export class PrechatDialog {
  /** Observable draft consumed by the renderer. */
  readonly state = createSnapshotStore<Draft>(initial)
  private generation = 0
  constructor(private readonly applyText: (text: string) => Promise<void>) {}
  /** Open an empty draft unless a submission is in flight. */
  open(): void { if (this.state.getSnapshot().busy) return; this.generation++; this.state.set({ ...initial, open: true }) }
  /** Discard the draft unless its apply is in flight. */
  close(): void { if (this.state.getSnapshot().busy) return; this.generation++; this.state.set(initial) }
  /** Replace the draft and discard its preview.
   * @param text - exact pasted or loaded text.
   */
  edit(text: string): void {
    if (this.state.getSnapshot().busy) return
    this.generation++
    this.state.set({ open: true, text, messages: null, busy: false, error: null })
  }
  /** Validate the current draft and publish ordered role messages or an actionable error. */
  preview(): void {
    const current = this.state.getSnapshot()
    if (current.busy) return
    try { this.state.set({ ...current, messages: parsePrechat(current.text), error: null }) }
    catch (error) { this.state.set({ ...current, error: error instanceof Error ? error.message : String(error) }) }
  }
  /** Read bounded UTF-8 input without overwriting newer edits.
   * @param file - one selected or dropped .txt file.
   * @returns after the read settles or its result is discarded.
   */
  async load(file: File): Promise<void> {
    if (this.state.getSnapshot().busy) return
    const generation = ++this.generation
    try {
      if (!file.name.toLowerCase().endsWith('.txt') || file.size > PRECHAT_MAX_BYTES) throw new Error('file')
      const bytes = await file.arrayBuffer()
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (this.generation === generation && this.state.getSnapshot().open) this.edit(text)
    } catch (_error) {
      // The local file error is shown without exposing browser-specific details.
      if (this.generation === generation) this.state.set({ ...this.state.getSnapshot(), error: 'file' })
    }
  }
  /** Apply a validated preview once; errors preserve it for correction.
   * @returns after submission settles.
   */
  async submit(): Promise<void> {
    const current = this.state.getSnapshot()
    if (current.busy || current.messages === null) return
    const generation = ++this.generation
    this.state.set({ ...current, busy: true, error: null })
    try {
      await this.applyText(current.text)
      if (this.generation === generation) { this.generation++; this.state.set(initial) }
    } catch (error) {
      if (this.generation === generation) {
        this.state.set({ ...current, busy: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  /** Invalidate pending completions and release the retained draft. */
  dispose(): void { this.generation++; this.state.set(initial) }
}
