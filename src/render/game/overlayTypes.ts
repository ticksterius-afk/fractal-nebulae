/**
 * Game overlay contract (First Light and later modes → Renderer).
 *
 * A game mode owns one OverlayFrame and mutates it in place every frame (or only when something
 * changed); the Renderer reads it every frame. Everything is plain data: no three.js objects, no
 * per-frame allocation. ALL positions and sizes are in the LOCAL frame of `nebulaId`
 * (world = nebula.position + nebula.rotation · (local × nebula.scale)); the renderer converts them to
 * camera-relative world coordinates in doubles, so content co-rotates with spinning nebulae and stays
 * precise deep inside structure.
 *
 * What the renderer does with each buffer (see design/60-first-light-build.md §R):
 *  - lines   → camera-facing additive ribbons in the depth-tested sprite layer (beams, guides)
 *  - glyphs  → additive SDF markers (rings, discs, diamonds…) in the sprite layer
 *  - stars   → spiked star sprites (the JWST look of NebulaStars) in the sprite layer
 *  - lenses  → screen-space gravitational-lens warp + black shadow in the composite (point masses)
 *  - accents → up to 4 point lights added to the nebula raymarch shading of `nebulaId`
 * Occluded parts of lines and glyphs (behind fractal structure) are drawn at `occludedAlpha` so the
 * beam stays readable through walls (the beam is the interface).
 */

/** Line styles (LineBuffer `style` column). */
export const LINE_STYLE = {
  /** Light beam: hot core + soft halo, slow flowing pulses along the travel direction. */
  beam: 0,
  /** Thin guide (drop line, emit cone, "almost" connector): faint, no flow. */
  guide: 1,
  /** Dashed guide (hint region outline, preview). */
  dashed: 2,
} as const;

/** Glyph shapes (GlyphBuffer `shape` column). */
export const GLYPH_SHAPE = {
  /** Thin ring (outline). `fill` blends toward a filled disc. */
  ring: 0,
  /** Soft filled disc with a bright rim (glow / endpoint). */
  disc: 1,
  /** Diamond (◆ when fill = 1, ◇ outline when fill = 0). */
  diamond: 2,
  /** Small hard dot. */
  dot: 3,
  /** Plus-shaped cross. */
  cross: 4,
  /** Soft Gaussian glow, no outline (endpoint glow, ignition flare). */
  glow: 5,
} as const;

/**
 * Segment buffer. Per segment (stride 12):
 *   0-2  x0 y0 z0   start (local)
 *   3-5  x1 y1 z1   end (local)
 *   6-8  r g b      linear HDR colour (intensity already applied)
 *   9    width      ribbon width in reference px (≈ px at 1440p, 70° FOV); scaled like star sprites
 *   10   s0         distance along the polyline at the start (local units) — drives the flow pattern
 *   11   style      LINE_STYLE
 */
export class LineBuffer {
  static readonly STRIDE = 12;
  readonly data: Float64Array;
  count = 0;
  constructor(readonly capacity: number) {
    this.data = new Float64Array(capacity * LineBuffer.STRIDE);
  }
  clear(): void {
    this.count = 0;
  }
  /** Returns false (and drops the segment) when full. */
  push(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    r: number, g: number, b: number,
    width: number, s0: number, style: number,
  ): boolean {
    if (this.count >= this.capacity) return false;
    const o = this.count++ * LineBuffer.STRIDE;
    const d = this.data;
    d[o] = x0; d[o + 1] = y0; d[o + 2] = z0;
    d[o + 3] = x1; d[o + 4] = y1; d[o + 5] = z1;
    d[o + 6] = r; d[o + 7] = g; d[o + 8] = b;
    d[o + 9] = width; d[o + 10] = s0; d[o + 11] = style;
    return true;
  }
}

/**
 * Glyph buffer. Per glyph (stride 12):
 *   0-2  x y z      centre (local)
 *   3    size       radius in LOCAL units (world-sized marker; shrinks with distance)
 *   4    minPx      minimum on-screen radius (reference px) so far markers stay visible
 *   5    shape      GLYPH_SHAPE
 *   6-8  r g b      linear HDR colour
 *   9    fill       0 = outline … 1 = filled
 *   10   line       outline thickness as a fraction of the radius (0.04–0.3)
 *   11   phase      animation phase (pulse); the shader adds a soft breathing when > 0
 *                   (±18 % brightness, ±5 % size at 0.4 Hz of overlay.time, offset by `phase` cycles)
 */
export class GlyphBuffer {
  static readonly STRIDE = 12;
  readonly data: Float64Array;
  count = 0;
  constructor(readonly capacity: number) {
    this.data = new Float64Array(capacity * GlyphBuffer.STRIDE);
  }
  clear(): void {
    this.count = 0;
  }
  push(
    x: number, y: number, z: number,
    size: number, minPx: number, shape: number,
    r: number, g: number, b: number,
    fill: number, line: number, phase: number,
  ): boolean {
    if (this.count >= this.capacity) return false;
    const o = this.count++ * GlyphBuffer.STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = size; d[o + 4] = minPx; d[o + 5] = shape;
    d[o + 6] = r; d[o + 7] = g; d[o + 8] = b;
    d[o + 9] = fill; d[o + 10] = line; d[o + 11] = phase;
    return true;
  }
}

/**
 * Spiked star sprites (sources, ignited seeds). Per star (stride 8):
 *   0-2  x y z      position (local)
 *   3-5  r g b      colour, luminance-normalised (≈1)
 *   6    flux       integrated brightness in reference px² (NebulaStars uses ~20–400)
 *   7    spike      diffraction spike length in reference px (0 = none)
 */
export class StarBuffer {
  static readonly STRIDE = 8;
  readonly data: Float64Array;
  count = 0;
  constructor(readonly capacity: number) {
    this.data = new Float64Array(capacity * StarBuffer.STRIDE);
  }
  clear(): void {
    this.count = 0;
  }
  push(x: number, y: number, z: number, r: number, g: number, b: number, flux: number, spike: number): boolean {
    if (this.count >= this.capacity) return false;
    const o = this.count++ * StarBuffer.STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = r; d[o + 4] = g; d[o + 5] = b;
    d[o + 6] = flux; d[o + 7] = spike;
    return true;
  }
}

/**
 * Point-mass lenses (placed masses and the placement preview). Per lens (stride 6):
 *   0-2  x y z      position (local)
 *   3    rho        Schwarzschild radius (local units)
 *   4    strength   0..1 fade (0 = invisible; the preview uses ~0.45)
 *   5    glow       0..1 Einstein-rim brightness (how close the beam passes)
 * The renderer projects them and the composite applies the point-lens warp
 * β = θ − θ_E²/θ around each, with a black shadow of angular radius b_c = (3√3/2)·rho / distance.
 */
export class LensBuffer {
  static readonly STRIDE = 6;
  static readonly MAX = 8;
  readonly data = new Float64Array(LensBuffer.MAX * LensBuffer.STRIDE);
  count = 0;
  clear(): void {
    this.count = 0;
  }
  push(x: number, y: number, z: number, rho: number, strength: number, glow: number): boolean {
    if (this.count >= LensBuffer.MAX) return false;
    const o = this.count++ * LensBuffer.STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = rho; d[o + 4] = strength; d[o + 5] = glow;
    return true;
  }
}

/**
 * Accent point lights for the nebula `nebulaId` (lit seeds, the beam's endpoint, the source).
 * Per light (stride 7): x y z (local), radius (local, smooth falloff to 0), r g b (linear HDR).
 */
export class AccentBuffer {
  static readonly STRIDE = 7;
  static readonly MAX = 4;
  readonly data = new Float64Array(AccentBuffer.MAX * AccentBuffer.STRIDE);
  count = 0;
  clear(): void {
    this.count = 0;
  }
  push(x: number, y: number, z: number, radius: number, r: number, g: number, b: number): boolean {
    if (this.count >= AccentBuffer.MAX) return false;
    const o = this.count++ * AccentBuffer.STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = radius; d[o + 4] = r; d[o + 5] = g; d[o + 6] = b;
    return true;
  }
}

export interface OverlayFrame {
  /** Nebula whose LOCAL frame every buffer uses; null → nothing is drawn. */
  nebulaId: string | null;
  /** Master switch (false hides every buffer; the H key does NOT clear it — the beam is part of the world). */
  visible: boolean;
  /** Intensity multiplier for line/glyph fragments hidden behind structure (0 = fully hidden). */
  occludedAlpha: number;
  /** Seconds; drives flow / pulse animation (the mode passes its own clock so pausing freezes it). */
  time: number;
  /**
   * Characteristic LOCAL length of the content: the arena radius R. Sets the beam flow (pulse period
   * 0.06·R, speed 0.12·R/s) and the dash period of dashed guides (0.03·R). 0 / absent = derived from
   * the nebula's size (0.3 × its bound radius).
   */
  flowScale?: number;
  readonly lines: LineBuffer;
  readonly glyphs: GlyphBuffer;
  readonly stars: StarBuffer;
  readonly lenses: LensBuffer;
  readonly accents: AccentBuffer;
}

export function createOverlayFrame(lineCapacity = 8192, glyphCapacity = 512, starCapacity = 64): OverlayFrame {
  return {
    nebulaId: null,
    visible: true,
    occludedAlpha: 0.18,
    time: 0,
    flowScale: 0,
    lines: new LineBuffer(lineCapacity),
    glyphs: new GlyphBuffer(glyphCapacity),
    stars: new StarBuffer(starCapacity),
    lenses: new LensBuffer(),
    accents: new AccentBuffer(),
  };
}

/**
 * Screen-space lens handed from the Renderer to CompositePass.setLenses (one per visible lens).
 * uv in 0..1 (y up) of the OUTPUT image; radii as fractions of the output image HEIGHT.
 */
export interface ScreenLens {
  u: number;
  v: number;
  /** Angular Einstein radius θ_E as a fraction of the image height. */
  einstein: number;
  /** Shadow (capture cross-section) radius as a fraction of the image height. */
  shadow: number;
  /** Window-space log depth of the lens centre (0..1, same encoding as the scene depth texture). */
  depth01: number;
  /** 0..1 overall fade. */
  strength: number;
  /** 0..1 Einstein-rim brightness. */
  glow: number;
}

/** Accent lights resolved for the nebula pass (filled by the Renderer into RenderContext.accents). */
export interface AccentLights {
  /** Nebula the lights belong to (null = none this frame). */
  nebulaId: string | null;
  count: number;
  /** count × vec4: local xyz + radius (local units). Length 16. */
  posRadius: Float32Array;
  /** count × vec4: linear HDR rgb + 0. Length 16. */
  colour: Float32Array;
}
