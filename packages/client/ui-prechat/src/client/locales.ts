/** Copy for prepared-conversation import. */
/** English import-dialog labels. */
export const en = {
  importedUser: 'User · imported example',
  saved: 'These messages are saved at the beginning of this chat. They are user-authored examples, not generated responses.',
  title: 'Initial conversation', hint: 'Paste USER: / ASSISTANT: pairs, or load a .txt file. Applying opens a new chat without generating a response.',
  load: 'Load .txt', preview: 'Preview', apply: 'Apply to new chat', edit: 'Edit', cancel: 'Cancel',
  user: 'User', assistant: 'Assistant', imported: 'Imported messages: {count}', working: 'Creating chat…',
  error: 'Could not import the conversation. {detail}', fileError: 'Choose one UTF-8 .txt file of at most 256 KiB.',
  placeholder: 'USER: Your example question.\nASSISTANT: Your example answer.',
} as const
/** Locale keys shared by the editor and transcript notice. */
export type PrechatKey = keyof typeof en
/** Chinese import-dialog labels. */
export const zh: Record<PrechatKey, string> = {
  importedUser: '用户 · 导入示例',
  saved: '这些消息保存在会话开头，是用户编写的示例，不是模型生成的回复。',
  title: '初始对话', hint: '粘贴 USER: / ASSISTANT: 对话或加载 .txt 文件。应用后创建新会话，不会生成回复。',
  load: '加载 .txt', preview: '预览', apply: '应用并新建会话', edit: '编辑', cancel: '取消',
  user: '用户', assistant: '助手', imported: '导入消息：{count}', working: '正在创建会话…',
  error: '无法导入对话。{detail}', fileError: '请选择一个不超过 256 KiB 的 UTF-8 .txt 文件。',
  placeholder: 'USER: 示例问题。\nASSISTANT: 示例回答。',
}
/** Japanese import-dialog labels. */
export const ja: Record<PrechatKey, string> = {
  importedUser: 'ユーザー · インポートした例',
  saved: 'これらのメッセージはこのチャットの先頭に保存されます。ユーザーが書いた例であり、生成された応答ではありません。',
  title: '初期会話', hint: 'USER: / ASSISTANT: の組を貼り付けるか、.txt ファイルを読み込みます。適用すると応答を生成せずに新しいチャットを開きます。',
  load: '.txt を読み込む', preview: 'プレビュー', apply: '新しいチャットに適用', edit: '編集', cancel: 'キャンセル',
  user: 'ユーザー', assistant: 'アシスタント', imported: 'インポートしたメッセージ: {count}', working: 'チャットを作成中…',
  error: '会話をインポートできませんでした。{detail}', fileError: '256 KiB 以下の UTF-8 .txt ファイルを 1 つ選んでください。',
  placeholder: 'USER: 例の質問。\nASSISTANT: 例の回答。',
}
/** Spanish import-dialog labels. */
export const es: Record<PrechatKey, string> = {
  importedUser: 'Usuario · ejemplo importado',
  saved: 'Estos mensajes se guardan al principio de este chat. Son ejemplos escritos por el usuario, no respuestas generadas.',
  title: 'Conversación inicial', hint: 'Pega pares USER: / ASSISTANT: o carga un archivo .txt. Al aplicar se abre un chat nuevo sin generar una respuesta.',
  load: 'Cargar .txt', preview: 'Vista previa', apply: 'Aplicar a un chat nuevo', edit: 'Editar', cancel: 'Cancelar',
  user: 'Usuario', assistant: 'Asistente', imported: 'Mensajes importados: {count}', working: 'Creando el chat…',
  error: 'No se pudo importar la conversación. {detail}', fileError: 'Elige un único archivo .txt UTF-8 de 256 KiB como máximo.',
  placeholder: 'USER: Tu pregunta de ejemplo.\nASSISTANT: Tu respuesta de ejemplo.',
}
/** French import-dialog labels. */
export const fr: Record<PrechatKey, string> = {
  importedUser: 'Utilisateur · exemple importé',
  saved: 'Ces messages sont enregistrés au début de cette discussion. Ce sont des exemples rédigés par l’utilisateur, pas des réponses générées.',
  title: 'Conversation initiale', hint: 'Collez des paires USER: / ASSISTANT: ou chargez un fichier .txt. L’application ouvre une nouvelle discussion sans générer de réponse.',
  load: 'Charger un .txt', preview: 'Aperçu', apply: 'Appliquer à une nouvelle discussion', edit: 'Modifier', cancel: 'Annuler',
  user: 'Utilisateur', assistant: 'Assistant', imported: 'Messages importés : {count}', working: 'Création de la discussion…',
  error: 'Impossible d’importer la conversation. {detail}', fileError: 'Choisissez un seul fichier .txt UTF-8 de 256 Kio au maximum.',
  placeholder: 'USER: Votre question d’exemple.\nASSISTANT: Votre réponse d’exemple.',
}
/** German import-dialog labels. */
export const de: Record<PrechatKey, string> = {
  importedUser: 'Benutzer · importiertes Beispiel',
  saved: 'Diese Nachrichten werden am Anfang dieses Chats gespeichert. Es sind vom Benutzer verfasste Beispiele, keine generierten Antworten.',
  title: 'Anfangsunterhaltung', hint: 'Füge USER: / ASSISTANT:-Paare ein oder lade eine .txt-Datei. Beim Anwenden wird ein neuer Chat geöffnet, ohne eine Antwort zu erzeugen.',
  load: '.txt laden', preview: 'Vorschau', apply: 'Auf neuen Chat anwenden', edit: 'Bearbeiten', cancel: 'Abbrechen',
  user: 'Benutzer', assistant: 'Assistent', imported: 'Importierte Nachrichten: {count}', working: 'Chat wird erstellt…',
  error: 'Die Unterhaltung konnte nicht importiert werden. {detail}', fileError: 'Wähle eine UTF-8-.txt-Datei mit höchstens 256 KiB.',
  placeholder: 'USER: Deine Beispielfrage.\nASSISTANT: Deine Beispielantwort.',
}
/** Russian import-dialog labels. */
export const ru: Record<PrechatKey, string> = {
  importedUser: 'Пользователь · импортированный пример',
  saved: 'Эти сообщения сохранены в начале чата. Это примеры, написанные пользователем, а не сгенерированные ответы.',
  title: 'Начальный разговор', hint: 'Вставьте пары USER: / ASSISTANT: или загрузите файл .txt. При применении откроется новый чат без генерации ответа.',
  load: 'Загрузить .txt', preview: 'Предпросмотр', apply: 'Применить к новому чату', edit: 'Изменить', cancel: 'Отмена',
  user: 'Пользователь', assistant: 'Ассистент', imported: 'Импортировано сообщений: {count}', working: 'Создание чата…',
  error: 'Не удалось импортировать разговор. {detail}', fileError: 'Выберите один файл .txt в кодировке UTF-8 размером не более 256 КиБ.',
  placeholder: 'USER: Ваш пример вопроса.\nASSISTANT: Ваш пример ответа.',
}
/** Portuguese import-dialog labels. */
export const pt: Record<PrechatKey, string> = {
  importedUser: 'Usuário · exemplo importado',
  saved: 'Estas mensagens ficam salvas no início deste chat. São exemplos escritos pelo usuário, não respostas geradas.',
  title: 'Conversa inicial', hint: 'Cole pares USER: / ASSISTANT: ou carregue um arquivo .txt. Ao aplicar, um novo chat é aberto sem gerar resposta.',
  load: 'Carregar .txt', preview: 'Pré-visualizar', apply: 'Aplicar a um novo chat', edit: 'Editar', cancel: 'Cancelar',
  user: 'Usuário', assistant: 'Assistente', imported: 'Mensagens importadas: {count}', working: 'Criando o chat…',
  error: 'Não foi possível importar a conversa. {detail}', fileError: 'Escolha um único arquivo .txt UTF-8 de até 256 KiB.',
  placeholder: 'USER: Sua pergunta de exemplo.\nASSISTANT: Sua resposta de exemplo.',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { prechat: PrechatKey }
}
