/**
 * The mantis shown while `laya_context_pruner` runs: pre-rendered scenes for the live box (in the asset format of
 * `animation.ts`) and the twelve-cell mark beside the status label. The ribbon of characters the mantis cuts is decoration;
 * it carries no digits and does not follow the pass's real progress.
 * @module @deepseek-ai/dsh-tui-app/laya
 */
import type { LayaPhase } from '@deepseek-ai/dsh-compaction-laya-pruner'
import { fitSceneVariant, SceneAnimations, SceneAssetError, parseSceneAnimation, type SceneAnimation, type SceneSpace, type SceneVariant } from './animation.ts'
import { span, type Row, type Span } from './rich-text.ts'

/** The packaged mantis assets: `assets/laya/` beside `src/` in a checkout and beside `lib/` in a build. */
export const LAYA_ASSETS = new URL('../assets/laya/', import.meta.url)

/** One cutting gesture of the mantis, in milliseconds of local animation time. */
export const LAYA_GESTURE_MS = 800
/** Local time within a gesture at which the blades close. */
export const LAYA_CUT_MS = 180

/** Looping cutting scenes for the prune phase, largest first: drawn for 80 and 60 terminal columns. */
export const LAYA_CUT_VARIANTS: readonly SceneVariant[] = [
  { file: 'cut76.json.gz', columns: 76, rows: 11 },
  { file: 'cut56.json.gz', columns: 56, rows: 11 },
]

/** One-frame ready scenes for the managed phases, with the same sizes as {@link LAYA_CUT_VARIANTS}. */
export const LAYA_READY_VARIANTS: readonly SceneVariant[] = [
  { file: 'ready76.json.gz', columns: 76, rows: 11 },
  { file: 'ready56.json.gz', columns: 56, rows: 11 },
]

/**
 * Whether a pass in this phase is cutting. A pass without phase reports cuts from its start; release, start, stop and
 * restore manage the model and show the mantis ready.
 * @param phase - the pass's latest reported phase.
 * @returns true for `prune` and for no phase.
 */
export function layaCutting(phase: LayaPhase | undefined): boolean {
  return phase === undefined || phase === 'prune'
}

/** An unusable mantis asset: unreadable, not gzip JSON, or not the declared animation. */
export class LayaAssetError extends SceneAssetError {
  /**
   * @param file - the asset file name.
   * @param problem - what is wrong with it.
   * @param options - the underlying failure, when there is one.
   */
  constructor(file: string, problem: string, options?: ErrorOptions) {
    super('Laya', file, problem, options)
    this.name = 'LayaAssetError'
  }
}

const layaFailure = (file: string, problem: string, options?: ErrorOptions): LayaAssetError => new LayaAssetError(file, problem, options)

/**
 * Check parsed mantis asset JSON against its variant and copy it into display rows.
 * @param value - the parsed JSON.
 * @param variant - the variant the file must hold.
 * @returns the animation.
 * @throws LayaAssetError under the conditions of {@link parseSceneAnimation}.
 */
export function parseLayaAnimation(value: unknown, variant: SceneVariant): SceneAnimation {
  return parseSceneAnimation(value, variant, layaFailure)
}

/** Owner of the mantis scenes one TUI shows, loaded and validated lazily as {@link SceneAnimations} describes. */
export class LayaAnimations extends SceneAnimations {
  /**
   * @param directory - URL of the directory holding the variant files.
   * @param report - receives each unusable asset once; it runs during rendering, so it must not update rendered state synchronously.
   */
  constructor(directory: URL, report: (error: SceneAssetError) => void) {
    super(directory, layaFailure, report)
  }

  /**
   * The mantis scene of the largest size that fits, centred in rows exactly `width` cells wide.
   * @param cutting - show the cutting loop; otherwise the ready still.
   * @param space - the columns and rows the scene may take; the scene is also never wider than `width`.
   * @param width - the width of every returned row.
   * @param elapsedMs - local cutting time; ignored by the ready still.
   * @returns the scene rows, or undefined when no size fits or the fitting asset is unusable.
   */
  scene(cutting: boolean, space: SceneSpace, width: number, elapsedMs: number): Row[] | undefined {
    const variants = cutting ? LAYA_CUT_VARIANTS : LAYA_READY_VARIANTS
    const variant = fitSceneVariant(variants, { columns: Math.min(space.columns, width), rows: space.rows })
    return variant === undefined ? undefined : this.frame(variant, width, cutting ? elapsedMs : 0)
  }
}

const BRAILLE_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const
// Dot coordinates on the mark's 24×4 braille grid.
const MARK_BODY: readonly (readonly [number, number])[] = [
  [6, 0], [10, 0], [7, 1], [8, 1], [9, 1], [8, 2], [7, 3], [9, 3], [6, 2], [5, 2], [4, 2], [3, 2], [2, 2], [2, 3], [5, 3],
]
const MARK_CLOSED: readonly (readonly [number, number])[] = [[10, 2], [11, 2], [12, 2], [13, 2], [14, 2]]
const MARK_OPEN: readonly (readonly [number, number])[] = [[10, 1], [11, 0], [12, 0], [13, 0], [10, 2], [11, 3], [12, 3], [13, 3]]

/**
 * The twelve-cell, one-row mantis mark: body and forelegs in the success tone, two dashed ribbon lines in the text tone that
 * move toward the blades every 70 ms while cutting. The blades are closed from {@link LAYA_CUT_MS} to the end of each
 * gesture and open otherwise.
 * @param cutting - whether the pass is cutting; a ready mantis holds its blades open and its ribbon still.
 * @param elapsedMs - local cutting time; zero holds the open pose.
 * @returns twelve braille cells.
 */
export function layaMark(cutting: boolean, elapsedMs: number): Span[] {
  const local = cutting ? elapsedMs % LAYA_GESTURE_MS : 0
  const closed = cutting && local >= LAYA_CUT_MS
  const dots = new Uint8Array(96)
  const point = (x: number, y: number, id: number): void => { if (x >= 0 && x < 24 && y >= 0 && y < 4) dots[y * 24 + x] = id }
  for (const [x, y] of [...MARK_BODY, ...closed ? MARK_CLOSED : MARK_OPEN]) point(x, y, 1)
  const travel = Math.floor(local / 70)
  for (let x = 16; x < 24; x++) {
    if ((x + travel) % 5 !== 0) point(x, closed ? 0 : 1, 2)
    if ((x + travel) % 4 !== 0) point(x, closed ? 3 : 2, 2)
  }
  const cells: Span[] = []
  for (let cell = 0; cell < 12; cell++) {
    let bits = 0, body = 0, ribbon = 0
    for (const [y, line] of BRAILLE_BITS.entries()) for (const [dx, bit] of line.entries()) {
      const id = dots[y * 24 + cell * 2 + dx]
      if (id === 1) body++
      else if (id === 2) ribbon++
      else continue
      bits |= bit
    }
    // A braille cell takes one colour: the body wins a tie, as in the reference renderer.
    cells.push(span(bits === 0 ? ' ' : String.fromCodePoint(0x2800 + bits), ribbon > body ? 'text' : 'success'))
  }
  return cells
}
