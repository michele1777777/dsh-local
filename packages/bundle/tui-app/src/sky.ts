/**
 * Background stars that widen the Thinking scene to the terminal width. The packaged constellation scene is a fixed
 * {@link THINKING_SCENE} block; this module scatters grey stars on both sides of it with the same lifecycle as the stars
 * inside it: they light up at random over the first frames of a figure and go out at random over its last frames.
 */
import { CONSTELLATION_MS, THINKING_SCENE } from './animation.ts'
import { row, span, type Row } from './rich-text.ts'

/** Frames of one constellation at the scene's 10 frames per second. */
const FIGURE_FRAMES = CONSTELLATION_MS / 100
/** Frames over which the stars light up, and the frame from which they go out, as in the packaged scene. */
const LIGHT_FRAMES = 4
const FADE_FRAME = 56
/** Stars sit in blocks of this many cells and rows, at most one per block, so they never clump. */
const BLOCK_COLUMNS = 3
const BLOCK_ROWS = 2
/** Chance that a block holds a star: the packaged scene's density of background stars. */
const STAR_CHANCE = 0.73
/** Braille dot bits by dot row and column inside one cell. */
const DOT_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const

/** A stable number in [0, 1) for a tuple of non-negative integers. */
function chance(...key: number[]): number {
  let hash = 0x9e3779b9
  for (const part of key) {
    hash = Math.imul(hash ^ part, 0x85ebca6b)
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
    hash ^= hash >>> 16
  }
  return (hash >>> 0) / 0x1_0000_0000
}

/**
 * Grey star cells for one side of the scene, `columns` wide, counted outwards from the scene's edge so a star keeps its place
 * relative to the figure when the terminal width changes.
 * @param figure - the constellation, which seeds the stars.
 * @param frame - the frame inside the constellation, 0 to 63.
 * @param side - 0 for the left side, 1 for the right side.
 * @param columns - cells on this side.
 * @returns the braille cells of each scene row, `columns` per row, ordered from the scene's edge outwards.
 */
function sideCells(figure: number, frame: number, side: number, columns: number): string[][] {
  const masks = Array.from({ length: THINKING_SCENE.rows }, () => new Array<number>(columns).fill(0))
  const shown = frame / LIGHT_FRAMES
  const keep = frame >= FADE_FRAME ? 1 - (frame - FADE_FRAME) / (FIGURE_FRAMES - FADE_FRAME) : 2
  for (let block = 0; block * BLOCK_COLUMNS < columns; block++) {
    for (let band = 0; band * BLOCK_ROWS < THINKING_SCENE.rows; band++) {
      if (chance(figure, side, block, band, 0) >= STAR_CHANCE) continue
      if (chance(figure, side, block, band, 3) >= shown || chance(figure, side, block, band, 4) >= keep) continue
      const x = block * BLOCK_COLUMNS * 2 + Math.floor(chance(figure, side, block, band, 1) * BLOCK_COLUMNS * 2)
      const y = band * BLOCK_ROWS * 4 + Math.floor(chance(figure, side, block, band, 2) * BLOCK_ROWS * 4)
      const cell = Math.floor(x / 2), line = Math.floor(y / 4)
      const cells = masks[line]
      if (cells === undefined || cell >= columns) continue
      cells[cell] = (cells[cell] ?? 0) | (DOT_BITS[y % 4]?.[x % 2] ?? 0)
    }
  }
  return masks.map(cells => cells.map(mask => mask === 0 ? ' ' : String.fromCodePoint(0x2800 + mask)))
}

/**
 * The Thinking scene centred in `width` cells, with grey background stars filling both sides.
 * @param scene - the frame's rows, {@link THINKING_SCENE} sized.
 * @param figure - the constellation shown, which seeds the side stars.
 * @param frame - the frame inside the constellation; motion off passes the still frame.
 * @param width - cells to fill; at least the scene's width.
 * @returns the scene's rows, each exactly `width` cells.
 */
export function widenSky(scene: readonly Row[], figure: number, frame: number, width: number): Row[] {
  const left = Math.max(0, Math.floor((width - THINKING_SCENE.columns) / 2))
  const right = Math.max(0, width - THINKING_SCENE.columns - left)
  const before = sideCells(figure, frame, 0, left).map(cells => cells.reverse().join(''))
  const after = sideCells(figure, frame, 1, right).map(cells => cells.join(''))
  return scene.map((part, index) => row(span(before[index] ?? '', 'muted'), ...part.spans, span(after[index] ?? '', 'muted')))
}
