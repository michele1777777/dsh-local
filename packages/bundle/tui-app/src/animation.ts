/**
 * Pre-rendered scene animations: the packaged asset format, its validation, size selection and frame timing.
 *
 * Each variant is a gzip JSON file rendered outside the TUI: `frames` holds `fps × durationMs / 1000` frames of `rows` rows,
 * each row a list of `{ text, tone }` spans covering exactly `columns` cells with one theme tone per cell. Glyphs are spaces,
 * block elements and braille patterns, one cell each. A variant is drawn for a terminal four columns wider than its scene.
 * @module @deepseek-ai/dsh-tui-app/animation
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { span, type Row, type Span } from './rich-text.ts'
import { palette, type Tone } from './theme.ts'

/** Milliseconds between steps of the shared animation tick. */
export const ANIMATION_TICK_MS = 100

/** Columns a variant needs beyond its scene: each was drawn for a terminal four columns wider than the scene. */
export const SCENE_FRAME_COLUMNS = 4

/** A packaged animation file and the scene size it must declare. */
export interface SceneVariant {
  /** File name inside the asset directory. */
  readonly file: string
  /** Scene width in terminal cells. */
  readonly columns: number
  /** Scene height in terminal rows. */
  readonly rows: number
}

/** Cells a scene may cover. */
export interface SceneSpace {
  /** Most columns the scene may take. */
  readonly columns: number
  /** Most rows the scene may take. */
  readonly rows: number
}

/**
 * The largest variant whose scene fits.
 * @param variants - candidates, largest first.
 * @param space - the columns and rows available.
 * @returns the first of `variants` no wider and no taller than `space`, or undefined when none fits.
 */
export function fitSceneVariant<V extends SceneVariant>(variants: readonly V[], space: SceneSpace): V | undefined {
  return variants.find(variant => variant.columns <= space.columns && variant.rows <= space.rows)
}

/** A validated animation: `frames[i]` holds `variant.rows` rows of exactly `variant.columns` cells. */
export interface SceneAnimation {
  /** The variant the file declared and was checked against. */
  readonly variant: SceneVariant
  /** Frames per second of animation time. */
  readonly fps: number
  /** Length of one cycle in milliseconds. */
  readonly durationMs: number
  /** Every frame in playback order; rows and spans are shared and must not be mutated. */
  readonly frames: readonly (readonly Row[])[]
}

/** An unusable scene asset: unreadable, not gzip JSON, or not the declared animation. */
export class SceneAssetError extends Error {
  /**
   * @param subject - what the animation shows, capitalised, such as `Whale`.
   * @param file - the asset file name.
   * @param problem - what is wrong with it.
   * @param options - the underlying failure, when there is one.
   */
  constructor(readonly subject: string, readonly file: string, readonly problem: string, options?: ErrorOptions) {
    super(`${subject} animation ${file} is unusable: ${problem}. The TUI shows no animation in its place; reinstall @deepseek-ai/dsh-tui-app to restore it.`, options)
    this.name = 'SceneAssetError'
  }
}

/** Builds the error that reports one unusable file of a scene set. */
export type SceneFailure = (file: string, problem: string, options?: ErrorOptions) => SceneAssetError

/** One cell per code point: spaces, block elements and braille patterns. */
const SCENE_GLYPHS = /^[ ▀-▟⠀-⣿]+$/u

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTone = (value: unknown): value is Tone => typeof value === 'string' && Object.hasOwn(palette('dark'), value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

/**
 * Check parsed asset JSON against its variant and copy it into display rows.
 * @param value - the parsed JSON.
 * @param variant - the variant the file must hold.
 * @param failure - builds the error naming the file.
 * @returns the animation.
 * @throws SceneAssetError, built by `failure`, when a field is missing or malformed, the dimensions differ from `variant`, the
 *   frame count is not `fps × durationMs / 1000`, a tone is not a theme tone, a glyph is outside the scene repertoire, or a
 *   row is not exactly `columns` cells wide.
 */
export function parseSceneAnimation(value: unknown, variant: SceneVariant, failure: SceneFailure): SceneAnimation {
  const fail = (problem: string): never => { throw failure(variant.file, problem) }
  if (!isRecord(value)) return fail('the file is not a JSON object')
  const { columns, rows, fps, durationMs, frames } = value
  if (columns !== variant.columns || rows !== variant.rows) {
    return fail(`it declares ${String(columns)}×${String(rows)} cells instead of ${String(variant.columns)}×${String(variant.rows)}`)
  }
  if (!isCount(fps) || !isCount(durationMs)) return fail('fps and durationMs must be positive integers')
  if (!Array.isArray(frames) || frames.length !== fps * durationMs / 1000) return fail(`it must hold ${String(fps * durationMs / 1000)} frames`)
  const parsed = frames.map((frame: unknown, index): Row[] => {
    if (!Array.isArray(frame) || frame.length !== variant.rows) return fail(`frame ${String(index)} does not have ${String(variant.rows)} rows`)
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
      if (cells !== variant.columns) return fail(`${where} is ${String(cells)} cells wide instead of ${String(variant.columns)}`)
      return { spans }
    })
  })
  return { variant, fps, durationMs, frames: parsed }
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
 * Rows exactly `width` cells wide with one frame centred; the odd spare column goes to the right.
 * @param frame - rows of one frame, each `columns` cells wide.
 * @param columns - the frame's width; at most `width`.
 * @param width - the width of every returned row.
 * @returns the padded rows.
 */
export function centreScene(frame: readonly Row[], columns: number, width: number): Row[] {
  const left = Math.floor((width - columns) / 2), right = width - columns - left
  return frame.map(line => ({
    spans: [...left > 0 ? [span(' '.repeat(left))] : [], ...line.spans, ...right > 0 ? [span(' '.repeat(right))] : []],
  }))
}

/**
 * Owner of one set of packaged scene animations. Each asset is read, gunzipped, parsed and validated synchronously the first
 * time a scene needs it, then kept for the instance's lifetime. An unusable asset is reported once through `report` and its
 * scenes stay empty; nothing is retried.
 */
export class SceneAnimations {
  private readonly loaded = new Map<SceneVariant, SceneAnimation | SceneAssetError>()
  /**
   * @param directory - URL of the directory holding the variant files.
   * @param failure - builds the error for an unusable file.
   * @param report - receives each unusable asset once; it runs during rendering, so it must not update rendered state synchronously.
   */
  constructor(
    private readonly directory: URL,
    private readonly failure: SceneFailure,
    private readonly report: (error: SceneAssetError) => void,
  ) {}

  /**
   * The animation of one variant, loading it on first use.
   * @param variant - a variant whose file lives in this instance's directory.
   * @returns the animation, or undefined when its asset is unusable.
   */
  animation(variant: SceneVariant): SceneAnimation | undefined {
    let entry = this.loaded.get(variant)
    if (entry === undefined) {
      entry = this.read(variant)
      this.loaded.set(variant, entry)
      if (entry instanceof SceneAssetError) this.report(entry)
    }
    return entry instanceof SceneAssetError ? undefined : entry
  }

  /**
   * The frame of `variant` at `elapsedMs`, centred in rows exactly `width` cells wide.
   * @param variant - the variant to show; at most `width` columns wide.
   * @param width - the width of every returned row.
   * @param elapsedMs - animation time; zero shows the first frame.
   * @returns the scene rows, or undefined when the variant's asset is unusable.
   */
  protected frame(variant: SceneVariant, width: number, elapsedMs: number): Row[] | undefined {
    const animation = this.animation(variant)
    if (animation === undefined) return undefined
    return centreScene(animation.frames[frameIndex(animation, elapsedMs)] ?? [], variant.columns, width)
  }

  private read(variant: SceneVariant): SceneAnimation | SceneAssetError {
    let value: unknown
    try {
      value = JSON.parse(gunzipSync(readFileSync(new URL(variant.file, this.directory))).toString('utf8'))
    } catch (error) {
      return this.failure(variant.file, 'it cannot be read as gzip JSON', { cause: error })
    }
    try {
      return parseSceneAnimation(value, variant, this.failure)
    } catch (error) {
      if (error instanceof SceneAssetError) return error
      throw error
    }
  }
}
