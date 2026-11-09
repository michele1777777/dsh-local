/** `layaPruner` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'layaPruner'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': 'laya_context_pruner',
  'running': '正在裁剪上下文 · {tokens} tokens',
  'phase.release': 'DS4 · 正在释放缓存内存',
  'phase.start': '正在启动 Laya',
  'phase.stop': '正在关闭 Laya',
  'phase.restore': 'DS4 · 正在恢复缓存容量',
  'summary': '{before} → {after} tokens (−{pct}%)',
  'counts': '保留 {kept} · 截断 {truncated} · 移除 {dropped} · {time}',
  'fallback': '已跳过 · 由常规压缩决定',
  'fallbackReason': '已跳过 · 由常规压缩决定 · {reason}',
  'group.KEEP': '完整保留 ({count})',
  'group.TRUNCATE': '截断为保留行 ({count})',
  'group.DROP': '已移除 ({count})',
  'item.tokens': '{before} → {after}',
  'item.lines': '{lines} 行',
  'item.keptLines': '保留行 {ranges}',
  'toggle': '显示保留与裁剪的输出',
}

/** Message keys of this namespace. */
export type LayaPrunerKey = keyof typeof zh

/** English dictionary (same key set). */
export const en: Record<LayaPrunerKey, string> = {
  'title': 'laya_context_pruner',
  'running': 'Pruning context · {tokens} tokens',
  'phase.release': 'DS4 · freeing cache memory',
  'phase.start': 'Starting Laya',
  'phase.stop': 'Stopping Laya',
  'phase.restore': 'DS4 · restoring cache capacity',
  'summary': '{before} → {after} tokens (−{pct}%)',
  'counts': '{kept} kept · {truncated} truncated · {dropped} dropped · {time}',
  'fallback': 'Skipped · regular compaction decides',
  'fallbackReason': 'Skipped · regular compaction decides · {reason}',
  'group.KEEP': 'Kept whole ({count})',
  'group.TRUNCATE': 'Truncated to kept lines ({count})',
  'group.DROP': 'Removed ({count})',
  'item.tokens': '{before} → {after}',
  'item.lines': '{lines} lines',
  'item.keptLines': 'kept lines {ranges}',
  'toggle': 'Show kept and pruned outputs',
}

/** Japanese dictionary (same key set). */
export const ja: Record<LayaPrunerKey, string> = {
  'title': 'laya_context_pruner',
  'running': 'コンテキストを削減中 · {tokens} トークン',
  'phase.release': 'DS4 · キャッシュメモリを解放中',
  'phase.start': 'Laya を起動中',
  'phase.stop': 'Laya を停止中',
  'phase.restore': 'DS4 · キャッシュ容量を復元中',
  'summary': '{before} → {after} トークン (−{pct}%)',
  'counts': '保持 {kept} · 切り詰め {truncated} · 削除 {dropped} · {time}',
  'fallback': 'スキップ · 通常の圧縮に任せます',
  'fallbackReason': 'スキップ · 通常の圧縮に任せます · {reason}',
  'group.KEEP': 'そのまま保持 ({count})',
  'group.TRUNCATE': '保持する行に切り詰め ({count})',
  'group.DROP': '削除 ({count})',
  'item.tokens': '{before} → {after}',
  'item.lines': '{lines} 行',
  'item.keptLines': '保持した行 {ranges}',
  'toggle': '保持・削減した出力を表示',
}

/** Spanish dictionary (same key set). */
export const es: Record<LayaPrunerKey, string> = {
  'title': 'laya_context_pruner',
  'running': 'Recortando el contexto · {tokens} tokens',
  'phase.release': 'DS4 · liberando memoria de caché',
  'phase.start': 'Iniciando Laya',
  'phase.stop': 'Deteniendo Laya',
  'phase.restore': 'DS4 · restaurando la capacidad de caché',
  'summary': '{before} → {after} tokens (−{pct}%)',
  'counts': '{kept} conservados · {truncated} truncados · {dropped} eliminados · {time}',
  'fallback': 'Omitido · decide la compactación habitual',
  'fallbackReason': 'Omitido · decide la compactación habitual · {reason}',
  'group.KEEP': 'Conservados completos ({count})',
  'group.TRUNCATE': 'Truncados a las líneas conservadas ({count})',
  'group.DROP': 'Eliminados ({count})',
  'item.tokens': '{before} → {after}',
  'item.lines': '{lines} líneas',
  'item.keptLines': 'líneas conservadas {ranges}',
  'toggle': 'Mostrar las salidas conservadas y recortadas',
}

/** French dictionary (same key set). */
export const fr: Record<LayaPrunerKey, string> = {
  'title': 'laya_context_pruner',
  'running': 'Élagage du contexte · {tokens} jetons',
  'phase.release': 'DS4 · libération de la mémoire cache',
  'phase.start': 'Démarrage de Laya',
  'phase.stop': 'Arrêt de Laya',
  'phase.restore': 'DS4 · restauration de la capacité du cache',
  'summary': '{before} → {after} jetons (−{pct}%)',
  'counts': '{kept} conservés · {truncated} tronqués · {dropped} supprimés · {time}',
  'fallback': 'Ignoré · la compaction habituelle décide',
  'fallbackReason': 'Ignoré · la compaction habituelle décide · {reason}',
  'group.KEEP': 'Conservés en entier ({count})',
  'group.TRUNCATE': 'Tronqués aux lignes conservées ({count})',
  'group.DROP': 'Supprimés ({count})',
  'item.tokens': '{before} → {after}',
  'item.lines': '{lines} lignes',
  'item.keptLines': 'lignes conservées {ranges}',
  'toggle': 'Afficher les sorties conservées et élaguées',
}

/** German dictionary (same key set). */
export const de: Record<LayaPrunerKey, string> = {
  'title': 'laya_context_pruner',
  'running': 'Kontext wird gekürzt · {tokens} Tokens',
  'phase.release': 'DS4 · Cache-Speicher wird freigegeben',
  'phase.start': 'Laya wird gestartet',
  'phase.stop': 'Laya wird beendet',
  'phase.restore': 'DS4 · Cache-Kapazität wird wiederhergestellt',
  'summary': '{before} → {after} Tokens (−{pct}%)',
  'counts': '{kept} behalten · {truncated} gekürzt · {dropped} entfernt · {time}',
  'fallback': 'Übersprungen · reguläre Komprimierung entscheidet',
  'fallbackReason': 'Übersprungen · reguläre Komprimierung entscheidet · {reason}',
  'group.KEEP': 'Vollständig behalten ({count})',
  'group.TRUNCATE': 'Auf behaltene Zeilen gekürzt ({count})',
  'group.DROP': 'Entfernt ({count})',
  'item.tokens': '{before} → {after}',
  'item.lines': '{lines} Zeilen',
  'item.keptLines': 'behaltene Zeilen {ranges}',
  'toggle': 'Behaltene und gekürzte Ausgaben anzeigen',
}

/** Russian dictionary (same key set). */
export const ru: Record<LayaPrunerKey, string> = {
  'title': 'laya_context_pruner',
  'running': 'Сокращение контекста · {tokens} токенов',
  'phase.release': 'DS4 · освобождение памяти кэша',
  'phase.start': 'Запуск Laya',
  'phase.stop': 'Остановка Laya',
  'phase.restore': 'DS4 · восстановление ёмкости кэша',
  'summary': '{before} → {after} токенов (−{pct}%)',
  'counts': 'сохранено {kept} · усечено {truncated} · удалено {dropped} · {time}',
  'fallback': 'Пропущено · решает обычное сжатие',
  'fallbackReason': 'Пропущено · решает обычное сжатие · {reason}',
  'group.KEEP': 'Сохранено целиком ({count})',
  'group.TRUNCATE': 'Усечено до сохранённых строк ({count})',
  'group.DROP': 'Удалено ({count})',
  'item.tokens': '{before} → {after}',
  'item.lines': 'строк: {lines}',
  'item.keptLines': 'сохранённые строки {ranges}',
  'toggle': 'Показать сохранённые и сокращённые выводы',
}

/** Portuguese dictionary (same key set). */
export const pt: Record<LayaPrunerKey, string> = {
  'title': 'laya_context_pruner',
  'running': 'Reduzindo o contexto · {tokens} tokens',
  'phase.release': 'DS4 · liberando memória de cache',
  'phase.start': 'Iniciando o Laya',
  'phase.stop': 'Encerrando o Laya',
  'phase.restore': 'DS4 · restaurando a capacidade do cache',
  'summary': '{before} → {after} tokens (−{pct}%)',
  'counts': '{kept} mantidos · {truncated} truncados · {dropped} removidos · {time}',
  'fallback': 'Ignorado · a compactação normal decide',
  'fallbackReason': 'Ignorado · a compactação normal decide · {reason}',
  'group.KEEP': 'Mantidos inteiros ({count})',
  'group.TRUNCATE': 'Truncados às linhas mantidas ({count})',
  'group.DROP': 'Removidos ({count})',
  'item.tokens': '{before} → {after}',
  'item.lines': '{lines} linhas',
  'item.keptLines': 'linhas mantidas {ranges}',
  'toggle': 'Mostrar saídas mantidas e reduzidas',
}
