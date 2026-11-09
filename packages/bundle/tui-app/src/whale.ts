/**
 * Pre-rendered whale animations for the welcome screen and the live Thinking box, in the asset format of `animation.ts`.
 * @module @deepseek-ai/dsh-tui-app/whale
 */
import type { Row } from './rich-text.ts'
import { fitSceneVariant, SceneAnimations, SceneAssetError, parseSceneAnimation, type SceneAnimation, type SceneSpace, type SceneVariant } from './animation.ts'

/** The packaged whale assets: `assets/whale/` beside `src/` in a checkout and beside `lib/` in a build. */
export const WHALE_ASSETS = new URL('../assets/whale/', import.meta.url)

/** Every packaged variant, largest first: the dense K scene, then the L scenes drawn for 120, 100, 80 and 60 columns. */
export const WHALE_VARIANTS: readonly SceneVariant[] = [
  { file: 'k228.json.gz', columns: 228, rows: 21 },
  { file: 'l120.json.gz', columns: 116, rows: 12 },
  { file: 'l100.json.gz', columns: 96, rows: 12 },
  { file: 'l80.json.gz', columns: 76, rows: 10 },
  { file: 'l60.json.gz', columns: 56, rows: 8 },
]

/**
 * The largest whale variant whose scene fits.
 * @param space - the columns and rows available.
 * @returns the first of {@link WHALE_VARIANTS} no wider and no taller than `space`, or undefined when none fits.
 */
export function fitVariant(space: SceneSpace): SceneVariant | undefined {
  return fitSceneVariant(WHALE_VARIANTS, space)
}

/** An unusable whale asset: unreadable, not gzip JSON, or not the declared animation. */
export class WhaleAssetError extends SceneAssetError {
  /**
   * @param file - the asset file name.
   * @param problem - what is wrong with it.
   * @param options - the underlying failure, when there is one.
   */
  constructor(file: string, problem: string, options?: ErrorOptions) {
    super('Whale', file, problem, options)
    this.name = 'WhaleAssetError'
  }
}

const whaleFailure = (file: string, problem: string, options?: ErrorOptions): WhaleAssetError => new WhaleAssetError(file, problem, options)

/**
 * Check parsed whale asset JSON against its variant and copy it into display rows.
 * @param value - the parsed JSON.
 * @param variant - the variant the file must hold.
 * @returns the animation.
 * @throws WhaleAssetError under the conditions of {@link parseSceneAnimation}.
 */
export function parseWhaleAnimation(value: unknown, variant: SceneVariant): SceneAnimation {
  return parseSceneAnimation(value, variant, whaleFailure)
}

/** Owner of the whale animations one TUI shows, loaded and validated lazily as {@link SceneAnimations} describes. */
export class WhaleAnimations extends SceneAnimations {
  /**
   * @param directory - URL of the directory holding the variant files.
   * @param report - receives each unusable asset once; it runs during rendering, so it must not update rendered state synchronously.
   */
  constructor(directory: URL, report: (error: SceneAssetError) => void) {
    super(directory, whaleFailure, report)
  }

  /**
   * The current frame of the largest variant that fits, centred in rows exactly `width` cells wide.
   * @param space - the columns and rows the scene may take; the scene is also never wider than `width`.
   * @param width - the width of every returned row.
   * @param elapsedMs - animation time; zero shows the first frame.
   * @returns the scene rows, or undefined when no variant fits or the fitting variant's asset is unusable.
   */
  scene(space: SceneSpace, width: number, elapsedMs: number): Row[] | undefined {
    const variant = fitVariant({ columns: Math.min(space.columns, width), rows: space.rows })
    return variant === undefined ? undefined : this.frame(variant, width, elapsedMs)
  }
}
