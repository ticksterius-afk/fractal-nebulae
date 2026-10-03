/**
 * First Light — what the world shows (design/60-first-light-build.md §M "Overlay feed", §R).
 *
 * Fills the mode's OverlayFrame (LOCAL frame of the level nebula) every frame from plain state:
 *  - beams: warm white-gold ribbons (intensity-scaled; the shader adds the cyan halo and the flow),
 *    small arrowheads every 10 % of their length in the lab view, endpoint glow where a beam is
 *    absorbed, a flare at every reflection;
 *  - seeds: an ember ring (unlit) that brightens as the beam's closest approach drops below 3 r, with
 *    a faint "almost" connector from the closest beam point; a teal diamond + spiked star when lit;
 *    echo seeds show their emit arrow once lit;
 *  - the source: a spiked star with a faint emit cone;
 *  - masses: point-mass lenses (rim glow from how close the beam passes) plus a faint ring glyph so
 *    they read at a distance (cyan when hovered or grabbed);
 *  - the placement preview: a lens at 0.45 strength, a green / red ring and a drop line to the surface;
 *  - hint 2: a dashed sphere outline; the Space pulse: big soft markers on every seed and mass;
 *  - accent lights (≤ 4, by importance): lit goal seeds, the beam's endpoint, the source, lit echoes.
 * Lines and glyphs behind structure draw at occludedAlpha (0.12 flight → 0.3 lab view).
 *
 * Allocation-free: only reads its inputs and pushes numbers into the overlay buffers.
 */
import * as THREE from 'three';
import { GLYPH_SHAPE, LINE_STYLE, type OverlayFrame } from '../../render/game/overlayTypes';
import { CRITICAL_IMPACT } from './Geodesic';
import type { LevelDef, PlacedMass, TraceResult } from './types';
import type { LocalView } from './LabView';

// Colours (linear HDR).
const BEAM = [2.4, 1.9, 1.2] as const;
const EMBER = [1.4, 0.55, 0.25] as const;
const LIT = [0.4, 2.2, 1.9] as const;
const CYAN = [0.5, 1.6, 1.8] as const;
const GOOD = [0.45, 1.7, 0.85] as const;
const BAD = [1.9, 0.42, 0.4] as const;
const MASS_RING = [0.42, 0.58, 0.72] as const;
const FLARE = [1.8, 1.9, 2.0] as const;

/** Ribbon widths (reference px). */
const W_BEAM = 3.4;
const W_GUIDE = 1.2;
const W_DASH = 1.5;

export const FEED = {
  occludedFlight: 0.12,
  occludedLab: 0.3,
  /** Accent radii (× R) and gains. */
  seedLightR: 0.32,
  seedLightGain: 0.8,
  endLightR: 0.18,
  endLightGain: 0.45,
  sourceLightR: 0.28,
  sourceLightGain: 0.35,
  /** Hint-2 sphere radius (× ρ of the hinted mass). */
  hintRho: 6,
};

export interface FeedPreview {
  active: boolean;
  x: number;
  y: number;
  z: number;
  rho: number;
  legal: boolean;
  drop: boolean;
  dx: number;
  dy: number;
  dz: number;
}

/** Everything the feed reads (the mode owns one and mutates it in place). */
export interface FeedState {
  level: LevelDef | null;
  result: TraceResult | null;
  masses: readonly PlacedMass[];
  /** Hovered mass (−1 none) and the mass being dragged (−1 none). */
  hover: number;
  active: number;
  preview: FeedPreview;
  /** Lab-view blend 0..1. */
  lab: number;
  /** Entry reveal: beam length drawn (0..1) and seed / mass fade-in (0..1). */
  beamReveal: number;
  seedReveal: number;
  /** Space pulse strength 0..1. */
  pulse: number;
  /** Ceremony multipliers (1 when not celebrating). */
  accentGain: number;
  swell: number;
  beamGain: number;
  hint: { active: boolean; x: number; y: number; z: number; radius: number };
  view: LocalView;
}

export function createFeedState(view: LocalView): FeedState {
  return {
    level: null,
    result: null,
    masses: [],
    hover: -1,
    active: -1,
    preview: { active: false, x: 0, y: 0, z: 0, rho: 0, legal: false, drop: false, dx: 0, dy: 0, dz: 0 },
    lab: 0,
    beamReveal: 1,
    seedReveal: 1,
    pulse: 0,
    accentGain: 1,
    swell: 1,
    beamGain: 1,
    hint: { active: false, x: 0, y: 0, z: 0, radius: 0 },
    view,
  };
}

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _side = new THREE.Vector3();

export class OverlayFeed {
  constructor(private readonly ov: OverlayFrame) {}

  /** Nothing to draw (atlas without a level, exit). */
  clear(): void {
    const ov = this.ov;
    ov.lines.clear();
    ov.glyphs.clear();
    ov.stars.clear();
    ov.lenses.clear();
    ov.accents.clear();
    ov.nebulaId = null;
  }

  fill(s: FeedState): void {
    const ov = this.ov;
    const level = s.level;
    ov.lines.clear();
    ov.glyphs.clear();
    ov.stars.clear();
    ov.lenses.clear();
    ov.accents.clear();
    if (!level) {
      ov.nebulaId = null;
      return;
    }
    const R = level.arena.radiusLocal;
    ov.nebulaId = level.nebula;
    ov.visible = true;
    ov.flowScale = R;
    const lab = clamp01(s.lab);
    ov.occludedAlpha = FEED.occludedFlight + (FEED.occludedLab - FEED.occludedFlight) * lab;

    // Lenses first (8 max): placed masses, then the preview.
    this.masses(s, R);
    this.preview(s, R);
    this.beams(s, R, lab);
    this.seeds(s, R);
    this.source(s, R);
    this.hint(s);
    this.accents(s, R);
  }

  // -------------------------------------------------------------------------------------------

  private beams(s: FeedState, R: number, lab: number): void {
    const res = s.result;
    if (!res) return;
    const L = this.ov.lines;
    const G = this.ov.glyphs;
    const reveal = clamp01(s.beamReveal);
    const gain = s.beamGain;
    for (let b = 0; b < res.beams.length; b++) {
      const beam = res.beams[b];
      const p = beam.points;
      const inten = beam.intensity;
      const len = beam.length;
      const n = (p.length / 3) | 0;
      if (n < 2) continue;
      const total = len[n - 1];
      const cut = reveal >= 1 ? Infinity : reveal * total;
      let drawnEnd = true;
      for (let i = 0; i < n - 1; i++) {
        const s0 = len[i];
        if (s0 >= cut) {
          drawnEnd = false;
          break;
        }
        const o = i * 3;
        const x0 = p[o];
        const y0 = p[o + 1];
        const z0 = p[o + 2];
        let x1 = p[o + 3];
        let y1 = p[o + 4];
        let z1 = p[o + 5];
        const dx = x1 - x0;
        const dy = y1 - y0;
        const dz = z1 - z0;
        if (dx * dx + dy * dy + dz * dz < 1e-24) continue; // zero-length (capture at birth, born in structure)
        const s1 = len[i + 1];
        if (s1 > cut) {
          const f = (cut - s0) / Math.max(s1 - s0, 1e-30);
          x1 = x0 + dx * f;
          y1 = y0 + dy * f;
          z1 = z0 + dz * f;
          drawnEnd = false;
        }
        const k = clamp01(inten[i]) * gain;
        L.push(x0, y0, z0, x1, y1, z1, BEAM[0] * k, BEAM[1] * k, BEAM[2] * k, W_BEAM, s0, LINE_STYLE.beam);
        if (!drawnEnd) break;
      }

      // Arrowheads every 10 % of the length (lab view).
      if (lab > 0.02 && reveal >= 1 && total > 1e-9) this.arrows(s, beam.points, len, n, total, R, lab);

      if (!drawnEnd) continue;
      // Reflection flares.
      const rf = beam.reflections;
      for (let i = 0; i + 2 < rf.length; i += 3) {
        G.push(rf[i], rf[i + 1], rf[i + 2], 0.03 * R, 6, GLYPH_SHAPE.glow, FLARE[0] * 0.6, FLARE[1] * 0.6, FLARE[2] * 0.6, 0, 0.1, 0);
        G.push(rf[i], rf[i + 1], rf[i + 2], 0.014 * R, 3.5, GLYPH_SHAPE.cross, 0.9, 1.0, 1.1, 0, 0.16, 0);
      }
      // Endpoint glow where the beam met an absorbing surface.
      if (beam.end === 'absorbed' || beam.end === 'limit') {
        const e = beam.endPos;
        const k = clamp01(inten[n - 1]) * gain;
        G.push(e[0], e[1], e[2], 0.035 * R, 8, GLYPH_SHAPE.glow, BEAM[0] * 0.32 * k, BEAM[1] * 0.24 * k, BEAM[2] * 0.16 * k, 0, 0.1, 0);
        G.push(e[0], e[1], e[2], 0.008 * R, 2.5, GLYPH_SHAPE.disc, BEAM[0] * 0.7 * k, BEAM[1] * 0.5 * k, BEAM[2] * 0.32 * k, 1, 0.2, 0);
      }
    }
  }

  private arrows(s: FeedState, p: readonly number[], len: readonly number[], n: number, total: number, R: number, lab: number): void {
    const L = this.ov.lines;
    const o = s.view.origin;
    const size = 0.022 * R;
    let next = 0.1 * total;
    let k = 1;
    for (let i = 0; i < n - 1 && k <= 9; i++) {
      const s0 = len[i];
      const s1 = len[i + 1];
      while (k <= 9 && next <= s1) {
        if (s1 - s0 > 1e-12 && next >= s0) {
          const f = (next - s0) / (s1 - s0);
          const j = i * 3;
          _a.set(p[j + 3] - p[j], p[j + 4] - p[j + 1], p[j + 5] - p[j + 2]);
          const segLen = _a.length();
          if (segLen > 1e-12) {
            _a.multiplyScalar(1 / segLen);
            _b.set(p[j] + (p[j + 3] - p[j]) * f, p[j + 1] + (p[j + 4] - p[j + 1]) * f, p[j + 2] + (p[j + 5] - p[j + 2]) * f);
            _c.subVectors(_b, o);
            _side.crossVectors(_a, _c);
            const sl = _side.length();
            if (sl > 1e-12) {
              _side.multiplyScalar(1 / sl);
              const c = 0.5 * lab;
              const bx = _b.x - _a.x * size;
              const by = _b.y - _a.y * size;
              const bz = _b.z - _a.z * size;
              const w = size * 0.55;
              L.push(_b.x, _b.y, _b.z, bx + _side.x * w, by + _side.y * w, bz + _side.z * w,
                BEAM[0] * c, BEAM[1] * c, BEAM[2] * c, W_GUIDE * 1.3, 0, LINE_STYLE.guide);
              L.push(_b.x, _b.y, _b.z, bx - _side.x * w, by - _side.y * w, bz - _side.z * w,
                BEAM[0] * c, BEAM[1] * c, BEAM[2] * c, W_GUIDE * 1.3, 0, LINE_STYLE.guide);
            }
          }
        }
        k++;
        next = 0.1 * k * total;
      }
    }
  }

  private seeds(s: FeedState, R: number): void {
    const level = s.level;
    if (!level) return;
    const G = this.ov.glyphs;
    const L = this.ov.lines;
    const S = this.ov.stars;
    const res = s.result;
    const a = clamp01(s.seedReveal);
    if (a <= 0) return;
    const pulse = clamp01(s.pulse);
    const sw = s.swell;
    for (let i = 0; i < level.seeds.length; i++) {
      const seed = level.seeds[i];
      const st = res ? res.seeds[seed.id] : undefined;
      const lit = st !== undefined && st.lit;
      const r = seed.radius;
      const x = seed.pos[0];
      const y = seed.pos[1];
      const z = seed.pos[2];
      const echo = seed.kind === 'echo';
      const k0 = echo ? 0.7 : 1;
      if (lit) {
        const k = a * k0;
        G.push(x, y, z, r * 1.15 * sw, 6 * sw * k0, GLYPH_SHAPE.diamond, LIT[0] * k, LIT[1] * k, LIT[2] * k, 1, 0.16, 0);
        G.push(x, y, z, r * 2.4 * sw, 12 * sw, GLYPH_SHAPE.glow, LIT[0] * 0.45 * k, LIT[1] * 0.45 * k, LIT[2] * 0.45 * k, 0, 0.1, 0);
        S.push(x, y, z, 0.42, 1.12, 1.04, 60 * sw * sw * k, 16 * sw * k0);
        if (echo && seed.emit) {
          const e = seed.emit;
          const len = 0.12 * R;
          const ex = x + e[0] * len;
          const ey = y + e[1] * len;
          const ez = z + e[2] * len;
          const c = 0.8 * k;
          L.push(x, y, z, ex, ey, ez, LIT[0] * c, LIT[1] * c, LIT[2] * c, W_GUIDE * 1.4, 0, LINE_STYLE.guide);
          G.push(ex, ey, ez, 0.01 * R, 3, GLYPH_SHAPE.dot, LIT[0] * c, LIT[1] * c, LIT[2] * c, 1, 0.2, 0);
        }
      } else {
        const closest = st ? st.closest : Infinity;
        const almost = Number.isFinite(closest) ? clamp01(1 - (closest - r) / (2 * r)) : 0;
        const k = a * k0 * (1 + 1.6 * almost);
        G.push(x, y, z, r, 5 * k0, echo ? GLYPH_SHAPE.ring : GLYPH_SHAPE.ring,
          EMBER[0] * k, EMBER[1] * k, EMBER[2] * k, 0.18 * almost, echo ? 0.22 : 0.14, 0.3 + i * 0.37);
        if (echo) G.push(x, y, z, r * 0.3, 2, GLYPH_SHAPE.dot, EMBER[0] * k, EMBER[1] * k, EMBER[2] * k, 1, 0.2, 0);
        const cp = st ? st.closestPoint : null;
        if (almost > 0.01 && cp) {
          const c = 0.4 * almost * a;
          L.push(cp[0], cp[1], cp[2], x, y, z, EMBER[0] * c, EMBER[1] * c, EMBER[2] * c, W_GUIDE, 0, LINE_STYLE.guide);
        }
      }
      if (pulse > 0) {
        const c = lit ? LIT : EMBER;
        const k = 0.55 * pulse * a;
        G.push(x, y, z, r * 3, 18 * pulse, GLYPH_SHAPE.glow, c[0] * k, c[1] * k, c[2] * k, 0, 0.1, 0);
        G.push(x, y, z, r * 1.6, 11 * pulse, GLYPH_SHAPE.ring, c[0] * k, c[1] * k, c[2] * k, 0, 0.12, 0.5 + i * 0.37);
      }
    }
  }

  private source(s: FeedState, R: number): void {
    const level = s.level;
    if (!level) return;
    const G = this.ov.glyphs;
    const L = this.ov.lines;
    const x = level.source.pos[0];
    const y = level.source.pos[1];
    const z = level.source.pos[2];
    const d = level.source.dir;
    // The level's one star: the brightest thing in the arena, with clear diffraction spikes, so it never
    // reads like the beam's dead end (a dim ember on the surface).
    this.ov.stars.push(x, y, z, 1, 0.95, 0.85, 900, 84);
    G.push(x, y, z, 0.035 * R, 7, GLYPH_SHAPE.glow, BEAM[0] * 0.45, BEAM[1] * 0.45, BEAM[2] * 0.45, 0, 0.1, 0);
    // Emit cone: four short guides around the emit direction (±8°).
    _a.set(d[0], d[1], d[2]);
    if (Math.abs(_a.y) < 0.9) _b.set(0, 1, 0);
    else _b.set(1, 0, 0);
    _side.crossVectors(_a, _b).normalize();
    _c.crossVectors(_a, _side).normalize();
    const len = 0.11 * R;
    const t = Math.tan(8 * (Math.PI / 180));
    const c = 0.32;
    for (let q = 0; q < 4; q++) {
      const sx = q === 0 ? 1 : q === 1 ? -1 : 0;
      const sy = q === 2 ? 1 : q === 3 ? -1 : 0;
      const ex = _a.x + (_side.x * sx + _c.x * sy) * t;
      const ey = _a.y + (_side.y * sx + _c.y * sy) * t;
      const ez = _a.z + (_side.z * sx + _c.z * sy) * t;
      const l = len / Math.sqrt(ex * ex + ey * ey + ez * ez);
      L.push(x, y, z, x + ex * l, y + ey * l, z + ez * l, BEAM[0] * c, BEAM[1] * c, BEAM[2] * c, W_GUIDE, 0, LINE_STYLE.guide);
    }
  }

  private masses(s: FeedState, R: number): void {
    const G = this.ov.glyphs;
    const lenses = this.ov.lenses;
    const res = s.result;
    const a = clamp01(s.seedReveal);
    const pulse = clamp01(s.pulse);
    for (let i = 0; i < s.masses.length; i++) {
      const m = s.masses[i];
      const x = m.pos[0];
      const y = m.pos[1];
      const z = m.pos[2];
      const mc = res && i < res.massClosest.length ? res.massClosest[i] : Infinity;
      // Rim glow: 0 beyond ~14 ρ, 1 when the beam grazes the capture radius.
      const glow = Number.isFinite(mc) ? clamp01((14 - mc) / (14 - CRITICAL_IMPACT)) : 0;
      lenses.push(x, y, z, m.rho, a, glow * glow * (3 - 2 * glow));
      const ringR = CRITICAL_IMPACT * m.rho * 1.35;
      if (i === s.active) {
        G.push(x, y, z, ringR, 7, GLYPH_SHAPE.ring, CYAN[0], CYAN[1], CYAN[2], 0, 0.12, 0);
      } else if (i === s.hover) {
        G.push(x, y, z, ringR, 6, GLYPH_SHAPE.ring, CYAN[0] * 0.8, CYAN[1] * 0.8, CYAN[2] * 0.8, 0, 0.1, 0.25);
      } else {
        const k = 0.35 * a;
        G.push(x, y, z, ringR, 3.5, GLYPH_SHAPE.ring, MASS_RING[0] * k, MASS_RING[1] * k, MASS_RING[2] * k, 0, 0.08, 0);
      }
      if (pulse > 0) {
        const k = 0.5 * pulse * a;
        G.push(x, y, z, ringR * 1.6, 13 * pulse, GLYPH_SHAPE.ring, CYAN[0] * k, CYAN[1] * k, CYAN[2] * k, 0, 0.1, 0.5 + i * 0.29);
      }
      void R;
    }
  }

  private preview(s: FeedState, R: number): void {
    const p = s.preview;
    if (!p.active) return;
    const G = this.ov.glyphs;
    const L = this.ov.lines;
    const c = p.legal ? GOOD : BAD;
    const ringR = CRITICAL_IMPACT * p.rho * 1.35;
    if (p.legal) this.ov.lenses.push(p.x, p.y, p.z, p.rho, 0.45, 0);
    G.push(p.x, p.y, p.z, ringR, 7, GLYPH_SHAPE.ring, c[0] * 0.9, c[1] * 0.9, c[2] * 0.9, 0, 0.12, 0);
    G.push(p.x, p.y, p.z, 0.004 * R, 2, GLYPH_SHAPE.dot, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, 1, 0.2, 0);
    if (p.drop) {
      const k = p.legal ? 0.4 : 0.3;
      const dc = p.legal ? CYAN : BAD;
      L.push(p.x, p.y, p.z, p.dx, p.dy, p.dz, dc[0] * k, dc[1] * k, dc[2] * k, W_GUIDE, 0, LINE_STYLE.guide);
      G.push(p.dx, p.dy, p.dz, 0.006 * R, 3, GLYPH_SHAPE.dot, dc[0] * k, dc[1] * k, dc[2] * k, 1, 0.2, 0);
    }
  }

  /** Hint 2: a dashed sphere outline (camera-facing silhouette) + a soft glow. */
  private hint(s: FeedState): void {
    const h = s.hint;
    if (!h.active || !(h.radius > 0)) return;
    const L = this.ov.lines;
    const v = s.view;
    const N = 56;
    const r = h.radius;
    const c = 0.6;
    let px = h.x + v.right.x * r;
    let py = h.y + v.right.y * r;
    let pz = h.z + v.right.z * r;
    let sAcc = 0;
    for (let i = 1; i <= N; i++) {
      const ang = (i / N) * Math.PI * 2;
      const ca = Math.cos(ang) * r;
      const sa = Math.sin(ang) * r;
      const qx = h.x + v.right.x * ca + v.up.x * sa;
      const qy = h.y + v.right.y * ca + v.up.y * sa;
      const qz = h.z + v.right.z * ca + v.up.z * sa;
      L.push(px, py, pz, qx, qy, qz, CYAN[0] * c, CYAN[1] * c, CYAN[2] * c, W_DASH, sAcc, LINE_STYLE.dashed);
      sAcc += Math.hypot(qx - px, qy - py, qz - pz);
      px = qx;
      py = qy;
      pz = qz;
    }
    this.ov.glyphs.push(h.x, h.y, h.z, r, 0, GLYPH_SHAPE.glow, CYAN[0] * 0.12, CYAN[1] * 0.12, CYAN[2] * 0.12, 0, 0.1, 0.5);
  }

  /** ≤ 4 accent lights by importance: lit goal seeds, the endpoint, the source, lit echo seeds. */
  private accents(s: FeedState, R: number): void {
    const level = s.level;
    if (!level) return;
    const A = this.ov.accents;
    const res = s.result;
    const a = clamp01(s.seedReveal);
    const g = s.accentGain;
    if (res) {
      for (let i = 0; i < level.seeds.length; i++) {
        const seed = level.seeds[i];
        if (!seed.goal) continue;
        const st = res.seeds[seed.id];
        if (!st || !st.lit) continue;
        const k = FEED.seedLightGain * g * a;
        A.push(seed.pos[0], seed.pos[1], seed.pos[2], FEED.seedLightR * R, LIT[0] * k, LIT[1] * k, LIT[2] * k);
      }
      const b0 = res.beams[0];
      if (b0 && (b0.end === 'absorbed' || b0.end === 'limit') && s.beamReveal >= 1) {
        const n = b0.intensity.length;
        const k = FEED.endLightGain * clamp01(n > 0 ? b0.intensity[n - 1] : 1) * Math.min(g, 1.6);
        const e = b0.endPos;
        A.push(e[0], e[1], e[2], FEED.endLightR * R, BEAM[0] * k, BEAM[1] * k, BEAM[2] * k);
      }
    }
    const sp = level.source.pos;
    const ks = FEED.sourceLightGain;
    A.push(sp[0], sp[1], sp[2], FEED.sourceLightR * R, 2.0 * ks, 1.75 * ks, 1.4 * ks);
    if (res) {
      for (let i = 0; i < level.seeds.length; i++) {
        const seed = level.seeds[i];
        if (seed.goal) continue;
        const st = res.seeds[seed.id];
        if (!st || !st.lit) continue;
        const k = 0.5 * FEED.seedLightGain * g * a;
        A.push(seed.pos[0], seed.pos[1], seed.pos[2], 0.6 * FEED.seedLightR * R, LIT[0] * k, LIT[1] * k, LIT[2] * k);
      }
    }
  }
}
