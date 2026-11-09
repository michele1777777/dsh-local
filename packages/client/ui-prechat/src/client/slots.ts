/** Framework-derived props of the per-session import overlay. */
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Draft } from './dialog.ts'
import type {} from './locales.ts'
/** Draft observable and actions supplied by the owning session. */
export interface PrechatInjected {
  hooks: { draft: HostObservable<Draft> }
  edit(text: string): void
  close(): void
  preview(): void
  load(file: File): Promise<void>
  submit(): Promise<void>
}
/** Framework-derived editor actions, draft hook and localized copy. */
export type PrechatProps = InjectFace<PrechatInjected> & PropsLocale<'prechat'>
