/**
 * Screen-space trackers: target brackets (with edge chevron when off-screen) and the
 * resonance-pulse reveal markers for every nebula. All positioning is transform-only.
 */
import * as THREE from 'three';
import { projectToScreen, smoothstep } from '../core/math';
import type { NebulaRuntime, SimState } from '../core/types';
import { formatDistance, formatDuration, formatYears, SECONDS_PER_YEAR, sci } from '../core/units';
import { ClassSlot, el, OpacitySlot, TextSlot, TransformSlot } from './dom';
import { trackRadius } from './format';

export interface Viewport {
  w: number;
  h: number;
  /** Edge margin for chevrons, CSS px. */
  margin: number;
  /** Horizontal space on the right taken by the codex panel (0 when closed). */
  rightInset: number;
}

interface EdgePos {
  x: number;
  y: number;
  angle: number;
  /** Self-relative anchor (%) so a label sits inward of the chevron. */
  ax: number;
  ay: number;
}

const _rel = new THREE.Vector3();

/**
 * Place a point on the inset viewport border in the direction of an (off-screen) projected
 * point. projectToScreen already mirrors behind-camera points so the direction reads as
 * "turn this way".
 */
function edgePlacement(sx: number, sy: number, vp: Viewport, out: EdgePos): void {
  const cx = vp.w * 0.5;
  const cy = vp.h * 0.5;
  let dx = sx - cx;
  let dy = sy - cy;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) {
    dx = 0;
    dy = 1;
  } else {
    dx /= len;
    dy /= len;
  }
  // Inset box; the right side also clears the codex panel when it is open.
  const halfX = dx > 0 ? vp.w - vp.margin - vp.rightInset - cx : cx - vp.margin;
  const halfY = cy - vp.margin;
  const s = Math.min(Math.max(halfX, 1) / Math.max(Math.abs(dx), 1e-9), Math.max(halfY, 1) / Math.max(Math.abs(dy), 1e-9));
  out.x = cx + dx * s;
  out.y = cy + dy * s;
  out.angle = Math.atan2(dy, dx);
  out.ax = -50 - 50 * dx;
  out.ay = -50 - 50 * dy;
}

const _edge: EdgePos = { x: 0, y: 0, angle: 0, ax: 0, ay: 0 };
const EMPTY = '—';

/** Target distance, or "—" when unknown / not yet measured (≤ 0, NaN). */
export function targetDistanceText(ly: number): string {
  return typeof ly === 'number' && Number.isFinite(ly) && ly > 0 ? formatDistance(ly) : EMPTY;
}

/** ETA, or "—" when not closing (Infinity) or invalid (NaN / null / negative); capped text. */
export function etaText(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return EMPTY;
  return seconds > 360000 ? '> 100 h' : formatDuration(seconds);
}

/**
 * Light travel time (years = distance in ly), or "—" when unknown. Under a day it reads in
 * h / min / s (formatYears alone would say "0.0 days" deep inside a nebula's core).
 */
export function lightTimeText(years: number): string {
  if (typeof years !== 'number' || !Number.isFinite(years) || years <= 0) return EMPTY;
  const s = years * SECONDS_PER_YEAR;
  if (s >= 86400) return formatYears(years);
  return s >= 0.1 ? formatDuration(s) : `${sci(s * 1000)} ms`;
}

const MIN_BRACKET_PX = 36;
/** Widest target label: `.tg-label` max-width (300) + padding + border, see flight.css. */
const LABEL_W = 312;
const CHEVRON_INSET = 20;

// ---------------------------------------------------------------------------------------------
// Target brackets
// ---------------------------------------------------------------------------------------------

export class TargetTracker {
  readonly root: HTMLElement;
  private readonly corners: HTMLElement[] = [];
  private readonly cornerMoves: TransformSlot[] = [];
  private readonly bracketFade: OpacitySlot;
  private readonly bracketLayer: HTMLElement;
  private readonly label: HTMLElement;
  private readonly labelMove: TransformSlot;
  private readonly name: TextSlot;
  private readonly kind: TextSlot;
  private readonly dist: TextSlot;
  private readonly eta: TextSlot;
  private readonly light: TextSlot;
  private readonly edge: HTMLElement;
  private readonly edgeMove: TransformSlot;
  private readonly edgeLabelMove: TransformSlot;
  private readonly edgeName: TextSlot;
  private readonly edgeDist: TextSlot;
  private readonly offscreen: ClassSlot;
  private readonly leftSide: ClassSlot;
  private id: string | null = null;
  private outTimer = 0;

  constructor(parent: HTMLElement) {
    const root = (this.root = el('div', 'fn-target', parent));
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');

    this.bracketLayer = el('div', 'tg-brackets', root);
    this.bracketFade = new OpacitySlot(this.bracketLayer);
    for (const c of ['tl', 'tr', 'bl', 'br']) {
      const corner = el('div', `tg-corner tg-${c}`, this.bracketLayer);
      el('i', '', corner);
      this.corners.push(corner);
      this.cornerMoves.push(new TransformSlot(corner));
    }

    const label = (this.label = el('div', 'tg-label', root));
    this.labelMove = new TransformSlot(label, 1);
    this.leftSide = new ClassSlot(label, 'is-left');
    const top = el('div', 'tg-top', label);
    el('span', 'tg-lock', top, 'Target locked');
    this.kind = new TextSlot(el('span', 'tg-kind', top));
    this.name = new TextSlot(el('div', 'tg-name', label));
    const grid = el('div', 'tg-grid', label);
    this.dist = this.row(grid, 'Distance');
    this.eta = this.row(grid, 'ETA');
    this.light = this.row(grid, 'Light-time');

    const edge = (this.edge = el('div', 'tg-edge', root));
    const chev = el('div', 'tg-chev', edge);
    this.edgeMove = new TransformSlot(chev);
    const elabel = el('div', 'tg-edge-label', edge);
    this.edgeLabelMove = new TransformSlot(elabel, 1);
    this.edgeName = new TextSlot(el('div', 'tg-edge-name', elabel));
    this.edgeDist = new TextSlot(el('div', 'tg-edge-dist mono', elabel));

    this.offscreen = new ClassSlot(root, 'is-offscreen');
  }

  get targetId(): string | null {
    return this.id;
  }

  lock(id: string, name: string, kind: string): void {
    window.clearTimeout(this.outTimer);
    const relock = this.id !== null && !this.root.classList.contains('is-out');
    if (id !== this.id) {
      // Never show the previous target's numbers under the new name (text refreshes at 15 Hz).
      this.dist.set(EMPTY);
      this.edgeDist.set('');
      this.eta.set(EMPTY);
      this.light.set(EMPTY);
    }
    this.id = id;
    this.name.set(name);
    this.edgeName.set(name);
    this.kind.set(kind);
    this.root.hidden = false;
    this.root.classList.remove('is-out');
    const dirs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    this.corners.forEach((c, i) => {
      const inner = c.firstElementChild as HTMLElement;
      const [dx, dy] = dirs[i];
      inner.animate(
        [
          { transform: `translate(${dx * 28}px,${dy * 28}px)`, opacity: 0 },
          { transform: `translate(${-dx * 3}px,${-dy * 3}px)`, opacity: 1, offset: 0.7 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: relock ? 380 : 620, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    });
    this.label.animate(
      [{ opacity: 0, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0)' }],
      { duration: 520, delay: relock ? 0 : 160, easing: 'ease-out', fill: 'backwards' },
    );
  }

  clear(): void {
    if (this.id === null) return;
    this.id = null;
    this.root.classList.add('is-out');
    window.clearTimeout(this.outTimer);
    this.outTimer = window.setTimeout(() => {
      if (this.id === null) this.root.hidden = true;
    }, 450);
  }

  dispose(): void {
    window.clearTimeout(this.outTimer);
  }

  update(state: SimState, rt: NebulaRuntime | undefined, cam: THREE.PerspectiveCamera, vp: Viewport, textTick: boolean): void {
    if (this.id === null || !rt) return;
    _rel.subVectors(rt.position, state.ship.position);
    const sp = projectToScreen(_rel, cam, vp.w, vp.h, trackRadius(rt));
    const valid = Number.isFinite(sp.x) && Number.isFinite(sp.y);
    const onScreen = valid && sp.onScreen;
    this.offscreen.set(!onScreen);

    if (onScreen) {
      const maxR = 0.44 * Math.min(vp.w, vp.h);
      const raw = Math.max(Number.isFinite(sp.radiusPx) ? sp.radiusPx : 0, MIN_BRACKET_PX);
      const r = Math.min(raw, maxR);
      // Brackets dissolve once the nebula fills the view; the label stays.
      this.bracketFade.set(1 - smoothstep(0.75 * maxR, 1.15 * maxR, raw));
      const x0 = Math.max(sp.x - r, 4);
      const x1 = Math.min(sp.x + r, vp.w - 4);
      const y0 = Math.max(sp.y - r, 4);
      const y1 = Math.min(sp.y + r, vp.h - 4);
      this.cornerMoves[0].move(x0, y0);
      this.cornerMoves[1].move(x1, y0);
      this.cornerMoves[2].move(x0, y1);
      this.cornerMoves[3].move(x1, y1);

      const rightLimit = vp.w - vp.margin - vp.rightInset;
      const left = sp.x + r + 16 + LABEL_W > rightLimit;
      this.leftSide.set(left);
      let lx = left ? sp.x - r - 16 : sp.x + r + 16;
      lx = left ? Math.max(lx, vp.margin + LABEL_W) : Math.min(lx, rightLimit - LABEL_W);
      // Keep clear of the location block (top-left) and the speed block (bottom).
      const ly = Math.min(Math.max(sp.y - r, vp.margin + Math.min(170, 0.13 * vp.h)), vp.h - vp.margin - 190);
      this.labelMove.moveAnchored(lx, ly, left ? -100 : 0, 0);
    } else {
      edgePlacement(sp.x, sp.y, vp, _edge);
      this.edgeMove.moveRotate(_edge.x, _edge.y, _edge.angle);
      const ix = _edge.x - Math.cos(_edge.angle) * CHEVRON_INSET;
      const iy = _edge.y - Math.sin(_edge.angle) * CHEVRON_INSET;
      this.edgeLabelMove.moveAnchored(ix, iy, _edge.ax, _edge.ay);
    }

    if (textTick) {
      const t = state.target;
      // Never trust the numbers blindly: a target the sim has not measured yet (distance 0),
      // a non-closing ETA (Infinity / NaN / null) or a NaN all read as "—".
      const d = t.id === this.id ? targetDistanceText(t.distance) : EMPTY;
      this.dist.set(d);
      this.edgeDist.set(d === EMPTY ? '' : d);
      this.eta.set(t.id === this.id ? etaText(t.eta) : EMPTY);
      this.light.set(t.id === this.id ? lightTimeText(t.lightYears) : EMPTY);
    }
  }

  private row(grid: HTMLElement, k: string): TextSlot {
    el('span', 'tg-k', grid, k);
    return new TextSlot(el('span', 'tg-v mono', grid), '—');
  }
}

// ---------------------------------------------------------------------------------------------
// Pulse reveal markers
// ---------------------------------------------------------------------------------------------

interface Marker {
  rt: NebulaRuntime;
  root: HTMLElement;
  move: TransformSlot;
  glyphMove: TransformSlot;
  labelMove: TransformSlot;
  dist: TextSlot;
  edge: ClassSlot;
  hidden: ClassSlot;
}

export class PulseMarkers {
  readonly root: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly fade: OpacitySlot;
  private markers: Marker[] = [];
  private active = false;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'fn-pulse-markers', parent);
    this.root.setAttribute('aria-hidden', 'true');
    this.root.hidden = true;
    this.inner = el('div', 'pm-inner', this.root);
    // Per-frame fade lives on the inner layer: the root carries a CSS opacity transition (wormhole
    // dimming) that would otherwise lag behind these writes and pop when the reveal ends.
    this.fade = new OpacitySlot(this.inner);
  }

  /** (Re)build the marker pool; called once when the runtimes are known. */
  bind(runtimes: NebulaRuntime[]): void {
    this.inner.replaceChildren();
    this.markers = runtimes.map((rt) => {
      const bh = rt.def.fractal === 'blackhole';
      const root = el('div', `pm${bh ? ' pm--bh' : ''}`, this.inner);
      const glyph = el('div', 'pm-glyph', root);
      el('i', '', glyph);
      const label = el('div', 'pm-label', root);
      el('div', 'pm-name', label, rt.def.name);
      const dist = new TextSlot(el('div', 'pm-dist mono', label), '');
      return {
        rt,
        root,
        move: new TransformSlot(root, 1),
        glyphMove: new TransformSlot(glyph),
        labelMove: new TransformSlot(label, 1),
        dist,
        edge: new ClassSlot(root, 'is-edge'),
        hidden: new ClassSlot(root, 'is-hidden'),
      };
    });
  }

  /** Staggered appearance, nearest first (as if the wave reached them in order). */
  reveal(): void {
    const order = this.markers.slice().sort((a, b) => a.rt.distance - b.rt.distance);
    order.forEach((m, i) => {
      m.root.animate(
        [{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }],
        { duration: 700, delay: 120 + i * 70, easing: 'ease-out', fill: 'backwards' },
      );
    });
  }

  update(state: SimState, cam: THREE.PerspectiveCamera, vp: Viewport, textTick: boolean, excludeId: string | null): void {
    const t = state.pulse.revealTime;
    const on = Number.isFinite(t) && t > 0;
    if (on !== this.active) {
      this.active = on;
      this.root.hidden = !on;
    }
    if (!on) return;
    this.fade.set(Math.min(1, t / 2));

    for (const m of this.markers) {
      const excluded = m.rt.def.id === excludeId;
      m.hidden.set(excluded);
      if (excluded) continue;
      _rel.subVectors(m.rt.position, state.ship.position);
      const sp = projectToScreen(_rel, cam, vp.w, vp.h, 0);
      if (!Number.isFinite(sp.x) || !Number.isFinite(sp.y)) {
        m.hidden.set(true);
        continue;
      }
      if (sp.onScreen) {
        if (m.edge.on) {
          m.glyphMove.reset();
          m.labelMove.reset();
        }
        m.edge.set(false);
        m.move.move(sp.x, sp.y);
      } else {
        m.edge.set(true);
        edgePlacement(sp.x, sp.y, vp, _edge);
        m.move.move(_edge.x, _edge.y);
        m.glyphMove.moveRotate(0, 0, _edge.angle);
        m.labelMove.moveAnchored(-Math.cos(_edge.angle) * CHEVRON_INSET, -Math.sin(_edge.angle) * CHEVRON_INSET, _edge.ax, _edge.ay);
      }
      if (textTick) m.dist.set(formatDistance(m.rt.distance));
    }
  }
}
