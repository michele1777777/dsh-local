/**
 * The three pre-rendered braille animations of the TUI: the packaged asset format, its validation and frame timing.
 *
 * Each asset is a gzip JSON file rendered outside the TUI: `frames` holds `fps × durationMs / 1000` frames of `rows` rows,
 * each row a list of `{ text, tone }` spans covering exactly `columns` cells with one theme tone per cell. Glyphs are spaces
 * and braille patterns, one cell each.
 * @module @deepseek-ai/dsh-tui-app/animation
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import type { Row, Span } from './rich-text.ts'
import { palette, type Tone } from './theme.ts'

/** Milliseconds between steps of the shared animation tick. */
export const ANIMATION_TICK_MS = 100

/** The packaged animations: `assets/anim/` beside `src/` in a checkout and beside `lib/` in a build. */
export const ANIMATION_ASSETS = new URL('../assets/anim/', import.meta.url)

/** A packaged animation file and the size it must declare. */
export interface Scene {
  /** File name inside the asset directory. */
  readonly file: string
  /** Width in terminal cells. */
  readonly columns: number
  /** Height in terminal rows. */
  readonly rows: number
}

/** The welcome whale: two clouds of dots that gather into a humpback and scatter again in a 6.4-second loop. */
export const WELCOME_SCENE: Scene = { file: 'welcome-whale.json.gz', columns: 60, rows: 15 }
/** The frame shown with motion off: the whale fully formed, eye open, without the reflection or the spout. */
export const WELCOME_STILL_FRAME = 44
/**
 * The Thinking scene: twenty-four constellations drawn star by star in a dotted sky, {@link CONSTELLATION_MS} each, every
 * finished figure named by its caption.
 */
export const THINKING_SCENE: Scene = { file: 'thinking-constellations.json.gz', columns: 48, rows: 12 }
/** Length of one constellation in {@link THINKING_SCENE}; a figure starts at every multiple of it. */
export const CONSTELLATION_MS = 6400
/** Time into a constellation where the figure is complete and named; the still shown with motion off. */
export const CONSTELLATION_STILL_MS = 5000
/** The small Thinking mark for short terminals: pulses cascading through twelve nodes on three rows in a 6.4-second loop. */
export const THINKING_MARK: Scene = { file: 'thinking-synapse.json.gz', columns: 12, rows: 3 }
/** The Laya pruning mark: grains read by a scanner on a dotted barrier, kept or crumbled, in a 4.8-second loop. */
export const PRUNING_SCENE: Scene = { file: 'pruning-sieve.json.gz', columns: 10, rows: 3 }

/** A validated animation: `frames[i]` holds `scene.rows` rows of exactly `scene.columns` cells. */
export interface SceneAnimation {
  /** The scene the file declared and was checked against. */
  readonly scene: Scene
  /** Frames per second of animation time. */
  readonly fps: number
  /** Length of one cycle in milliseconds. */
  readonly durationMs: number
  /** Every frame in playback order; rows and spans are shared and must not be mutated. */
  readonly frames: readonly (readonly Row[])[]
  /** Text shown beside each frame, empty for none; absent when the file has no captions. */
  readonly captions?: readonly string[]
  /** Cells of the widest caption; zero without captions. */
  readonly captionColumns: number
}

/** An unusable animation asset: unreadable, not gzip JSON, or not the declared animation. */
export class SceneAssetError extends Error {
  /**
   * @param file - the asset file name.
   * @param problem - what is wrong with it.
   * @param options - the underlying failure, when there is one.
   */
  constructor(readonly file: string, readonly problem: string, options?: ErrorOptions) {
    super(`Animation ${file} is unusable: ${problem}. The TUI shows no animation in its place; reinstall @deepseek-ai/dsh-tui-app to restore it.`, options)
    this.name = 'SceneAssetError'
  }
}

/** One cell per code point: spaces and braille patterns. */
const SCENE_GLYPHS = /^[ ⠀-⣿]+$/u
/** Captions are short printable text: letters, digits, spaces and punctuation, without control, combining or wide characters. */
const CAPTION_TEXT = /^[\p{L}\p{N}\p{P} ]{0,40}$/u

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTone = (value: unknown): value is Tone => typeof value === 'string' && Object.hasOwn(palette('dark'), value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

/**
 * Check parsed asset JSON against its scene and copy it into display rows.
 * @param value - the parsed JSON.
 * @param scene - the scene the file must hold.
 * @returns the animation.
 * @throws SceneAssetError when a field is missing or malformed, the dimensions differ from `scene`, the frame count is not
 *   `fps × durationMs / 1000`, a tone is not a theme tone, a glyph is outside the scene repertoire, or a row is not exactly
 *   `columns` cells wide, or `captions` is present but is not one short printable string per frame.
 */
export function parseSceneAnimation(value: unknown, scene: Scene): SceneAnimation {
  const fail = (problem: string): never => { throw new SceneAssetError(scene.file, problem) }
  if (!isRecord(value)) return fail('the file is not a JSON object')
  const { columns, rows, fps, durationMs, frames, captions } = value
  if (columns !== scene.columns || rows !== scene.rows) {
    return fail(`it declares ${String(columns)}×${String(rows)} cells instead of ${String(scene.columns)}×${String(scene.rows)}`)
  }
  if (!isCount(fps) || !isCount(durationMs)) return fail('fps and durationMs must be positive integers')
  if (!Array.isArray(frames) || frames.length !== fps * durationMs / 1000) return fail(`it must hold ${String(fps * durationMs / 1000)} frames`)
  const parsed = frames.map((frame: unknown, index): Row[] => {
    if (!Array.isArray(frame) || frame.length !== scene.rows) return fail(`frame ${String(index)} does not have ${String(scene.rows)} rows`)
    return frame.map((line: unknown, y): Row => {
      const where = `frame ${String(index)} row ${String(y)}`
      if (!isRecord(line) || !Array.isArray(line.spans)) return fail(`${where} has no spans`)
      let cells = 0
      const spans = line.spans.map((part: unknown): Span => {
        if (!isRecord(part) || typeof part.text !== 'string' || !SCENE_GLYPHS.test(part.text)) return fail(`${where} has a span outside the scene glyphs`)
        if (!isTone(part.tone)) return fail(`${where} has an unknown tone ${JSON.stringify(part.tone)}`)
        cells += part.text.length
        return { text: part.text, tone: part.tone }
      })
      if (cells !== scene.columns) return fail(`${where} is ${String(cells)} cells wide instead of ${String(scene.columns)}`)
      return { spans }
    })
  })
  if (captions === undefined) return { scene, fps, durationMs, frames: parsed, captionColumns: 0 }
  if (!Array.isArray(captions) || captions.length !== parsed.length) return fail('captions must hold one entry per frame')
  const text = captions.map((caption: unknown, index): string => typeof caption === 'string' && CAPTION_TEXT.test(caption)
    ? caption : fail(`caption ${String(index)} is not short printable text`))
  // CAPTION_TEXT admits only single-cell characters, so the UTF-16 length counts cells.
  return { scene, fps, durationMs, frames: parsed, captions: text, captionColumns: Math.max(0, ...text.map(caption => caption.length)) }
}

/**
 * The frame shown after `elapsedMs` of looping playback.
 * @param animation - the animation.
 * @param elapsedMs - non-negative animation time.
 * @returns `floor(elapsedMs × fps / 1000)` wrapped to the frame count.
 */
export function frameIndex(animation: SceneAnimation, elapsedMs: number): number {
  return Math.floor(elapsedMs * animation.fps / 1000) % animation.frames.length
}

/**
 * Owner of the packaged animations one TUI shows. Each asset is read, gunzipped, parsed and validated synchronously the first
 * time a frame of it is needed, then kept for the instance's lifetime. An unusable asset is reported once through `report`
 * and its frames stay empty; nothing is retried.
 */
export class SceneAnimations {
  private readonly loaded = new Map<Scene, SceneAnimation | SceneAssetError>()
  /**
   * @param directory - URL of the directory holding the asset files.
   * @param report - receives each unusable asset once; it runs during rendering, so it must not update rendered state synchronously.
   */
  constructor(private readonly directory: URL, private readonly report: (error: SceneAssetError) => void) {}

  /**
   * The animation of one scene, loading it on first use.
   * @param scene - a scene whose file lives in this instance's directory.
   * @returns the animation, or undefined when its asset is unusable.
   */
  animation(scene: Scene): SceneAnimation | undefined {
    let entry = this.loaded.get(scene)
    if (entry === undefined) {
      entry = this.read(scene)
      this.loaded.set(scene, entry)
      if (entry instanceof SceneAssetError) this.report(entry)
    }
    return entry instanceof SceneAssetError ? undefined : entry
  }

  /**
   * The frame of `scene` shown after `elapsedMs` of looping playback.
   * @param scene - the scene to show.
   * @param elapsedMs - animation time; zero shows the first frame.
   * @returns `scene.rows` rows of exactly `scene.columns` cells, or undefined when the scene's asset is unusable.
   */
  frame(scene: Scene, elapsedMs: number): readonly Row[] | undefined {
    const animation = this.animation(scene)
    return animation === undefined ? undefined : animation.frames[frameIndex(animation, elapsedMs)]
  }

  /**
   * The caption of the frame of `scene` shown after `elapsedMs` of looping playback.
   * @param scene - the scene to show.
   * @param elapsedMs - animation time; zero is the first frame.
   * @returns the caption, empty when the frame has none, or undefined when the scene has no captions or its asset is unusable.
   */
  caption(scene: Scene, elapsedMs: number): string | undefined {
    const animation = this.animation(scene)
    return animation?.captions?.[frameIndex(animation, elapsedMs)]
  }

  /**
   * One frame of `scene` by its index.
   * @param scene - the scene to show.
   * @param index - a frame index, wrapped to the frame count.
   * @returns the frame's rows, or undefined when the scene's asset is unusable.
   */
  still(scene: Scene, index: number): readonly Row[] | undefined {
    const animation = this.animation(scene)
    return animation === undefined ? undefined : animation.frames[index % animation.frames.length]
  }

  private read(scene: Scene): SceneAnimation | SceneAssetError {
    let value: unknown
    try {
      value = JSON.parse(gunzipSync(readFileSync(new URL(scene.file, this.directory))).toString('utf8'))
    } catch (error) {
      return new SceneAssetError(scene.file, 'it cannot be read as gzip JSON', { cause: error })
    }
    try {
      return parseSceneAnimation(value, scene)
    } catch (error) {
      if (error instanceof SceneAssetError) return error
      throw error
    }
  }
}
