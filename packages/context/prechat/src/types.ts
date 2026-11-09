/** Imported messages retain their human-authored origin through persistence and replay. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Human-authored conversation prefix; no model generated these messages. @persistenceAttribution */
    prechat: { kind: 'prechat' }
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { prechat: number }
}
export {}
