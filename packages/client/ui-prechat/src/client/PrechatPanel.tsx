/** Paste/file input and role-separated preview in the existing Modal shell. */
import { useRef } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PrechatProps } from './slots.ts'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-prechat/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './PrechatPanel.module.css'
/** Edit text or inspect its role-separated preview.
 * @param props - framework draft hook, actions and labels.
 * @returns the import modal.
 */
export function PrechatPanel({ useDraft, edit, close, preview, load, submit, t }: PrechatProps) {
  const draft = useDraft(value => value)
  const fileInput = useRef<HTMLInputElement>(null)
  return <Modal open={draft.open} title={t('title')} closeLabel={t('cancel')} onClose={close} className={css.panel as string}
    footer={<div className={css.actions}>
      <Button disabled={draft.busy} onClick={close}>{t('cancel')}</Button>
      {draft.messages !== null && <Button disabled={draft.busy} onClick={() =>{  edit(draft.text) }}>{t('edit')}</Button>}
      <Button variant="primary" disabled={draft.busy || draft.text.trim() === ''}
        onClick={() => { if (draft.messages === null) preview(); else void submit() }}>
        {t(draft.busy ? 'working' : draft.messages === null ? 'preview' : 'apply')}
      </Button>
    </div>}>
    <div className={css.body} onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
      onDrop={(event) => {
        event.preventDefault(); event.stopPropagation()
        const file = event.dataTransfer.files[0]
        if (file !== undefined && event.dataTransfer.files.length === 1) void load(file)
      }}>
      <p>{t('hint')}</p>
      {draft.error !== null && <p role="alert" className={css.error}>{draft.error === 'file' ? t('fileError') : t('error', { detail: draft.error })}</p>}
      {draft.messages === null ? <>
        <Button disabled={draft.busy} onClick={() => fileInput.current?.click()}>{t('load')}</Button>
        <input ref={fileInput} type="file" accept=".txt,text/plain" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file !== undefined) void load(file) }} />
        <textarea aria-label={t('title')} className={css.editor} value={draft.text} placeholder={t('placeholder')}
          disabled={draft.busy} onChange={(event) =>{  edit(event.target.value) }} />
      </> : <div className={css.preview}>
        <p>{t('imported', { count: String(draft.messages.length) })}</p>
        {draft.messages.map((message, index) => <section key={index}>
          <strong>{t(message.role)}</strong><pre>{message.text}</pre>
        </section>)}
      </div>}
    </div>
  </Modal>
}

/** The imported prefix stays visible when a saved Session is reopened.
 * @param props - projection reader and labels.
 * @returns the imported-message notice, or nothing for ordinary sessions.
 */
export function PrechatNotice({ useProjection, t }: PropsRuntime<'conversation.input.dock'> & PropsLocale<'prechat'>) {
  const count = useProjection('prechat') ?? 0
  return count === 0 ? null : <details><summary>{t('imported', { count: String(count) })}</summary><p>{t('saved')}</p></details>
}
