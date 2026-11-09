/** `settings.permission` namespace dictionaries (the Permission row's copy). */

/** Locale namespace shared by both current-session permission pickers. */
export const PERMISSION_ACCESS_NS = 'permission.access'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '权限',
  'description': '选择新会话的默认权限模式',
  'loading': '加载中',
  'unavailable': '不可用',
  'preset.readOnly': '仅可查看',
  'preset.workspaceWrite': '工作区内修改',
  'preset.fullAccess': '完全权限',
  'confirm.title': '确认启用完全权限？',
  'confirm.description': '启用完全权限后，新会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '启用完全权限',
} satisfies Record<string, string>

/** The settings.permission namespace key union. */
export type PermissionSettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Permission',
  'description': 'Choose the default permission mode for new sessions',
  'loading': 'Loading',
  'unavailable': 'Unavailable',
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Full access',
  'confirm.title': 'Enable Full access?',
  'confirm.description': 'Full access lets new sessions reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Full access',
} satisfies Record<PermissionSettingsKey, string>

/** Simplified Chinese dictionary for the current-session popup gate. */
export const accessZh = {
  'mode': '访问模式，当前：{name}',
  'close': '关闭',
  'preset.readOnly': '仅可查看',
  'preset.workspaceWrite': '工作区内修改',
  'preset.fullAccess': '完全权限',
  'confirm.title': '确认启用完全权限？',
  'confirm.description': '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '启用完全权限',
  'smart.label': '智能审批',
  'smart.badge': 'AI',
  'smart.description': '保留工作区沙箱；由隔离的同模型请求审查权限升级，不确定时由用户确认。',
  'smart.confirm.title': '启用智能审批？',
  'smart.confirm.description': '使用与当前智能体相同的模型独立审查权限升级。沙箱保持启用；敏感操作、错误或不确定结果需要人工确认。审查会消耗额外 token，模型也可能判断错误。',
  'smart.confirm.acknowledge': '我了解模型可能出错，并同意额外的模型请求',
  'smart.confirm.enable': '启用智能审批',
  'auto.label': '自动审查',
  'auto.badge': 'EXP',
  'auto.description': '无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。',
  'auto.confirm.title': '确认启用自动审查（实验）？',
  'auto.confirm.description': '自动审查不使用沙箱。每次原生工具调用和 PTC 内层调用前，都会由与当前 agent 相同的模型进行审查；审查拒绝的调用由你批准或拒绝。此功能仍属实验性，可能误放行或误拒绝，并会消耗额外 token。',
  'auto.confirm.acknowledge': '我已了解这些风险，并愿意继续',
  'auto.confirm.enable': '启用自动审查',
} satisfies Record<string, string>

/** Current-session popup-gate key union. */
export type PermissionAccessKey = keyof typeof accessZh

/** English dictionary for the current-session popup gate. */
export const accessEn = {
  'mode': 'Access mode, current: {name}',
  'close': 'Close',
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Full access',
  'confirm.title': 'Enable Full access?',
  'confirm.description': 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Full access',
  'smart.label': 'Smart approval',
  'smart.badge': 'AI',
  'smart.description': 'Keep the workspace sandbox; isolated same-model review with human fallback for permission escalation.',
  'smart.confirm.title': 'Enable Smart approval?',
  'smart.confirm.description': 'The current agent model reviews eligible permission escalations in a separate request. The workspace sandbox stays enabled. Sensitive, uncertain, failed or timed-out reviews require human confirmation. Reviews use extra tokens and the model can make mistakes.',
  'smart.confirm.acknowledge': 'I understand the model can make mistakes and consent to extra model requests',
  'smart.confirm.enable': 'Enable Smart approval',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Run without a sandbox after an experimental same-model review of every native tool call and PTC inner call.',
  'auto.confirm.title': 'Enable Auto review (experimental)?',
  'auto.confirm.description': 'Auto review runs without a sandbox. Before every native tool call and PTC inner call, the same model as the current agent reviews whether to allow it; you approve or reject each call it denies. This feature is experimental, can falsely allow or deny actions, and uses additional tokens.',
  'auto.confirm.acknowledge': 'I understand these risks and want to continue',
  'auto.confirm.enable': 'Enable Auto review',
} satisfies Record<PermissionAccessKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': '権限',
  'description': '新しいセッションのデフォルトの権限モードを選択',
  'loading': '読み込み中',
  'unavailable': '利用不可',
  'preset.readOnly': '読み取り専用',
  'preset.workspaceWrite': 'ワークスペース書き込み',
  'preset.fullAccess': 'フルアクセス',
  'confirm.title': 'フルアクセスを有効にしますか？',
  'confirm.description': 'フルアクセスでは、新しいセッションで確認ステップが減り、機密操作・ファイル変更・外部コマンドなど多くの操作を直接実行できるようになります。以降のタスクを信頼できる場合にのみ使用してください。',
  'confirm.acknowledge': 'リスクを理解し、続行します',
  'confirm.cancel': 'キャンセル',
  'confirm.enable': 'フルアクセスを有効にする',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'title': 'Permiso',
  'description': 'Elija el modo de permiso predeterminado para nuevas sesiones',
  'loading': 'Cargando',
  'unavailable': 'No disponible',
  'preset.readOnly': 'Sólo lectura',
  'preset.workspaceWrite': 'Escritura en el espacio de trabajo',
  'preset.fullAccess': 'Acceso completo',
  'confirm.title': '¿Habilitar acceso completo?',
  'confirm.description': 'El acceso completo permite que las nuevas sesiones reduzcan los pasos de confirmación y realicen más acciones directamente, incluidas operaciones confidenciales, cambios de archivos o comandos externos. Úselo sólo cuando confíe en las tareas posteriores.',
  'confirm.acknowledge': 'Entiendo los riesgos y quiero continuar.',
  'confirm.cancel': 'Cancelar',
  'confirm.enable': 'Habilitar acceso completo',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'title': 'Autorisation',
  'description': "Choisissez le mode d'autorisation par défaut pour les nouvelles sessions",
  'loading': 'Chargement',
  'unavailable': 'Indisponible',
  'preset.readOnly': 'Lecture seule',
  'preset.workspaceWrite': "Écriture dans l'espace de travail",
  'preset.fullAccess': 'Accès complet',
  'confirm.title': "Activer l'accès complet ?",
  'confirm.description': "L'accès complet permet aux nouvelles sessions de réduire les étapes de confirmation et d'effectuer directement davantage d'actions, notamment des opérations sensibles, des modifications de fichiers ou des commandes externes. Utilisez-le uniquement lorsque vous faites confiance aux tâches suivantes.",
  'confirm.acknowledge': 'Je comprends les risques et je veux continuer',
  'confirm.cancel': 'Annuler',
  'confirm.enable': "Activer l'accès complet",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'title': 'Erlaubnis',
  'description': 'Wählen Sie den Standardberechtigungsmodus für neue Sitzungen',
  'loading': 'Laden',
  'unavailable': 'Nicht verfügbar',
  'preset.readOnly': 'Nur lesen',
  'preset.workspaceWrite': 'Arbeitsbereich schreiben',
  'preset.fullAccess': 'Voller Zugriff',
  'confirm.title': 'Vollzugriff aktivieren?',
  'confirm.description': 'Durch den vollständigen Zugriff können neue Sitzungen die Bestätigungsschritte reduzieren und mehr Aktionen direkt ausführen, einschließlich vertraulicher Vorgänge, Dateiänderungen oder externer Befehle. Verwenden Sie es nur, wenn Sie nachfolgenden Aufgaben vertrauen.',
  'confirm.acknowledge': 'Ich verstehe die Risiken und möchte weitermachen',
  'confirm.cancel': 'Abbrechen',
  'confirm.enable': 'Aktivieren Sie Vollzugriff',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'title': 'Разрешение',
  'description': 'Выберите режим разрешений по умолчанию для новых сеансов',
  'loading': 'Загрузка',
  'unavailable': 'Недоступно',
  'preset.readOnly': 'Только чтение',
  'preset.workspaceWrite': 'Запись в рабочей области',
  'preset.fullAccess': 'Полный доступ',
  'confirm.title': 'Включить полный доступ?',
  'confirm.description': 'Полный доступ позволяет новым сеансам сократить количество шагов подтверждения и напрямую выполнять больше действий, включая конфиденциальные операции, изменение файлов или внешние команды. Используйте его только в том случае, если вы доверяете последующим задачам.',
  'confirm.acknowledge': 'Я понимаю риски и хочу продолжить',
  'confirm.cancel': 'Отмена',
  'confirm.enable': 'Включить полный доступ',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'title': 'Permissão',
  'description': 'Escolha o modo de permissão padrão para novas sessões',
  'loading': 'Carregando',
  'unavailable': 'Indisponível',
  'preset.readOnly': 'Somente leitura',
  'preset.workspaceWrite': 'Gravação no espaço de trabalho',
  'preset.fullAccess': 'Acesso total',
  'confirm.title': 'Ativar acesso total?',
  'confirm.description': 'O acesso total permite que novas sessões reduzam as etapas de confirmação e executem mais ações diretamente, incluindo operações confidenciais, alterações de arquivos ou comandos externos. Use-o apenas quando confiar nas tarefas subsequentes.',
  'confirm.acknowledge': 'Entendo os riscos e quero continuar',
  'confirm.cancel': 'Cancelar',
  'confirm.enable': 'Ativar acesso total',
} satisfies Record<keyof typeof en, string>

/** Japanese copy, checked against the English keys. */
export const accessJa = {
  'mode': 'アクセスモード、現在: {name}',
  'close': '閉じる',
  'preset.readOnly': '読み取り専用',
  'preset.workspaceWrite': 'ワークスペース書き込み',
  'preset.fullAccess': 'フルアクセス',
  'confirm.title': 'フルアクセスを有効にしますか？',
  'confirm.description': 'フルアクセスでは確認ステップが減り、エージェントが機密操作・ファイル変更・外部コマンドなど多くの操作を直接実行できるようになります。現在のタスクを信頼できる場合にのみ使用してください。',
  'confirm.acknowledge': 'リスクを理解し、続行します',
  'confirm.cancel': 'キャンセル',
  'confirm.enable': 'フルアクセスを有効にする',
  'smart.label': 'スマート承認',
  'smart.badge': 'AI',
  'smart.description': 'ワークスペースのサンドボックスを維持し、同じモデルの独立したリクエストで権限昇格を審査します。不確実な場合はユーザーに確認します。',
  'smart.confirm.title': 'スマート承認を有効にしますか？',
  'smart.confirm.description': '現在のエージェントと同じモデルが、対象の権限昇格を別のリクエストで審査します。ワークスペースのサンドボックスは有効なままです。機密性が高い、不確実、失敗、タイムアウトの場合は人による確認が必要です。追加のトークンを消費し、モデルが誤る可能性があります。',
  'smart.confirm.acknowledge': 'モデルが誤る可能性を理解し、追加のモデルリクエストに同意します',
  'smart.confirm.enable': 'スマート承認を有効にする',
  'auto.label': '自動認可レビュー',
  'auto.badge': 'EXP',
  'auto.description': 'すべてのネイティブツール呼び出しと PTC 内部呼び出しを実験的な同一モデルでレビューしたうえで、サンドボックスなしで実行します。',
  'auto.confirm.title': '自動認可レビュー（実験的）を有効にしますか？',
  'auto.confirm.description': '自動認可レビューはサンドボックスなしで実行されます。ネイティブツール呼び出しと PTC 内部呼び出しのたびに、現在のエージェントと同じモデルが許可可否をレビューし、拒否された呼び出しはあなたが承認または却下します。この機能は実験的であり、操作を誤って許可・拒否する可能性があり、追加のトークンを消費します。',
  'auto.confirm.acknowledge': 'これらのリスクを理解し、続行します',
  'auto.confirm.enable': '自動認可レビューを有効にする',
} satisfies Record<keyof typeof accessEn, string>

/** Spanish dictionary, checked against the English keys. */
export const accessEs = {
  'mode': 'Modo de acceso, actual: {name}',
  'close': 'Cerrar',
  'preset.readOnly': 'Sólo lectura',
  'preset.workspaceWrite': 'Escritura en el espacio de trabajo',
  'preset.fullAccess': 'Acceso completo',
  'confirm.title': '¿Habilitar acceso completo?',
  'confirm.description': 'El acceso completo reduce los pasos de confirmación y permite al agente realizar más acciones directamente, incluidas operaciones confidenciales, cambios de archivos o comandos externos. Úselo solo cuando confíe en la tarea actual.',
  'confirm.acknowledge': 'Entiendo los riesgos y quiero continuar.',
  'confirm.cancel': 'Cancelar',
  'confirm.enable': 'Habilitar acceso completo',
  'smart.label': 'Aprobación inteligente',
  'smart.badge': 'IA',
  'smart.description': 'Mantiene el aislamiento del espacio de trabajo; revisa las elevaciones de permisos con el mismo modelo en una solicitud independiente y recurre al usuario si hay dudas.',
  'smart.confirm.title': '¿Activar la aprobación inteligente?',
  'smart.confirm.description': 'El modelo del agente actual revisa las elevaciones de permisos admisibles en una solicitud independiente. El aislamiento del espacio de trabajo sigue activo. Las revisiones sensibles, inciertas, fallidas o que agoten el tiempo requieren confirmación humana. Consumen tokens adicionales y el modelo puede equivocarse.',
  'smart.confirm.acknowledge': 'Entiendo que el modelo puede equivocarse y acepto las solicitudes adicionales',
  'smart.confirm.enable': 'Activar la aprobación inteligente',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Ejecute sin una zona de pruebas después de una revisión experimental del mismo modelo de cada llamada de herramienta nativa y llamada interna PTC.',
  'auto.confirm.title': '¿Habilitar Auto review (experimental)?',
  'auto.confirm.description': 'Auto review se ejecuta sin zona de pruebas. Antes de cada llamada a la herramienta nativa y llamada interna PTC, el mismo modelo que el agente actual revisa si se permite; usted aprueba o rechaza cada llamada que rechaza. Esta característica es experimental, puede permitir o denegar acciones falsamente y utiliza tokens adicionales.',
  'auto.confirm.acknowledge': 'Entiendo estos riesgos y quiero continuar',
  'auto.confirm.enable': 'Habilitar Auto review',
} satisfies typeof accessEn

/** French dictionary, checked against the English keys. */
export const accessFr = {
  'mode': "Mode d'accès, actuel : {name}",
  'close': 'Fermer',
  'preset.readOnly': 'Lecture seule',
  'preset.workspaceWrite': "Écriture dans l'espace de travail",
  'preset.fullAccess': 'Accès complet',
  'confirm.title': "Activer l'accès complet ?",
  'confirm.description': "L'accès complet réduit les étapes de confirmation et permet à l'agent d'effectuer directement davantage d'actions, notamment des opérations sensibles, des modifications de fichiers ou des commandes externes. Utilisez-le uniquement lorsque vous faites confiance à la tâche en cours.",
  'confirm.acknowledge': 'Je comprends les risques et je veux continuer',
  'confirm.cancel': 'Annuler',
  'confirm.enable': "Activer l'accès complet",
  'smart.label': 'Approbation intelligente',
  'smart.badge': 'IA',
  'smart.description': 'Conserve le bac à sable de l’espace de travail ; examine les élévations de permissions avec le même modèle dans une requête séparée et sollicite l’utilisateur en cas de doute.',
  'smart.confirm.title': 'Activer l’approbation intelligente ?',
  'smart.confirm.description': 'Le modèle de l’agent actuel examine les élévations de permissions admissibles dans une requête séparée. Le bac à sable reste actif. Les examens sensibles, incertains, échoués ou expirés nécessitent une confirmation humaine. Ils consomment des tokens supplémentaires et le modèle peut se tromper.',
  'smart.confirm.acknowledge': 'Je comprends que le modèle peut se tromper et j’accepte les requêtes supplémentaires',
  'smart.confirm.enable': 'Activer l’approbation intelligente',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': "Exécutez sans bac à sable après un examen expérimental sur le même modèle de chaque appel d'outil natif et appel interne PTC.",
  'auto.confirm.title': 'Activer Auto review (expérimental) ?',
  'auto.confirm.description': "Auto review fonctionne sans bac à sable. Avant chaque appel d'outil natif et appel interne PTC, le même modèle que l'agent actuel vérifie s'il doit l'autoriser ; vous approuvez ou rejetez chaque appel qu'il refuse. Cette fonctionnalité est expérimentale, peut autoriser ou refuser à tort des actions et utilise des jetons supplémentaires.",
  'auto.confirm.acknowledge': 'Je comprends ces risques et je veux continuer',
  'auto.confirm.enable': 'Activer Auto review',
} satisfies typeof accessEn

/** German dictionary, checked against the English keys. */
export const accessDe = {
  'mode': 'Zugriffsmodus, aktuell: {name}',
  'close': 'Schließen',
  'preset.readOnly': 'Nur lesen',
  'preset.workspaceWrite': 'Arbeitsbereich schreiben',
  'preset.fullAccess': 'Voller Zugriff',
  'confirm.title': 'Vollzugriff aktivieren?',
  'confirm.description': 'Durch den Vollzugriff werden Bestätigungsschritte reduziert und der Agent kann mehr Aktionen direkt ausführen, einschließlich vertraulicher Vorgänge, Dateiänderungen oder externer Befehle. Verwenden Sie es nur, wenn Sie der aktuellen Aufgabe vertrauen.',
  'confirm.acknowledge': 'Ich verstehe die Risiken und möchte weitermachen',
  'confirm.cancel': 'Abbrechen',
  'confirm.enable': 'Aktivieren Sie Vollzugriff',
  'smart.label': 'Intelligente Freigabe',
  'smart.badge': 'KI',
  'smart.description': 'Behält die Arbeitsbereich-Sandbox bei; prüft Rechteerweiterungen mit demselben Modell in einer separaten Anfrage und fragt bei Unsicherheit den Nutzer.',
  'smart.confirm.title': 'Intelligente Freigabe aktivieren?',
  'smart.confirm.description': 'Das aktuelle Agentenmodell prüft geeignete Rechteerweiterungen in einer separaten Anfrage. Die Arbeitsbereich-Sandbox bleibt aktiv. Sensible, unsichere, fehlgeschlagene oder abgelaufene Prüfungen erfordern eine menschliche Bestätigung. Prüfungen verbrauchen zusätzliche Tokens und das Modell kann Fehler machen.',
  'smart.confirm.acknowledge': 'Ich verstehe, dass das Modell Fehler machen kann, und stimme zusätzlichen Modellanfragen zu',
  'smart.confirm.enable': 'Intelligente Freigabe aktivieren',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Ausführung ohne Sandbox nach einer experimentellen, modellgleichen Überprüfung jedes nativen Toolaufrufs und PTC-Innenaufrufs.',
  'auto.confirm.title': 'Auto review aktivieren (experimentell)?',
  'auto.confirm.description': 'Auto review läuft ohne Sandbox. Vor jedem nativen Tool-Aufruf und PTC-Innenaufruf überprüft dasselbe Modell wie der aktuelle Agent, ob dies zulässig ist. Sie genehmigen oder lehnen jeden abgelehnten Aufruf ab. Diese Funktion ist experimentell, kann Aktionen fälschlicherweise zulassen oder verweigern und verwendet zusätzliche Token.',
  'auto.confirm.acknowledge': 'Ich verstehe diese Risiken und möchte weitermachen',
  'auto.confirm.enable': 'Aktivieren Sie Auto review',
} satisfies typeof accessEn

/** Russian dictionary, checked against the English keys. */
export const accessRu = {
  'mode': 'Режим доступа, текущий: {name}',
  'close': 'Закрыть',
  'preset.readOnly': 'Только чтение',
  'preset.workspaceWrite': 'Запись в рабочей области',
  'preset.fullAccess': 'Полный доступ',
  'confirm.title': 'Включить полный доступ?',
  'confirm.description': 'Полный доступ сокращает количество шагов подтверждения и позволяет агенту напрямую выполнять больше действий, включая конфиденциальные операции, изменения файлов или внешние команды. Используйте его только в том случае, если вы доверяете текущей задаче.',
  'confirm.acknowledge': 'Я понимаю риски и хочу продолжить',
  'confirm.cancel': 'Отмена',
  'confirm.enable': 'Включить полный доступ',
  'smart.label': 'Умное одобрение',
  'smart.badge': 'ИИ',
  'smart.description': 'Сохраняет песочницу рабочей области; проверяет повышение прав отдельным запросом к той же модели и обращается к пользователю при сомнениях.',
  'smart.confirm.title': 'Включить умное одобрение?',
  'smart.confirm.description': 'Текущая модель агента проверяет допустимые повышения прав отдельным запросом. Песочница рабочей области остаётся включённой. Чувствительные, неопределённые, неудачные проверки и проверки с истекшим временем требуют подтверждения пользователя. Проверки расходуют дополнительные токены, и модель может ошибаться.',
  'smart.confirm.acknowledge': 'Я понимаю, что модель может ошибаться, и согласен на дополнительные запросы к модели',
  'smart.confirm.enable': 'Включить умное одобрение',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Запуск без песочницы после экспериментальной проверки одной и той же модели каждого вызова встроенного инструмента и внутреннего вызова PTC.',
  'auto.confirm.title': 'Включить Auto review (экспериментально)?',
  'auto.confirm.description': 'Auto review работает без песочницы. Перед каждым вызовом собственного инструмента и внутренним вызовом PTC та же модель, что и текущий агент, проверяет, разрешить ли это; вы одобряете или отклоняете каждый вызов, который он отклоняет. Эта функция является экспериментальной, может ошибочно разрешать или запрещать действия и использует дополнительные токены.',
  'auto.confirm.acknowledge': 'Я понимаю эти риски и хочу продолжить',
  'auto.confirm.enable': 'Включить Auto review',
} satisfies typeof accessEn

/** Portuguese dictionary, checked against the English keys. */
export const accessPt = {
  'mode': 'Modo de acesso, atual: {name}',
  'close': 'Fechar',
  'preset.readOnly': 'Somente leitura',
  'preset.workspaceWrite': 'Gravação no espaço de trabalho',
  'preset.fullAccess': 'Acesso total',
  'confirm.title': 'Ativar acesso total?',
  'confirm.description': 'O acesso total reduz as etapas de confirmação e permite que o agente execute mais ações diretamente, incluindo operações confidenciais, alterações de arquivos ou comandos externos. Use-o apenas quando confiar na tarefa atual.',
  'confirm.acknowledge': 'Entendo os riscos e quero continuar',
  'confirm.cancel': 'Cancelar',
  'confirm.enable': 'Ativar acesso total',
  'smart.label': 'Aprovação inteligente',
  'smart.badge': 'IA',
  'smart.description': 'Mantém a sandbox do espaço de trabalho; revê elevações de permissões com o mesmo modelo num pedido separado e recorre ao utilizador em caso de dúvida.',
  'smart.confirm.title': 'Ativar a aprovação inteligente?',
  'smart.confirm.description': 'O modelo do agente atual revê as elevações de permissões elegíveis num pedido separado. A sandbox do espaço de trabalho mantém-se ativa. Revisões sensíveis, incertas, falhadas ou expiradas exigem confirmação humana. Consomem tokens adicionais e o modelo pode cometer erros.',
  'smart.confirm.acknowledge': 'Compreendo que o modelo pode cometer erros e aceito pedidos adicionais ao modelo',
  'smart.confirm.enable': 'Ativar a aprovação inteligente',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Execute sem um sandbox após uma revisão experimental do mesmo modelo de cada chamada de ferramenta nativa e PTC chamada interna.',
  'auto.confirm.title': 'Ativar Auto review (experimental)?',
  'auto.confirm.description': 'Auto review é executado sem sandbox. Antes de cada chamada de ferramenta nativa e chamada interna PTC, o mesmo modelo do agente atual analisa se deve permitir isso; você aprova ou rejeita cada chamada negada. Este recurso é experimental, pode permitir ou negar ações falsamente e usa tokens adicionais.',
  'auto.confirm.acknowledge': 'Entendo esses riscos e quero continuar',
  'auto.confirm.enable': 'Ativar Auto review',
} satisfies typeof accessEn
