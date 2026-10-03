/**
 * First Light level preview (design/60-first-light-build.md §L): CPU-raymarched PNGs of a level so a
 * designer can SEE it, from its vantage (the first-person entry pose, 70° vertical FOV) and from the
 * lab view (the game's LabView framing: 2.2 R from the centre on the vantage's side, elevation clamped to
 * −50…55°; structure within 1.45 R of the camera skipped like the game's ghost clip), with the beam, seeds, source and masses
 * drawn on top (dimmed where structure hides them, like the game's occluded pass).
 *
 *   npx tsx tools/fl-preview.ts <levels> <levelId> <outDir> [--solution] [--size 480x300]
 *   npx tsx tools/fl-preview.ts --arena <nebula>:<index> <outDir> [--size 480x300]     (a daily arena, no level)
 *
 * <levels>: a .ts/.js module or .json file (see tools/fl-solve.ts). Writes <id>-vantage.png and
 * <id>-lab.png (…-solution.png with --solution). Legend: dashed blue = the unlensed beam; gold with a
 * cyan halo = the beam with the solution; rings = seeds (ember unlit, teal lit; a dashed ember line
 * joins an "almost" seed to the beam's closest point); white star + arrow = the source; black discs
 * with a warm rim = the masses (shadow radius 2.6 ρ; letter = size); dotted circle = the arena edge.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { writePNG } from './cpu-render';
import { arenaOf, loadLevels } from './fl-solve';
import { traceLevel } from '../src/game/firstlight/BeamTracer';
import { sanitizeLevel } from '../src/game/firstlight/Level';
import { makeTraceWorld, nebulaFractal } from '../src/game/firstlight/world';
import { LabView } from '../src/game/firstlight/LabView';
import { lookRotation } from '../src/sim/quat';
import { NEBULA_BY_ID } from '../src/universe/catalog';
import type { Vec3 } from '../src/core/types';
import type { ArenaDef, LevelDef, PlacedMass, TraceResult, TraceWorld } from '../src/game/firstlight/types';

type RGB = [number, number, number];

// ---------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------

interface Camera {
  pos: Vec3;
  fw: Vec3;
  rt: Vec3;
  up: Vec3;
  tan: number;
  W: number;
  H: number;
  /** Structure closer than this is skipped (lab view ghost clip). */
  clip: number;
}

const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Readonly<Vec3>): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Readonly<Vec3>): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const mad = (a: Readonly<Vec3>, b: Readonly<Vec3>, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

function lookAt(pos: Vec3, target: Readonly<Vec3>, upHint: Readonly<Vec3>, W: number, H: number, clip = 0, fovDeg = 70): Camera {
  const fw = norm(sub(target, pos));
  let rt = cross(fw, upHint);
  if (len(rt) < 1e-6) rt = cross(fw, [1, 0, 0]);
  rt = norm(rt);
  const up = cross(rt, fw);
  return { pos, fw, rt, up, tan: Math.tan((fovDeg * Math.PI) / 360), W, H, clip };
}

/**
 * The game's lab framing, from the game's own code: LabView.enter from the vantage pose (OverviewCamera.frame
 * with fromDir = vantage − centre, distance 2.2 R, elevation clamped to LabView's −50…55°), snapped.
 */
function labCamera(arena: ArenaDef, W: number, H: number): Camera {
  const C = arena.centerLocal;
  const R = arena.radiusLocal;
  const v = arena.vantage;
  const u = norm(arena.up ?? [0, 1, 0]);
  const fwd = norm(sub(v.lookAt, v.pos));
  const lab = new LabView();
  lab.enter(arena, new THREE.Vector3(v.pos[0], v.pos[1], v.pos[2]), lookRotation(new THREE.Vector3(fwd[0], fwd[1], fwd[2]), new THREE.Vector3(u[0], u[1], u[2]), new THREE.Quaternion()));
  const c = lab.cam;
  const pos: Vec3 = [c.position.x, c.position.y, c.position.z];
  const d = len(sub(pos, C));
  return {
    pos,
    fw: [c.forward.x, c.forward.y, c.forward.z],
    rt: [c.right.x, c.right.y, c.right.z],
    up: [c.screenUp.x, c.screenUp.y, c.screenUp.z],
    tan: Math.tan((70 * Math.PI) / 360),
    W,
    H,
    clip: Math.max(0, d - 0.75 * R),
  };
}

function vantageCamera(arena: ArenaDef, W: number, H: number): Camera {
  return lookAt([...arena.vantage.pos], arena.vantage.lookAt, arena.up ?? [0, 1, 0], W, H);
}

/** Screen position (px) and view depth of p, or null behind the near plane. */
function project(cam: Camera, p: Readonly<Vec3>, near: number): { x: number; y: number; z: number } | null {
  const r = sub(p, cam.pos);
  const z = dot(r, cam.fw);
  if (z <= near) return null;
  const aspect = cam.W / cam.H;
  return {
    x: cam.W * 0.5 * (1 + dot(r, cam.rt) / (z * cam.tan * aspect)),
    y: cam.H * 0.5 * (1 - dot(r, cam.up) / (z * cam.tan)),
    z,
  };
}

// ---------------------------------------------------------------------------------------------
// Scene raymarch
// ---------------------------------------------------------------------------------------------

/** Hash → [0, 1) (stars). */
function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Frame {
  W: number;
  H: number;
  /** Display-space RGB 0..1. */
  img: Float32Array;
  /** Ray distance of the surface per pixel (Infinity = sky). */
  depth: Float32Array;
}

function renderScene(nebula: string, world: TraceWorld, cam: Camera, arena: ArenaDef): Frame {
  const { W, H } = cam;
  const def = NEBULA_BY_ID[nebula];
  const pal = def.palette;
  const B = nebulaFractal(nebula).boundRadius;
  const R = arena.radiusLocal;
  const C = arena.centerLocal;
  const lightPos: Vec3 = def.lights.length ? [...def.lights[0].local] : [B * 1.5, B * 1.8, B];
  const lightCol: RGB = def.lights.length ? (def.lights[0].color.map((c) => c / Math.max(...def.lights[0].color)) as RGB) : [1, 1, 1];
  const de = (p: Readonly<Vec3>): number => world.de(p[0], p[1], p[2]);
  const img = new Float32Array(W * H * 3);
  const depth = new Float32Array(W * H).fill(Infinity);
  const pixA = (2 * cam.tan) / H;
  const tMax = len(sub(cam.pos, C)) + 2.5 * R;
  const aspect = W / H;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const u = ((px + 0.5) / W) * 2 - 1;
      const v = 1 - ((py + 0.5) / H) * 2;
      const rd = norm([
        cam.fw[0] + cam.rt[0] * u * cam.tan * aspect + cam.up[0] * v * cam.tan,
        cam.fw[1] + cam.rt[1] * u * cam.tan * aspect + cam.up[1] * v * cam.tan,
        cam.fw[2] + cam.rt[2] * u * cam.tan * aspect + cam.up[2] * v * cam.tan,
      ]);
      let t = cam.clip;
      if (t > 0) {
        // Ghost clip: start beyond any structure the clip sphere cuts through.
        for (let i = 0; i < 200; i++) {
          const d = de(mad(cam.pos, rd, t));
          if (d > 2e-4 * R) break;
          t += Math.max(Math.abs(d), 3e-3 * R);
        }
      }
      let hit = false;
      let steps = 0;
      for (; steps < 220; steps++) {
        const d = de(mad(cam.pos, rd, t));
        const thr = Math.max(t * pixA * 0.6, 1e-4 * R);
        if (d < thr) {
          hit = true;
          break;
        }
        t += 0.9 * d;
        if (t > tMax) break;
      }
      // Sky: deep blue-black with the far gas tint and sparse stars.
      const sky: RGB = [pal.glowFar[0] * 0.06 + 0.004, pal.glowFar[1] * 0.06 + 0.005, pal.glowFar[2] * 0.06 + 0.012];
      let col: RGB = sky;
      const s = hash(px, py);
      if (s < 0.0025) {
        const b = 0.3 + 2.5 * hash(py, px);
        col = [sky[0] + b, sky[1] + b, sky[2] + b * 1.1];
      }
      if (hit) {
        const p = mad(cam.pos, rd, t);
        depth[py * W + px] = t;
        const e = Math.max(t * pixA * 0.5, 2e-5 * R);
        const n = norm([
          de([p[0] + e, p[1], p[2]]) - de([p[0] - e, p[1], p[2]]),
          de([p[0], p[1] + e, p[2]]) - de([p[0], p[1] - e, p[2]]),
          de([p[0], p[1], p[2] + e]) - de([p[0], p[1], p[2] - e]),
        ]);
        const L = norm(sub(lightPos, p));
        const wrap = Math.max(0, (dot(n, L) + 0.25) / 1.25);
        let occ = 0;
        const dl = 0.012 * R;
        for (let k = 1; k <= 5; k++) occ += ((k * dl - Math.max(de(mad(p, n, k * dl)), 0)) / (k * dl)) * Math.pow(0.6, k);
        const ao = Math.min(1, Math.max(0.15, 1 - 1.2 * occ));
        const tc = len(p) / B * 2.2 + 0.15 * n[1];
        const alb: RGB = [0, 1, 2].map((i) => pal.a[i] + pal.b[i] * Math.cos(2 * Math.PI * (pal.c[i] * tc + pal.d[i]))) as RGB;
        const rim = Math.pow(1 - Math.max(0, -dot(rd, n)), 4);
        const fog = 1 - Math.exp(-Math.max(0, t - cam.clip) / (6 * R));
        col = [0, 1, 2].map((i) => {
          const lit = alb[i] * (pal.ambient[i] * 0.9 + lightCol[i] * wrap * 1.3) * ao + pal.rim[i] * rim * 0.35 * ao + pal.glowNear[i] * 0.05 * (1 - ao);
          return lit * (1 - fog) + sky[i] * fog;
        }) as RGB;
      }
      const o = (py * W + px) * 3;
      for (let i = 0; i < 3; i++) {
        const x = col[i] * 1.3;
        img[o + i] = Math.pow(x / (1 + x), 1 / 2.2);
      }
    }
  }
  return { W, H, img, depth };
}

// ---------------------------------------------------------------------------------------------
// Overlay layers (coverage buffer per primitive; occluded pixels dimmed)
// ---------------------------------------------------------------------------------------------

class Layer {
  readonly cov: Float32Array;
  readonly z: Float32Array;
  private dashPos = 0;
  constructor(readonly f: Frame, readonly cam: Camera) {
    this.cov = new Float32Array(f.W * f.H);
    this.z = new Float32Array(f.W * f.H).fill(Infinity);
  }

  stamp(x: number, y: number, z: number, r: number): void {
    const { W, H } = this.f;
    const x0 = Math.max(0, Math.floor(x - r - 1));
    const x1 = Math.min(W - 1, Math.ceil(x + r + 1));
    const y0 = Math.max(0, Math.floor(y - r - 1));
    const y1 = Math.min(H - 1, Math.ceil(y + r + 1));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(i + 0.5 - x, j + 0.5 - y);
        const c = Math.min(1, Math.max(0, r + 0.5 - d));
        if (c <= 0) continue;
        const k = j * W + i;
        if (c > this.cov[k]) this.cov[k] = c;
        if (z < this.z[k]) this.z[k] = z;
      }
    }
  }

  /** A 3D segment (near-clipped), width w px; dash > 0 draws dashes of that many px. */
  segment(a: Readonly<Vec3>, b: Readonly<Vec3>, w: number, dash = 0, depth = 0): void {
    const near = 1e-4;
    const za = dot(sub(a, this.cam.pos), this.cam.fw);
    const zb = dot(sub(b, this.cam.pos), this.cam.fw);
    if (za <= near && zb <= near) return;
    let p: Vec3 = [...a];
    let q: Vec3 = [...b];
    if (za <= near) p = mad(a, sub(b, a), (near - za) / (zb - za) + 1e-9);
    if (zb <= near) q = mad(a, sub(b, a), (near - za) / (zb - za) - 1e-9);
    const pa = project(this.cam, p, near * 0.5);
    const pb = project(this.cam, q, near * 0.5);
    if (!pa || !pb) return;
    const L = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (L > 4 * (this.f.W + this.f.H)) {
      // Passing right by the camera: split in 3D until the halves project to sane lengths.
      if (depth < 8) {
        const m = mad(p, sub(q, p), 0.5);
        this.segment(p, m, w, dash, depth + 1);
        this.segment(m, q, w, dash, depth + 1);
      }
      return;
    }
    const n = Math.max(1, Math.ceil(L / 0.5));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const s = project(this.cam, mad(p, sub(q, p), t), near * 0.5);
      if (!s) continue;
      const pos = this.dashPos + t * L;
      if (dash > 0 && Math.floor(pos / dash) % 2 === 1) continue;
      this.stamp(s.x, s.y, s.z, w * 0.5);
    }
    this.dashPos += L;
  }

  polyline(pts: readonly number[], w: number, dash = 0): void {
    this.dashPos = 0;
    for (let i = 0; i + 5 < pts.length; i += 3) {
      this.segment([pts[i], pts[i + 1], pts[i + 2]], [pts[i + 3], pts[i + 4], pts[i + 5]], w, dash);
    }
  }

  /** Screen-space ring around a 3D centre: world radius (min px), width w px; dots > 0 → dotted. */
  ring(c: Readonly<Vec3>, worldR: number, minPx: number, w: number, fill = false, dots = 0): void {
    const s = project(this.cam, c, 1e-4);
    if (!s) return;
    const rp = Math.max(minPx, (worldR * this.f.H) / (2 * s.z * this.cam.tan));
    const { W, H } = this.f;
    const x0 = Math.max(0, Math.floor(s.x - rp - w - 1));
    const x1 = Math.min(W - 1, Math.ceil(s.x + rp + w + 1));
    const y0 = Math.max(0, Math.floor(s.y - rp - w - 1));
    const y1 = Math.min(H - 1, Math.ceil(s.y + rp + w + 1));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const dx = i + 0.5 - s.x;
        const dy = j + 0.5 - s.y;
        const d = Math.hypot(dx, dy);
        if (dots > 0 && Math.floor(((Math.atan2(dy, dx) + Math.PI) * rp) / dots) % 2 === 1) continue;
        const c = fill ? Math.min(1, Math.max(0, rp + 0.5 - d)) : Math.min(1, Math.max(0, w * 0.5 + 0.5 - Math.abs(d - rp)));
        if (c <= 0) continue;
        const k = j * W + i;
        if (c > this.cov[k]) this.cov[k] = c;
        if (s.z < this.z[k]) this.z[k] = s.z;
      }
    }
  }

  /** Composite onto the frame: colour × alpha (× occluded where hidden behind structure). */
  draw(col: RGB, alpha: number, occluded = 0.3): void {
    const { img, depth } = this.f;
    for (let k = 0; k < this.cov.length; k++) {
      const c = this.cov[k];
      if (c <= 0) continue;
      const hidden = this.z[k] > depth[k] * 1.0005;
      const a = alpha * c * (hidden ? occluded : 1);
      const o = 3 * k;
      img[o] = img[o] * (1 - a) + col[0] * a;
      img[o + 1] = img[o + 1] * (1 - a) + col[1] * a;
      img[o + 2] = img[o + 2] * (1 - a) + col[2] * a;
    }
    this.cov.fill(0);
    this.z.fill(Infinity);
  }
}

// ---------------------------------------------------------------------------------------------
// 5×7 bitmap font (uppercase, digits, a little punctuation)
// ---------------------------------------------------------------------------------------------

const FONT: Record<string, string> = {
  A: '.###.#...##...#######...##...##...#', B: '####.#...##...#####.#...##...#####.', C: '.###.#...##....#....#....#...#.###.',
  D: '####.#...##...##...##...##...#####.', E: '######....#....####.#....#....#####', F: '######....#....####.#....#....#....',
  G: '.###.#...##....#.####...##...#.####', H: '#...##...##...#######...##...##...#', I: '.###...#....#....#....#....#...###.',
  J: '..###...#....#....#....#.#..#..##..', K: '#...##..#.#.#..##...#.#..#..#.#...#', L: '#....#....#....#....#....#....#####',
  M: '#...###.###.#.##.#.##...##...##...#', N: '#...##...###..##.#.##..###...##...#', O: '.###.#...##...##...##...##...#.###.',
  P: '####.#...##...#####.#....#....#....', Q: '.###.#...##...##...##.#.##..#..##.#', R: '####.#...##...#####.#.#..#..#.#...#',
  S: '.#####....#.....###.....#....#####.', T: '#####..#....#....#....#....#....#..', U: '#...##...##...##...##...##...#.###.',
  V: '#...##...##...##...##...#.#.#...#..', W: '#...##...##...##.#.##.#.##.#.#.#.#.', X: '#...##...#.#.#...#...#.#.#...##...#',
  Y: '#...##...#.#.#...#....#....#....#..', Z: '#####....#...#...#...#...#....#####',
  '0': '.###.#...##..###.#.###..##...#.###.', '1': '..#...##....#....#....#....#...###.', '2': '.###.#...#....#...#...#...#...#####',
  '3': '#####...#...#.....#.....##...#.###.', '4': '...#...##..#.#.#..#.#####...#....#.', '5': '######....####.....#....##...#.###.',
  '6': '..##..#...#....####.#...##...#.###.', '7': '#####....#...#...#...#....#....#...', '8': '.###.#...##...#.###.#...##...#.###.',
  '9': '.###.#...##...#.####....#...#..##..', '-': '...............#####...............', '.': '..........................##...##..',
  ':': '......##...##........##...##.......', '/': '.........#...#...#...#...#.........', '(': '...#...#...#....#....#.....#.....#.',
  ')': '.#.....#.....#....#....#...#...#...', '%': '##...##..#...#...#...#...#..##...##', ',': '.....................##....#...#...',
  '+': '.......#....#..#####..#....#.......', '=': '..........#####.....#####..........', '>': '.#.....#.....#.....#...#...#...#...',
  '<': '...#...#...#...#.....#.....#.....#.', '_': '..............................#####', "'": '..#....#...#.......................',
  '*': '.....#.#.#.###.#####.###.#.#.#.....', ' ': '...................................',
};

function text(f: Frame, x0: number, y0: number, s: string, col: RGB, scale = 1): void {
  let x = x0;
  for (const ch0 of s.toUpperCase()) {
    const g = FONT[ch0] ?? FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let c = 0; c < 5; c++) {
        if (g[row * 5 + c] !== '#') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            // 1-px dark shadow, then the glyph.
            for (const [ox, oy, cc] of [[1, 1, [0, 0, 0] as RGB], [0, 0, col]] as [number, number, RGB][]) {
              const px = x + c * scale + dx + ox;
              const py = y0 + row * scale + dy + oy;
              if (px < 0 || py < 0 || px >= f.W || py >= f.H) continue;
              const o = (py * f.W + px) * 3;
              f.img[o] = cc[0];
              f.img[o + 1] = cc[1];
              f.img[o + 2] = cc[2];
            }
          }
        }
      }
    }
    x += 6 * scale;
  }
}

// ---------------------------------------------------------------------------------------------
// Level preview
// ---------------------------------------------------------------------------------------------

const COL = {
  unlensed: [0.62, 0.74, 0.95] as RGB,
  halo: [0.35, 0.85, 1.0] as RGB,
  beam: [1.0, 0.86, 0.55] as RGB,
  ember: [1.0, 0.55, 0.25] as RGB,
  teal: [0.35, 1.0, 0.85] as RGB,
  star: [1.0, 0.97, 0.85] as RGB,
  rim: [1.0, 0.9, 0.7] as RGB,
  edge: [0.55, 0.65, 0.8] as RGB,
  label: [0.9, 0.95, 1.0] as RGB,
};

function drawLevel(f: Frame, cam: Camera, level: LevelDef, unlensed: TraceResult, solved: TraceResult | null, masses: PlacedMass[], lab: boolean): void {
  const R = level.arena.radiusLocal;
  const C = level.arena.centerLocal;
  const L = new Layer(f, cam);
  if (lab) {
    // Arena edge: the sphere's silhouette circle around the centre.
    const D = len(sub(cam.pos, C));
    const ang = Math.asin(Math.min(R / D, 1));
    const s = project(cam, C, 1e-4);
    if (s) {
      const rp = (Math.tan(ang) * f.H) / (2 * cam.tan);
      L.ring(C, (rp * 2 * s.z * cam.tan) / f.H, 0, 1.2, false, 4);
      L.draw(COL.edge, 0.5, 0.5);
    }
    // Vantage marker.
    L.ring(level.arena.vantage.pos, 0, 3, 1.5, true);
    L.draw(COL.halo, 0.9, 0.5);
  }
  // Unlensed beam.
  for (const b of unlensed.beams) L.polyline(b.points, 1.6, 5);
  L.draw(COL.unlensed, 0.9, 0.35);
  const result = solved ?? unlensed;
  if (solved) {
    for (const b of solved.beams) L.polyline(b.points, 6);
    L.draw(COL.halo, 0.25, 0.3);
    for (const b of solved.beams) L.polyline(b.points, 2.2);
    L.draw(COL.beam, 1, 0.35);
  }
  // Source: star and emit arrow.
  const src = level.source;
  L.segment(src.pos, mad(src.pos, src.dir, 0.1 * R), 1.4);
  L.draw(COL.star, 0.8, 0.4);
  L.ring(src.pos, 0, 3.5, 0, true);
  L.draw(COL.star, 1, 0.5);
  const sp = project(cam, src.pos, 1e-4);
  if (sp) {
    for (const [dx, dy] of [[1, 0], [0, 1], [0.7, 0.7], [0.7, -0.7]]) {
      for (let k = -9; k <= 9; k++) L.stamp(sp.x + dx * k, sp.y + dy * k, sp.z, Math.abs(k) < 4 ? 0.9 : 0.5);
    }
    L.draw(COL.star, 0.9, 0.5);
  }
  // Seeds.
  for (const s of level.seeds) {
    const st = result.seeds[s.id];
    const lit = st?.lit === true;
    if (!lit && st && st.closestPoint && st.closest < 3 * s.radius) {
      L.segment(st.closestPoint, s.pos, 1, 3);
      L.draw(COL.ember, 0.7, 0.4);
    }
    L.ring(s.pos, s.radius, 4, 2);
    L.draw(lit ? COL.teal : COL.ember, 1, 0.45);
    if (lit) {
      L.ring(s.pos, s.radius, 4, 0, true);
      L.draw(COL.teal, 0.3, 0.2);
    }
    const p = project(cam, s.pos, 1e-4);
    if (p) text(f, Math.round(p.x + 6), Math.round(p.y - 10), s.id, lit ? COL.teal : COL.ember);
  }
  // Masses: shadow disc (2.6 ρ) with a warm rim.
  for (const m of masses) {
    L.ring(m.pos, 2.598 * m.rho, 3, 0, true);
    L.draw([0, 0, 0], 1, 0.6);
    L.ring(m.pos, 2.598 * m.rho, 3, 1.4);
    L.draw(COL.rim, 1, 0.5);
    const p = project(cam, m.pos, 1e-4);
    if (p) text(f, Math.round(p.x + 6), Math.round(p.y + 3), m.size[0], COL.rim);
  }
}

function writeFrame(f: Frame, path: string): void {
  const rgb = new Uint8Array(f.W * f.H * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.max(0, Math.min(255, Math.round(f.img[i] * 255)));
  writePNG(path, f.W, f.H, rgb);
}

export interface PreviewOptions {
  width?: number;
  height?: number;
  /** Draw the solution's masses and the beam they make. */
  solution?: boolean;
}

/** Renders the vantage and lab previews of a level into outDir; returns the written paths. */
export function renderLevelPreview(level: LevelDef, outDir: string, opts: PreviewOptions = {}): string[] {
  const W = opts.width ?? 480;
  const H = opts.height ?? 300;
  const world = makeTraceWorld(level);
  const unlensed = traceLevel(level, world, []);
  const masses: PlacedMass[] = opts.solution ? level.solution.map((m) => ({ size: m.size, pos: m.pos, rho: level.masses[m.size] })) : [];
  const solved = opts.solution ? traceLevel(level, world, masses) : null;
  mkdirSync(outDir, { recursive: true });
  const out: string[] = [];
  for (const view of ['vantage', 'lab'] as const) {
    const cam = view === 'lab' ? labCamera(level.arena, W, H) : vantageCamera(level.arena, W, H);
    const f = renderScene(level.nebula, world, cam, level.arena);
    drawLevel(f, cam, level, unlensed, solved, masses, view === 'lab');
    const budget = Object.entries(level.budget)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([s, n]) => `${s} ${n}`)
      .join(' + ');
    text(f, 6, 6, `${level.id}  ${view}`, COL.label, 2);
    text(f, 6, 24, `${level.nebula}  R ${level.arena.radiusLocal}  budget ${budget}  par ${level.par}`, COL.label);
    const res = solved ?? unlensed;
    const seedLine = level.seeds.map((s) => `${s.id} ${res.seeds[s.id]?.lit ? 'lit' : `${((res.seeds[s.id]?.closest ?? Infinity) / s.radius).toFixed(1)}r`}`).join('  ');
    text(f, 6, H - 22, `${solved ? 'solution' : 'unlensed'}: ${res.solved ? 'solved' : 'unsolved'}  beam ${res.beams[0].end}  ${seedLine}`, COL.label);
    text(f, 6, H - 11, `-- unlensed  == beam  o seed  * star  ${opts.solution ? 'l/m/h mass' : ''}`, COL.edge);
    const path = join(outDir, `${level.id}-${view}${opts.solution ? '-solution' : ''}.png`);
    writeFrame(f, path);
    out.push(path);
  }
  return out;
}

/** Renders an arena alone (vantage + lab) into outDir; returns the written paths. */
export function renderArenaPreview(nebula: string, clock: number, arena: ArenaDef, name: string, outDir: string, W = 480, H = 300): string[] {
  const level: LevelDef = {
    id: name,
    chapter: 'arena',
    index: 1,
    name,
    nebula,
    clock,
    arena,
    source: { pos: [...arena.vantage.pos], dir: norm(sub(arena.centerLocal, arena.vantage.pos)) },
    seeds: [],
    masses: { light: 0.012 * arena.radiusLocal, medium: 0.022 * arena.radiusLocal, heavy: 0.035 * arena.radiusLocal },
    budget: {},
    solution: [],
    hints: ['', '', ''],
    teach: '',
    par: 0,
  };
  const world = makeTraceWorld(level);
  mkdirSync(outDir, { recursive: true });
  const out: string[] = [];
  for (const view of ['vantage', 'lab'] as const) {
    const cam = view === 'lab' ? labCamera(arena, W, H) : vantageCamera(arena, W, H);
    const f = renderScene(nebula, world, cam, arena);
    if (view === 'lab') {
      const Ly = new Layer(f, cam);
      const C = arena.centerLocal;
      const D = len(sub(cam.pos, C));
      const s = project(cam, C, 1e-4);
      if (s) {
        const rp = (Math.tan(Math.asin(Math.min(arena.radiusLocal / D, 1))) * H) / (2 * cam.tan);
        Ly.ring(C, (rp * 2 * s.z * cam.tan) / H, 0, 1.2, false, 4);
        Ly.draw(COL.edge, 0.6, 0.6);
      }
      Ly.ring(arena.vantage.pos, 0, 3, 1.5, true);
      Ly.draw(COL.halo, 0.9, 0.5);
    }
    text(f, 6, 6, `${name}  ${view}`, COL.label, 2);
    text(f, 6, 24, `${nebula}  clock ${clock}  R ${arena.radiusLocal}`, COL.label);
    const path = join(outDir, `${name}-${view}.png`);
    writeFrame(f, path);
    out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const si = args.indexOf('--size');
  let W = 480;
  let H = 300;
  if (si >= 0) {
    const m = /^(\d+)x(\d+)$/.exec(args[si + 1] ?? '');
    if (!m) throw new Error('--size WxH expected');
    W = Number(m[1]);
    H = Number(m[2]);
    args.splice(si, 2);
  }
  const t0 = performance.now();
  if (args[0] === '--arena') {
    const [nebula, idx] = (args[1] ?? '').split(':');
    const a = arenaOf(nebula, Number(idx));
    if (!a || !args[2]) {
      console.error('usage: npx tsx tools/fl-preview.ts --arena <nebula>:<index> <outDir> [--size WxH]');
      process.exit(2);
    }
    for (const p of renderArenaPreview(nebula, a.clock, a.arena, `arena-${nebula}-${idx}`, args[2], W, H)) console.log(p);
  } else {
    const sol = args.includes('--solution');
    const pos = args.filter((a) => !a.startsWith('--'));
    if (pos.length < 3) {
      console.error('usage: npx tsx tools/fl-preview.ts <levels> <levelId> <outDir> [--solution] [--size WxH]');
      process.exit(2);
    }
    const raws = await loadLevels(pos[0]);
    const raw = raws.find((r) => typeof r === 'object' && r !== null && (r as { id?: unknown }).id === pos[1]);
    const errors: string[] = [];
    const level = raw ? sanitizeLevel(raw, errors) : null;
    if (!level) {
      console.error(raw ? `level does not sanitise: ${errors.join('; ')}` : `level "${pos[1]}" not found in ${pos[0]}`);
      process.exit(2);
    }
    for (const p of renderLevelPreview(level, pos[2], { width: W, height: H, solution: sol })) console.log(p);
  }
  console.error(`rendered in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) await main();
