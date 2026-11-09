import { useState } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LayaPrunerItem } from '@deepseek-ai/dsh-compaction-laya-pruner'
import clsx from 'clsx'
import css from './LayaPrunerPanel.module.css'

/** Complete keyed Chat renderer props. */
export type LayaPrunerPanelProps = PropsRuntime<'conversation.chat.node', 'laya-pruner'> & PropsLocale<'layaPruner'>

const ACTIONS = ['KEEP', 'TRUNCATE', 'DROP'] as const

function kTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 4×4 pixel-art mark; cells light up in a travelling wave while the pass runs. */
function PixelMark({ running }: { running: boolean }) {
  return (
    <span className={clsx(css.pixels, running && css.pixelsRunning)} aria-hidden="true">
      {Array.from({ length: 16 }, (_, i) => (
        <span key={i} className={css.pixel} style={{ animationDelay: `${((i % 4) + Math.floor(i / 4)) * 90}ms` }} />
      ))}
    </span>
  )
}

function Entry({ item, t }: { item: LayaPrunerItem; t: LayaPrunerPanelProps['t'] }) {
  const ranges = item.keepLines.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ')
  return (
    <li className={css.entry}>
      <span className={clsx(css.badge, css[`badge${item.action}`])} />
      <span className={css.entryLabel}>{item.label}</span>
      <span className={css.entryMeta}>
        {t('item.tokens', { before: kTokens(item.tokensBefore), after: kTokens(item.tokensAfter) })}
        {' · '}
        {item.action === 'TRUNCATE' ? t('item.keptLines', { ranges }) : t('item.lines', { lines: String(item.lines) })}
      </span>
    </li>
  )
}

/** laya_context_pruner node: running indicator, totals, and every judged output on expand. */
export function LayaPrunerPanel({ node, t }: LayaPrunerPanelProps) {
  const data = node.data
  const [open, setOpen] = useState(false)
  const running = data.status === 'running'
  const done = data.status === 'pruned'
  const pct = done && data.tokensAfter !== undefined && data.tokensBefore > 0
    ? Math.round(100 * (1 - data.tokensAfter / data.tokensBefore)) : 0
  return (
    <div className={clsx(css.root, running && css.rootRunning)}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={t('toggle')}
        disabled={running}
        onClick={() => { setOpen(v => !v) }}
      >
        <PixelMark running={running} />
        <span className={css.title}>{t('title')}</span>
        {running && <span className={clsx(css.detail, css.phase)} role="status" aria-live="polite" aria-atomic="true">
          {data.phase === undefined || data.phase === 'prune'
            ? t('running', { tokens: kTokens(data.tokensBefore) }) : t(`phase.${data.phase}`)}
        </span>}
        {done && data.tokensAfter !== undefined && (
          <>
            <span className={css.summary}>{t('summary', { before: kTokens(data.tokensBefore), after: kTokens(data.tokensAfter), pct: String(pct) })}</span>
            <span className={css.detail}>{t('counts', {
              kept: String(data.kept ?? 0), truncated: String(data.truncated ?? 0), dropped: String(data.dropped ?? 0),
              time: seconds(data.ms ?? 0),
            })}</span>
          </>
        )}
        {data.status === 'fallback' && (
          <span className={css.fallback}>{data.error === undefined ? t('fallback') : t('fallbackReason', { reason: data.error })}</span>
        )}
        {!running && <IconChevronRightOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>
      {open && !running && (
        <div className={css.body}>
          {ACTIONS.map((action) => {
            const items = data.items.filter(i => i.action === action)
              .sort((a, b) => (b.tokensBefore - b.tokensAfter) - (a.tokensBefore - a.tokensAfter))
            if (items.length === 0) return null
            return (
              <section key={action} className={css.group}>
                <h4 className={css.groupTitle}>{t(`group.${action}`, { count: String(items.length) })}</h4>
                <ul className={css.list}>{items.map(item => <Entry key={item.seq} item={item} t={t} />)}</ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
