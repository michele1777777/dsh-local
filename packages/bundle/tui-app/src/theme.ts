/** Semantic terminal colours. Themes affect presentation, never session config. */
export type ThemeName = 'dark' | 'light' | 'mono'
/**
 * Semantic colour role used by rows and spans. `description` is secondary text that is read, such as what a tool call
 * does, lighter than `muted`, which is for metadata such as durations.
 */
export type Tone =
  | 'text'
  | 'muted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | 'reasoning'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'description'
  | 'command'
  | 'brand'
  | 'footer'
  | 'toolBash'
  | 'toolEdit'
  | 'toolWrite'
  | 'toolRead'
  | 'toolSearch'
  | 'toolWeb'
  | 'band'
  | 'plate'
  | 'select'
  | 'hit'
  | 'added'
  | 'addedStrong'
  | 'removed'
  | 'removedStrong'

/**
 * Tones meant as a span's background: `band` under a user prompt and a code block, `plate` under a requested command,
 * `select` under the chosen row of a list, `hit` under a search match, and the four diff tones under changed lines and the
 * changed part inside them. The `mono` theme has none; there a `select` or `hit` background shows as inverse video.
 */
export type BackgroundTone = 'band' | 'plate' | 'select' | 'hit' | 'added' | 'addedStrong' | 'removed' | 'removedStrong'

/** Colour per tone; undefined leaves the terminal default. */
export type Palette = Readonly<Record<Tone, string | undefined>>

const dark: Palette = {
  text: undefined,
  muted: '#82879e',
  accent: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  reasoning: '#b48ead',
  keyword: 'magenta',
  string: 'green',
  number: 'yellow',
  comment: '#83869b',
  description: '#b4b9cf',
  command: '#5fafff',
  brand: '#617cfe',
  footer: '#89b4fa',
  toolBash: '#ffaf00',
  toolEdit: '#5fafff',
  toolWrite: '#00d787',
  toolRead: '#00d7ff',
  toolSearch: '#ff87d7',
  toolWeb: '#af87ff',
  band: '#1b1c2b',
  plate: '#222225',
  select: '#262a44',
  hit: '#1c4444',
  added: '#14301f',
  addedStrong: '#1f5c36',
  removed: '#3a1a22',
  removedStrong: '#74293a',
}

const light: Palette = {
  text: undefined,
  muted: '#626262',
  accent: '#005faf',
  success: '#008700',
  warning: '#875f00',
  error: '#af0000',
  reasoning: '#7048e8',
  keyword: '#870087',
  string: '#008700',
  number: '#875f00',
  comment: '#626262',
  description: '#3f434d',
  command: '#007ac3',
  brand: '#3b5bdb',
  footer: '#1b79cd',
  toolBash: '#d2460f',
  toolEdit: '#1971c2',
  toolWrite: '#08865f',
  toolRead: '#0c8194',
  toolSearch: '#c2255c',
  toolWeb: '#5f3dc4',
  band: '#eef0f6',
  plate: '#ececec',
  select: '#dfe5f7',
  hit: '#cdeeee',
  added: '#dcf5e3',
  addedStrong: '#aee6bd',
  removed: '#fbe2e4',
  removedStrong: '#f3b6bc',
}

const mono: Palette = Object.fromEntries(Object.keys(dark).map(key => [key, undefined])) as Record<Tone, undefined>

/**
 * Normalize a theme setting.
 * @param value - configured name, such as `DSH_TUI_THEME`.
 * @returns `light` or `mono` when named, otherwise `dark`.
 */
export function themeName(value: string | undefined): ThemeName {
  return value === 'light' || value === 'mono' ? value : 'dark'
}

/**
 * Colours for a theme; `mono` maps every tone to the terminal default.
 * @param name - theme name.
 * @returns the shared palette object for that theme.
 */
export function palette(name: ThemeName = 'dark'): Palette {
  return name === 'mono' ? mono : name === 'light' ? light : dark
}
