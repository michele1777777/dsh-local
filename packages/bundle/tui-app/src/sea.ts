/**
 * The sea inside a live Thinking box: a whale drawn from a small 3D model in 2:1 dimetric projection, rendered in
 * braille dots with one tone per cell.
 *
 * The camera is orthographic at 45° azimuth and 30° elevation, so ground directions draw as 2:1 lines and a circle
 * on the water draws as a 2:1 ellipse. Screen dots: u = X − Y to the right, v = (X + Y) / 2 − HZ · Z downward.
 * The whale faces left and a little toward the viewer and travels along the screen's horizontal. Its body is brand
 * blue with a white belly band along the underside and an eye; thin light-blue glints run along the back.
 * @module @deepseek-ai/dsh-tui-app/sea
 */
import { row, span, type Row, type Span } from './rich-text.ts'
import type { Tone } from './theme.ts'

/** Terminal rows the scene occupies. */
export const SEA_ROWS = 7
/** Narrowest scene, in cells, with room for the whale to swim; narrower boxes keep the small side-view whale. */
export const SEA_MIN_CELLS = 26

type Vec3 = readonly [number, number, number]

/** Dots per world unit of height on screen. */
const HZ = Math.cos(Math.PI / 6) * Math.SQRT2
/** Unit vector toward the camera, for depth order and back-face culling. */
const VIEW: Vec3 = [Math.cos(Math.PI / 6) / Math.SQRT2, Math.cos(Math.PI / 6) / Math.SQRT2, 0.5]
const unit = (v: Vec3): Vec3 => { const n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n] }
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Body length, largest radius and fluke length in world units, and the height the whale rides above the water. */
const LENGTH = 17.6, RADIUS = 3.2, FLUKE = 0.2 * LENGTH, RIDE = 0.95 * RADIUS
/** Snout heading in the ground plane: halfway between the screen's left and a 2:1 diagonal toward the viewer. */
const HEADING = 112.5 * Math.PI / 180
const SNOUT = [Math.cos(HEADING), Math.sin(HEADING)] as const
const NEAR = [SNOUT[1], -SNOUT[0]] as const
/** Angle round the body of the eye, on the near side above the midline. */
const EYE_ANGLE = 0.6
/** Fraction of the scene height where the swimming line meets the water, and dots kept clear at the sides. */
const GROUND = 0.56, MARGIN = 40

/** Surface parts; the belly band and glints read them per dot. */
const Part = { None: 0, Body: 1, Belly: 2, Fluke: 3, Fin: 4, Eye: 5 } as const
type Part = typeof Part[keyof typeof Part]

/** Body radius from the tail stalk (t = 0) to the snout (t = 1). */
function radius(t: number): number {
  if (t > 0.72) return RADIUS * Math.sqrt(Math.max(0, 1 - ((t - 0.72) / 0.28) ** 2))
  if (t > 0.42) return RADIUS
  return RADIUS * (0.2 + 0.8 * (t / 0.42) ** 1.25)
}

/** The body and fins in the whale's own axes (a toward the snout, b toward the near side, c up), sampled once. */
interface Model {
  a: Float64Array
  b: Float64Array
  c: Float64Array
  na: Float64Array
  nb: Float64Array
  nc: Float64Array
  part: readonly Part[]
}

function buildModel(): Model {
  const samples: [number, number, number, number, number, number, Part][] = []
  for (let t = 0; t <= 1; t += 0.006) {
    const r = radius(t), a = (t - 0.5) * LENGTH
    for (let f = 0; f < Math.PI * 2; f += 0.045) {
      const n = unit([0, Math.cos(f), Math.sin(f) / 0.82])
      // The belly: the underside and the lower near flank, from behind the head to mid-body.
      const belly = t > 0.42 && t < 0.78 && Math.sin(f) < 0.45 && (Math.cos(f) > 0 || Math.sin(f) < -0.5)
      samples.push([a, r * Math.cos(f), 0.82 * r * Math.sin(f), n[0], n[1], n[2], belly ? Part.Belly : Part.Body])
    }
  }
  // Pectoral fins, swept back and slightly down from high on the flanks, clear of the belly band.
  for (const side of [-1, 1]) {
    const n = unit([0, side * 0.3, 1])
    for (let k = 0; k <= 1; k += 0.05) {
      for (let w = 0; w <= 1; w += 0.12) {
        const a = 0.1 * LENGTH - k * 2.6 - w * 1.2, b = side * (RADIUS * 0.95 + k * 2.2), c = -0.15 * RADIUS - k * 0.7
        samples.push([a, b, c, n[0], n[1], n[2], Part.Fin])
      }
    }
  }
  const column = (index: number): Float64Array => Float64Array.from(samples, sample => sample[index] ?? 0)
  return { a: column(0), b: column(1), c: column(2), na: column(3), nb: column(4), nc: column(5), part: samples.map(sample => sample[6]) }
}
const MODEL = buildModel()

const ease = (t: number): number => t * t * (3 - 2 * t)

/**
 * Values through keyframes on a smooth curve: cubic Hermite with tangents from the neighbouring keys, so speed
 * carries through every key and the motion rests only at the first and last.
 */
function keyed(keys: readonly (readonly [number, number, number])[], at: number): [number, number] {
  const first = keys[0], last = keys.at(-1)
  if (first === undefined || last === undefined) return [0, 0]
  if (at <= first[0]) return [first[1], first[2]]
  if (at >= last[0]) return [last[1], last[2]]
  const k = keys.findIndex(([when]) => when > at) - 1
  const from = keys[k], to = keys[k + 1]
  if (from === undefined || to === undefined) return [last[1], last[2]]
  const h = to[0] - from[0], u = (at - from[0]) / h
  const tangent = (index: number, value: 1 | 2): number => {
    const before = keys[index - 1], after = keys[index + 1]
    return before === undefined || after === undefined ? 0 : (after[value] - before[value]) / (after[0] - before[0])
  }
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2
  const value = (index: 1 | 2): number =>
    h00 * from[index] + h10 * h * tangent(k, index) + h01 * to[index] + h11 * h * tangent(k + 1, index)
  return [value(1), value(2)]
}

/** Height and nose-up pitch (degrees) through a breach: a dip for speed, the arc, the fall and a short plunge. */
const BREACH: readonly (readonly [number, number, number])[] = [
  [0, RIDE, 0], [6, -2, -8], [11, 3, 38], [16, 9.5, 20], [21, 3.5, -25], [25, -0.5, -8], [32, RIDE, 0],
]
const DIVE: readonly (readonly [number, number, number])[] = [[0, RIDE, 0], [5, RIDE, -12], [11, -2, -48], [18, -12, -60]]
const RISE: readonly (readonly [number, number, number])[] = [[0, -12, 18], [9, RIDE + 0.4, 6], [12, RIDE, 0]]

/** The whale at one tick, with the cycle marks of its spout and splashes. */
interface Pose {
  name: 'still' | 'float' | 'swim' | 'breach' | 'dive' | 'under' | 'rise'
  s: number
  z: number
  pitch: number
  beat: number
  cycle: number
  phase: number
  spout: number
  takeoff: number
  impact: number
  plunge: number
}

/**
 * One cycle: float and blow at the right edge, swim left to the middle, breach there, swim on to the left edge,
 * dive with the flukes lifting, pass back under water out of sight, and rise again at the right edge.
 * @param tick - animation tick.
 * @param span - world units the whale travels along its line.
 */
function pose(tick: number, span: number): Pose {
  const right = span / 2, left = -span / 2
  const parts = [['float', 16], ['swim1', Math.round(right * 1.6)], ['breach', 32], ['swim2', Math.round(-left * 1.6)],
    ['dive', 18], ['under', Math.max(12, Math.round(span))], ['rise', 12]] as const
  const start: Record<string, number> = {}
  let cycle = 0
  for (const [name, length] of parts) { start[name] = cycle; cycle += length }
  const at = (name: string): number => start[name] ?? 0
  const phase = tick % cycle
  const local = (name: string, length: number): number => (phase - at(name)) / length
  // One fluke rhythm through every phase, so the stroke never skips at a phase change.
  const base = { cycle, phase, beat: tick * 0.45, spout: at('float') + 3, takeoff: at('breach') + 10, impact: at('breach') + 21, plunge: at('dive') + 11 }
  const degrees = (value: number): number => value * Math.PI / 180
  if (phase < at('swim1')) return { ...base, name: 'float', s: right, z: RIDE, pitch: 0 }
  if (phase < at('breach')) return { ...base, name: 'swim', s: right * (1 - ease(local('swim1', parts[1][1]))), z: RIDE, pitch: 0 }
  if (phase < at('swim2')) { const [z, pitch] = keyed(BREACH, phase - at('breach')); return { ...base, name: 'breach', s: 0, z, pitch: degrees(pitch) } }
  if (phase < at('dive')) return { ...base, name: 'swim', s: left * ease(local('swim2', parts[3][1])), z: RIDE, pitch: 0 }
  if (phase < at('under')) {
    const [z, pitch] = keyed(DIVE, phase - at('dive'))
    return { ...base, name: 'dive', s: left - 3 * local('dive', 18), z, pitch: degrees(pitch) }
  }
  if (phase < at('rise')) return { ...base, name: 'under', s: left + (right - left) * local('under', parts[5][1]), z: -14, pitch: 0 }
  const [z, pitch] = keyed(RISE, phase - at('rise'))
  return { ...base, name: 'rise', s: right, z, pitch: degrees(pitch) }
}

/** Water height at a ground point. */
const water = (x: number, y: number, tick: number): number =>
  0.18 * Math.sin(0.5 * x - 0.11 * tick) + 0.14 * Math.sin(0.43 * y + 0.08 * tick)

/** Deterministic hash in [0, 1). */
function hash(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return value - Math.floor(value)
}

const BRAILLE = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const
/** Braille bits of a cell's bottom dot row: the one-dot glint line drawn above a full back cell. */
const BOTTOM_ROW = 0x40 | 0x80
const NEIGHBOURS_4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
const NEIGHBOURS_8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const

/** What a whale cell holds, for its tone and the belly band and glints. */
interface Cell { any: boolean; eye: boolean; belly: boolean; white: boolean; skin: boolean; thin: boolean; reachesTop: boolean }

/**
 * The sea scene inside the latest live Thinking box. Frame 0 is the still pose: the whale floats in the middle of
 * a calm sea.
 * @param tick - shared 100 ms animation tick.
 * @param cells - terminal cells the scene spans; at least {@link SEA_MIN_CELLS}.
 * @returns {@link SEA_ROWS} rows of `cells` terminal cells; every frame has the same footprint.
 */
export function thinkingSea(tick: number, cells: number): Row[] {
  const W = Math.max(SEA_MIN_CELLS, cells) * 2, H = SEA_ROWS * 4
  const ground = H * GROUND
  // The swimming line sits on whole cell rows, one fixed offset for every phase, so the belly band holds its cells.
  const swimRow = ground - HZ * RIDE
  const lift = Math.round(swimRow / 4) * 4 - swimRow
  const project = (x: number, y: number, z: number): [number, number] => [W / 2 + (x - y), ground + lift + (x + y) / 2 - HZ * z]
  const live = tick > 0
  const p: Pose = live ? pose(tick, Math.max(0, (W - MARGIN) / Math.SQRT2))
    : { name: 'still', s: 0, z: RIDE, pitch: 0, beat: 0, cycle: 1, phase: 0, spout: -99, takeoff: -99, impact: -99, plunge: -99 }

  // Whale axes in the world: the snout heading, the near side, and up, tilted by the pitch.
  const ca = Math.cos(p.pitch), sa = Math.sin(p.pitch)
  const cx = Math.SQRT1_2 * p.s, cy = -Math.SQRT1_2 * p.s
  const world = (a: number, b: number, c: number): Vec3 => {
    const a2 = a * ca - c * sa, c2 = c * ca + a * sa
    return [cx + SNOUT[0] * a2 + NEAR[0] * b, cy + SNOUT[1] * a2 + NEAR[1] * b, p.z + c2]
  }
  const turn = (na: number, nb: number, nc: number): Vec3 => {
    const a2 = na * ca - nc * sa, c2 = nc * ca + na * sa
    return [SNOUT[0] * a2 + NEAR[0] * nb, SNOUT[1] * a2 + NEAR[1] * nb, c2]
  }

  const depth = new Float64Array(W * H).fill(-Infinity)
  const whale = new Uint8Array(W * H)
  const spray: (Tone | undefined)[] = new Array<Tone | undefined>(W * H)
  const splat = (at: Vec3, normal: Vec3, part: Part): void => {
    const [u, v] = project(at[0], at[1], at[2])
    const x = Math.round(u), y = Math.round(v)
    if (x < 0 || x >= W || y < 0 || y >= H || dot3(normal, VIEW) < -0.15) return
    const i = y * W + x, d = dot3(at, VIEW)
    if (d <= (depth[i] ?? 0)) return
    depth[i] = d
    // Below the surface the whale is hidden.
    whale[i] = at[2] < water(at[0], at[1], tick) ? Part.None : part
  }
  const m = MODEL
  for (let k = 0; k < m.part.length; k += 1) {
    splat(world(m.a[k] ?? 0, m.b[k] ?? 0, m.c[k] ?? 0), turn(m.na[k] ?? 0, m.nb[k] ?? 0, m.nc[k] ?? 0), m.part[k] ?? Part.Body)
  }
  // Horizontal flukes behind the stalk, bending with the stroke.
  const stalk = -0.5 * LENGTH
  const flukeNormal = unit(turn(-0.3 * Math.cos(p.beat), 0, 1))
  for (let k = 0; k <= 1; k += 0.03) {
    const half = RADIUS * (0.3 + 1.15 * k ** 0.7), notch = k > 0.78 ? (k - 0.78) / 0.22 * half * 0.55 : 0
    for (let b = -half; b <= half; b += 0.16) {
      const bend = 1.6 * Math.sin(p.beat) * k + 0.15 * Math.abs(b) * k
      if (Math.abs(b) >= notch) splat(world(stalk - k * FLUKE, b, bend), flukeNormal, Part.Fluke)
    }
  }
  // Close single-dot holes the sampling leaves, then drop stray dots that touch no other body dot.
  const filled = whale.slice()
  for (let y = 1; y < H - 1; y += 1) for (let x = 1; x < W - 1; x += 1) {
    const i = y * W + x
    if (whale[i] !== Part.None) continue
    const around = NEIGHBOURS_4.map(([dx, dy]) => whale[i + dx + dy * W] ?? Part.None).filter(part => part !== Part.None)
    if (around.length >= 3) filled[i] = around.includes(Part.Body) ? Part.Body : around[0] ?? Part.Body
  }
  whale.set(filled)
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const i = y * W + x
    if (whale[i] === Part.None) continue
    const inside = (dx: number, dy: number): boolean => x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < H
    const touching = NEIGHBOURS_8.some(([dx, dy]) => inside(dx, dy) && whale[(y + dy) * W + x + dx] !== Part.None)
    if (!touching) whale[i] = Part.None
  }
  // The eye: a one-dot gap where the eye point is the visible surface.
  {
    const er = radius(0.84)
    const at = world(0.34 * LENGTH, er * Math.cos(EYE_ANGLE), 0.82 * er * Math.sin(EYE_ANGLE))
    const [u, v] = project(at[0], at[1], at[2])
    const x = Math.round(u), y = Math.round(v), i = y * W + x
    const facing = dot3(turn(0, Math.cos(EYE_ANGLE), Math.sin(EYE_ANGLE) / 0.82), VIEW) > 0
    const seen = x >= 0 && x < W && y >= 0 && y < H && whale[i] !== Part.None && Math.abs((depth[i] ?? 0) - dot3(at, VIEW)) < 1.2
    if (facing && seen) whale[i] = Part.Eye
  }

  // Water effects never draw over the whale.
  const put = (u: number, v: number, tone: Tone): void => {
    const x = Math.round(u), y = Math.round(v)
    if (x < 0 || x >= W || y < 0 || y >= H) return
    const i = y * W + x
    if (whale[i] === Part.None && spray[i] === undefined) spray[i] = tone
  }
  const since = (mark: number): number => (p.phase - mark + p.cycle) % p.cycle
  // The whale's shadow straight below it on the water while it is in the air.
  if (p.z > RIDE + 1.5) {
    for (let k = 0; k < m.part.length; k += 3) {
      const at = world(m.a[k] ?? 0, m.b[k] ?? 0, m.c[k] ?? 0)
      const [u, v] = project(at[0], at[1], 0)
      if (Math.round(u) % 2 === 0 && Math.round(v) % 2 === 0) put(u, v, 'comment')
    }
  }
  // Spout: a column from the blowhole that opens into drops.
  if (live && p.name === 'float' && since(p.spout) < 12) {
    const age = since(p.spout), [bx, by, bz] = world(0.3 * LENGTH, 0, 0.82 * RADIUS)
    for (let h = 0; h < Math.min(6, age * 1.2); h += 0.6) put(...project(bx, by, bz + h), 'command')
    if (age > 5) {
      for (const side of [-1, 1]) for (let k = 0; k < 3; k += 1) {
        put(...project(bx + side * (1 + k), by - side * (1 + k), bz + 6 - (age - 5) * 0.5 - k * 0.6), k === 0 ? 'text' : 'command')
      }
    }
  }
  const scale = LENGTH / 22
  // Rings on the water, which this projection draws as 2:1 ellipses.
  const ring = (x0: number, y0: number, age: number, strength: number): void => {
    for (let k = 0; k < 2; k += 1) {
      const rho = (7 + age * 1.5 - k * 3) * scale * 1.6
      if (rho <= 1.6) continue
      for (let f = 0; f < Math.PI * 2; f += 0.05) {
        if (hash(Math.round(f * 20), k) >= 0.25 * (age / 12)) put(...project(x0 + rho * Math.cos(f), y0 + rho * Math.sin(f), 0), age < 5 * strength ? 'text' : 'muted')
      }
    }
  }
  // A crown of water rising round the body where it lands, foam on top.
  const crown = (x0: number, y0: number, age: number): void => {
    const height = (4.5 - Math.abs(age - 3) * 1.1) * scale
    for (let f = 0; f < Math.PI * 2 && height > 0; f += 0.16) {
      const rho = (9 + age * 0.9) * scale * 1.3
      for (let z = 0; z <= height; z += 0.5) put(...project(x0 + rho * Math.cos(f), y0 + rho * Math.sin(f), z), z + 0.5 > height ? 'text' : 'command')
    }
  }
  // Drops thrown up around a landing point.
  const drops = (x0: number, y0: number, age: number, strength: number): void => {
    for (let k = 0; k < 26; k += 1) {
      const angle = k * 2.399, z = (1.4 + hash(k, 7) * 1.6) * strength * age - 0.22 * age * age
      const reach = (5 + (0.7 + hash(k, 3) * 0.8) * strength * age) * scale
      if (z > 0) put(...project(x0 + reach * Math.cos(angle), y0 + reach * Math.sin(angle), z), k % 4 === 0 ? 'text' : 'command')
    }
  }
  if (live) {
    if (since(p.impact) < 8) crown(cx, cy, since(p.impact))
    if (since(p.impact) < 14) drops(cx, cy, since(p.impact), 1.2)
    if (since(p.impact) >= 3 && since(p.impact) < 20) ring(cx, cy, since(p.impact) - 3, 1)
    if (since(p.takeoff) < 8) drops(cx, cy, since(p.takeoff), 0.45)
    if (since(p.plunge) < 12) { const tail = world(stalk - FLUKE, 0, 0); ring(tail[0], tail[1], since(p.plunge), 0.6) }
  }
  // Wave strokes: a few short crests along a ground axis, which draw as 2:1 diagonals. Each drifts and fades.
  for (let k = 0; k < Math.max(4, Math.round(W / 14)); k += 1) {
    const life = Math.sin(tick * 0.05 + hash(k, 11) * 6.28)
    if (life < 0.15) continue
    const u0 = hash(k, 5) * W - tick * 0.15 * (0.5 + hash(k, 9)), v0 = hash(k, 6) * (H - 2) + 1
    const u = ((u0 % W) + W) % W
    for (let j = 0; j < 3 + Math.round(life * 4); j += 1) put(u + j, v0 + j / 2, 'muted')
  }

  // Cells. A cell the whale touches shows only the whale.
  const columns = W / 2, rows = H / 4
  const cellAt = (top: number, left: number): Cell => {
    let lit = 0, belly = 0, skin = 0, fin = 0, any = false, eye = false
    const dotRows = new Set<number>()
    for (let dy = 0; dy < 4; dy += 1) for (let dx = 0; dx < 2; dx += 1) {
      const part = whale[(top + dy) * W + left + dx] ?? Part.None
      if (part === Part.None) continue
      any = true
      if (part === Part.Eye) { eye = true; continue }
      lit += 1
      dotRows.add(dy)
      if (part === Part.Belly) belly += 1
      if (part === Part.Body || part === Part.Belly) skin += 1
      if (part === Part.Fin) fin += 1
    }
    // Belly is judged on the body's own skin, so a fin hanging in front of the underside does not hide it.
    return { any, eye, belly: belly >= 2 && belly * 2.5 >= skin && skin >= fin, white: false, skin: skin * 2 > lit,
      thin: dotRows.size <= 2 && [...dotRows].every(dy => dy >= 2), reachesTop: dotRows.has(0) }
  }
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => cellAt(r * 4, c * 2)))
  const cell = (r: number, c: number): Cell | undefined => grid[r]?.[c]
  // The belly band: the lowest whale cell of a column turns white when its dots are belly on the model, so the band
  // follows the underside but never reaches the head, the back, or an edge the water cuts; lone cells stay blue.
  // A whale pitched steeply up or down shows no band: from above its underside is out of sight.
  const level = Math.abs(p.pitch) < 15 * Math.PI / 180
  for (let c = 0; c < columns; c += 1) {
    for (let r = rows - 1; r >= 0; r -= 1) {
      const lowest = cell(r, c)
      if (lowest === undefined || !lowest.any) continue
      lowest.white = level && lowest.belly
      break
    }
  }
  const lone = grid.flatMap((line, r) => line.filter((value, c) => value.white
    && ![[0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]].some(([dr = 0, dc = 0]) => cell(r + dr, c + dc)?.white === true)))
  for (const value of lone) value.white = false
  // Glints: thin horizontal lines of light, one dot tall, along the back. In a glinting column a top body cell that is
  // already thin turns light blue; a full one gets a one-dot line along the bottom of the empty cell above it. A glint
  // runs two to four columns and twinkles on its own slow rhythm, keyed to its place on the body.
  const anchor = Math.round(project(cx, cy, p.z)[0] / 2)
  const tops = new Map<number, { row: number; thin: boolean }>()
  for (let c = 0; c < columns; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      const top = cell(r, c)
      if (top === undefined || !top.any) continue
      const open = r > 0 && cell(r - 1, c)?.any === false && top.reachesTop
      if (top.skin && !top.eye && !top.white && (top.thin || open)) tops.set(c, { row: r, thin: top.thin })
      break
    }
  }
  const glintCells = new Set<number>(), glintLines = new Set<number>()
  if (live) {
    // Each glint keeps a blue column on both ends, so two glints never merge.
    const taken = new Set<number>()
    for (let c = 0; c < columns; c += 1) {
      if (!tops.has(c) || taken.has(c - 1)) continue
      const key = hash(c - anchor, 7)
      if (key >= 0.45 || Math.sin(tick * 0.1 + key * 6.283) <= 0.8) continue
      // A glint stays on one screen row, so it is always a single straight line.
      const line = (column: number): number | undefined => {
        const top = tops.get(column)
        return top === undefined ? undefined : top.thin ? top.row : top.row - 1
      }
      const run: number[] = []
      const length = 2 + Math.floor(key * 7) % 3
      for (let step = 0; step < length && line(c + step) !== undefined && line(c + step) === line(c); step += 1) run.push(c + step)
      if (run.length < 2) continue
      for (const column of run) {
        taken.add(column)
        const top = tops.get(column)
        if (top === undefined) continue
        if (top.thin) glintCells.add(top.row * columns + column)
        else glintLines.add((top.row - 1) * columns + column)
      }
      taken.add(c + run.length)
    }
  }

  const out: Row[] = []
  for (let r = 0; r < rows; r += 1) {
    const spans: Span[] = []
    for (let c = 0; c < columns; c += 1) {
      const here = cell(r, c)
      const isWhale = here?.any === true
      let bits = 0
      const counts = new Map<Tone, number>()
      for (const [dy, pair] of BRAILLE.entries()) for (const [dx, bit] of pair.entries()) {
        const i = (r * 4 + dy) * W + c * 2 + dx
        if (isWhale) { const part = whale[i] ?? Part.None; if (part !== Part.None && part !== Part.Eye) bits |= bit; continue }
        const tone = spray[i]
        if (tone === undefined) continue
        bits |= bit
        counts.set(tone, (counts.get(tone) ?? 0) + 1)
      }
      let tone: Tone | undefined
      if (isWhale) tone = here.white ? 'text' : glintCells.has(r * columns + c) ? 'command' : 'brand'
      else for (const [name, count] of counts) if (tone === undefined || count > (counts.get(tone) ?? 0)) tone = name
      if (glintLines.has(r * columns + c)) { bits = BOTTOM_ROW; tone = 'command' }
      const text = bits === 0 ? ' ' : String.fromCodePoint(0x2800 + bits)
      const last = spans.at(-1)
      if (last !== undefined && last.tone === (bits === 0 ? 'text' : tone)) last.text += text
      else spans.push(bits === 0 || tone === undefined ? span(text) : span(text, tone))
    }
    out.push(row(...spans))
  }
  return out
}
