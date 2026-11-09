/** Semantic terminal colours. Themes affect presentation, never session config. */
export type ThemeName = 'dark' | 'light' | 'mono'
/** Semantic colour role used by rows and spans. */
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
  | 'command'
  | 'brand'
  | 'footer'
  | 'toolBash'
  | 'toolEdit'
  | 'toolWrite'
  | 'toolRead'
  | 'toolSearch'
  | 'toolWeb'

/** Colour per tone; undefined leaves the terminal default. */
export type Palette = Readonly<Record<Tone, string | undefined>>

const dark: Palette = {
  text: undefined,
  muted: '#7f849c',
  accent: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  reasoning: '#b48ead',
  keyword: 'magenta',
  string: 'green',
  number: 'yellow',
  comment: '#6c7086',
  command: '#5fafff',
  brand: '#4d6bfe',
  footer: '#89b4fa',
  toolBash: '#ffaf00',
  toolEdit: '#5fafff',
  toolWrite: '#00d787',
  toolRead: '#00d7ff',
  toolSearch: '#ff87d7',
  toolWeb: '#af87ff',
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
  command: '#0087d7',
  brand: '#3b5bdb',
  footer: '#1c7ed6',
  toolBash: '#d9480f',
  toolEdit: '#1971c2',
  toolWrite: '#099268',
  toolRead: '#0c8599',
  toolSearch: '#c2255c',
  toolWeb: '#5f3dc4',
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
