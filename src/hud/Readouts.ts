/**
 * Text instruments: location (top-left), speed (bottom-centre), environment (bottom-left),
 * wormhole transit overlay and the faint perf readout. Text is refreshed only on "text ticks"
 * (~15 Hz) and only when it changes; a few bars/opacities move per frame via transforms.
 */
import type { NebulaRuntime, SimState } from '../core/types';
import { formatDistance, formatSpeed } from '../core/units';
import { ClassSlot, el, OpacitySlot, TextSlot, TransformSlot } from './dom';
import { fmtAccel, fmtDilation, fmtPercent, fmtThrottle, fmtZoom, nebulaTypeLine } from './format';

const THROTTLE_MIN = 0.05;
const THROTTLE_MAX = 4;
const LOG_THR_MIN = Math.log(THROTTLE_MIN);
const LOG_THR_SPAN = Math.log(THROTTLE_MAX) - LOG_THR_MIN;
/** Zoom-depth bar spans this many decades of magnification. */
const ZOOM_DECADES = 8;
/**
 * The sim suspends the gentle nebula drift while thrusting, so env.gravity blinks to 0 on every
 * key press. Keep showing the last pull this long (s of sim time) so the row doesn't flicker.
 */
const GRAVITY_HOLD_S = 4;

export function zoomDepth(rt: NebulaRuntime | null | undefined, surfaceDistance: number): number {
  if (!rt || !rt.fractal) return NaN;
  const s = Math.max(surfaceDistance, 1e-15);
  if (!Number.isFinite(s)) return NaN;
  return Math.log10(rt.def.worldRadius / s);
}

// ---------------------------------------------------------------------------------------------

export class LocationBlock {
  readonly root: HTMLElement;
  private readonly kicker: TextSlot;
  private readonly name: TextSlot;
  private readonly type: TextSlot;
  private readonly surfaceK: TextSlot;
  private readonly surface: TextSlot;
  private readonly zoomRow: ClassSlot;
  private readonly zoomFill: TransformSlot;
  private readonly zoomVal: TextSlot;
  private readonly inRegion: ClassSlot;
  private lastRegion: string | null | undefined = undefined;
  private lastNearest: string | null | undefined = undefined;

  constructor(parent: HTMLElement) {
    const root = (this.root = el('div', 'fn-loc hud-block', parent));
    this.inRegion = new ClassSlot(root, 'is-region');
    this.kicker = new TextSlot(el('div', 'loc-kicker', root), 'Deep space');
    this.name = new TextSlot(el('div', 'loc-name', root), 'Interstellar Void');
    this.type = new TextSlot(el('div', 'loc-type', root), '');

    const s = el('div', 'loc-row', root);
    this.surfaceK = new TextSlot(el('span', 'loc-k', s), 'Surface');
    this.surface = new TextSlot(el('span', 'loc-v mono', s), '—');

    const z = el('div', 'loc-row loc-zoom', root);
    this.zoomRow = new ClassSlot(z, 'is-off');
    el('span', 'loc-k', z, 'Zoom');
    const track = el('span', 'loc-ztrack', z);
    for (let i = 1; i < ZOOM_DECADES; i++) {
      const tick = el('i', 'loc-ztick', track);
      tick.style.left = `${(i / ZOOM_DECADES) * 100}%`;
    }
    this.zoomFill = new TransformSlot(el('span', 'loc-zfill', track));
    this.zoomFill.scaleX(0);
    this.zoomVal = new TextSlot(el('span', 'loc-v mono', z), '—');
  }

  update(state: SimState, region: NebulaRuntime | null, nearest: NebulaRuntime | null): void {
    const env = state.env;
    const regionId = region ? region.def.id : null;
    const nearestId = nearest ? nearest.def.id : null;
    if (regionId !== this.lastRegion || (!region && nearestId !== this.lastNearest)) {
      this.lastRegion = regionId;
      this.lastNearest = nearestId;
      this.inRegion.set(region !== null);
      if (region) {
        this.kicker.set(`${region.def.catalog} · region`);
        this.name.set(region.def.name);
        this.type.set(nebulaTypeLine(region.def, region));
      } else {
        this.kicker.set('Deep space');
        this.name.set('Interstellar Void');
        this.type.set(nearest ? `Nearest · ${nearest.def.name}` : '');
      }
    }

    const bh = region?.def.blackHole;
    this.surfaceK.set(bh ? 'Horizon' : 'Surface');
    if (bh && region) {
      const x = region.distance / Math.max(bh.rs, 1e-12);
      this.surface.set(`r = ${x < 100 ? x.toFixed(2) : Math.round(x)} rₛ`);
    } else {
      this.surface.set(formatDistance(env.surfaceDistance));
    }

    const depth = zoomDepth(nearest, env.surfaceDistance);
    const showZoom = Number.isFinite(depth) && depth > -0.3;
    this.zoomRow.set(!showZoom);
    if (showZoom) {
      this.zoomFill.scaleX(Math.max(0, depth) / ZOOM_DECADES);
      this.zoomVal.set(fmtZoom(Math.max(0, depth)));
    }
  }
}

// ---------------------------------------------------------------------------------------------

export class SpeedBlock {
  readonly root: HTMLElement;
  private readonly value: TextSlot;
  private readonly unit: TextSlot;
  private readonly c: TextSlot;
  private readonly mph: TextSlot;
  private readonly au: TextSlot;
  private readonly thrFill: TransformSlot;
  private readonly thrVal: TextSlot;
  private readonly precision: ClassSlot;
  private readonly hyperEl: HTMLElement;
  private readonly hyperFade: OpacitySlot;
  private readonly hyperOn: ClassSlot;
  private readonly beta: TextSlot;
  private readonly ghostFade: OpacitySlot;
  private readonly ghostText: TextSlot;
  private readonly ghostIn: ClassSlot;
  private readonly chip: HTMLElement;
  private readonly chipOn: ClassSlot;
  private readonly chipText: TextSlot;
  private lastPilot = '';
  private lastPilotTarget: string | null = null;
  private lastOrbit = false;

  constructor(parent: HTMLElement) {
    const root = (this.root = el('div', 'fn-speed hud-block', parent));

    const hyper = (this.hyperEl = el('div', 'sp-hyper', root));
    this.hyperFade = new OpacitySlot(hyper);
    this.hyperFade.set(0);
    this.hyperOn = new ClassSlot(hyper, 'is-on');
    this.chevrons(hyper, 'sp-chev sp-chev--l');
    const ht = el('span', 'sp-hyper-t', hyper);
    el('span', '', ht, 'Hyper');
    this.beta = new TextSlot(el('span', 'sp-beta mono', ht), '');
    this.chevrons(hyper, 'sp-chev sp-chev--r');

    // Ghost mode (right mouse): collisions off; brighter while phasing through a solid.
    const ghost = el('div', 'sp-ghost', root);
    this.ghostFade = new OpacitySlot(ghost);
    this.ghostFade.set(0);
    this.ghostIn = new ClassSlot(ghost, 'is-inside');
    el('span', 'sp-ghost-k', ghost, 'Ghost');
    this.ghostText = new TextSlot(el('span', 'sp-ghost-t', ghost), 'collisions off');

    const main = el('div', 'sp-main', root);
    this.value = new TextSlot(el('span', 'sp-value mono', main), '0');
    this.unit = new TextSlot(el('span', 'sp-unit', main), 'km/s');

    const sub = el('div', 'sp-sub mono', root);
    this.c = new TextSlot(el('span', '', sub), '');
    el('span', 'sp-dot', sub, '·');
    this.mph = new TextSlot(el('span', '', sub), '');
    el('span', 'sp-dot', sub, '·');
    this.au = new TextSlot(el('span', '', sub), '');

    const thr = el('div', 'sp-thr', root);
    el('span', 'sp-k', thr, 'Throttle');
    const track = el('span', 'sp-thr-track', thr);
    const one = el('i', 'sp-thr-one', track);
    one.style.left = `${((Math.log(1) - LOG_THR_MIN) / LOG_THR_SPAN) * 100}%`;
    this.thrFill = new TransformSlot(el('span', 'sp-thr-fill', track));
    this.thrVal = new TextSlot(el('span', 'sp-v mono', thr), '×1.00');
    const prec = el('span', 'sp-prec', thr, 'Precision');
    this.precision = new ClassSlot(prec, 'is-on');

    const chip = (this.chip = el('div', 'sp-chip', root));
    this.chipOn = new ClassSlot(chip, 'is-on');
    el('i', 'sp-chip-dot', chip);
    this.chipText = new TextSlot(el('span', '', chip), '');
  }

  /** Per frame (cheap): hyper indicator brightness. */
  frame(state: SimState): void {
    const h = state.ship.hyper;
    this.hyperFade.set(Number.isFinite(h) ? Math.min(1, h * 1.15) : 0);
    this.hyperOn.set(h > 0.01);
    const g = state.ship.ghost;
    const gi = state.ship.ghostInside;
    this.ghostFade.set(Number.isFinite(g) ? Math.min(1, g * 1.2) : 0);
    const inside = Number.isFinite(gi) && gi > 0.5;
    this.ghostIn.set(inside);
    this.ghostText.set(inside ? 'phasing through structure' : 'collisions off');
  }

  /**
   * `orbiting`: the target glide has arrived and is circling the nebula. `glideId`: the glide's
   * destination (defaults to the locked target).
   */
  text(
    state: SimState,
    nameOf: (id: string | null) => string | null,
    orbiting: boolean,
    glideId: string | null = state.target.id,
  ): void {
    const ship = state.ship;
    const r = formatSpeed(Number.isFinite(ship.speed) ? Math.max(ship.speed, 0) : 0);
    this.value.set(r.primaryValue);
    this.unit.set(r.primaryUnit);
    this.c.set(r.c);
    this.mph.set(r.mph);
    this.au.set(r.auPerS);

    const thr = Number.isFinite(ship.throttle) ? ship.throttle : 1;
    this.thrFill.scaleX((Math.log(Math.min(Math.max(thr, THROTTLE_MIN), THROTTLE_MAX)) - LOG_THR_MIN) / LOG_THR_SPAN);
    this.thrVal.set(fmtThrottle(thr));
    this.precision.set(ship.precision);
    this.beta.set(ship.betaVis > 0.01 ? `β ${ship.betaVis.toFixed(2)}` : '');

    const mode = state.wormhole.active ? 'off' : ship.autopilot;
    const tid = mode === 'target' ? glideId : null;
    const orbit = mode === 'target' && orbiting;
    if (mode !== this.lastPilot || tid !== this.lastPilotTarget || orbit !== this.lastOrbit) {
      this.lastPilot = mode;
      this.lastPilotTarget = tid;
      this.lastOrbit = orbit;
      this.chipOn.set(mode !== 'off');
      this.chip.classList.toggle('is-voyage', mode === 'voyage');
      const name = nameOf(tid) ?? 'target';
      if (orbit) this.chipText.set(`Orbit · ${name} · move to take over`);
      else if (mode === 'target') this.chipText.set(`Gravity-glide → ${name}`);
      else if (mode === 'voyage') this.chipText.set('Voyage · zen tour · T to exit');
    }
  }

  private chevrons(parent: HTMLElement, cls: string): void {
    const c = el('span', cls, parent);
    for (let i = 0; i < 3; i++) el('i', '', c);
  }
}

// ---------------------------------------------------------------------------------------------

interface EnvRow {
  root: HTMLElement;
  off: ClassSlot;
  value: TextSlot;
  sub?: TextSlot;
  bar?: TransformSlot;
}

export class EnvBlock {
  readonly root: HTMLElement;
  private readonly gravity: EnvRow;
  private readonly dilation: EnvRow;
  private readonly tidal: EnvRow;
  private readonly tidalWarn: ClassSlot;
  private readonly tidalDanger: ClassSlot;
  private readonly wormhole: EnvRow;
  private gLast = 0;
  private gSource: string | null = null;
  private gUntil = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'fn-env hud-block', parent);
    this.gravity = this.row('Gravity', true, false);
    this.dilation = this.row('Time dilation', false, false);
    this.tidal = this.row('Tidal stress', false, true);
    this.tidal.root.classList.add('env-row--tidal');
    this.tidalWarn = new ClassSlot(this.tidal.root, 'is-warn');
    this.tidalDanger = new ClassSlot(this.tidal.root, 'is-danger');
    this.wormhole = this.row('Wormhole transit', false, true);
    this.wormhole.root.classList.add('env-row--wormhole');
  }

  update(state: SimState, nameOf: (id: string | null) => string | null): void {
    const env = state.env;
    const w = state.wormhole;

    const gSource = env.blackHoleId ?? env.regionId;
    const gNow = !w.active && gSource !== null && Number.isFinite(env.gravity) && env.gravity > 1e-15 ? env.gravity : 0;
    if (gNow > 0) {
      this.gLast = gNow;
      this.gSource = gSource;
      this.gUntil = state.time + GRAVITY_HOLD_S;
    } else if (w.active || gSource !== this.gSource) {
      this.gUntil = -1;
    }
    const showG = this.gUntil >= state.time && this.gLast > 0;
    this.gravity.off.set(!showG);
    if (showG) {
      this.gravity.value.set(fmtAccel(this.gLast));
      this.gravity.sub?.set(`pull of ${nameOf(this.gSource) ?? 'the nebula'}`);
    }

    const td = env.timeDilation;
    const showTd = !w.active && Number.isFinite(td) && td < 0.995;
    this.dilation.off.set(!showTd);
    if (showTd) this.dilation.value.set(fmtDilation(td));

    const tidal = Number.isFinite(env.tidal) ? env.tidal : 0;
    const showTidal = !w.active && tidal > 0.02;
    this.tidal.off.set(!showTidal);
    if (showTidal) {
      this.tidal.value.set(fmtPercent(tidal));
      this.tidal.bar?.scaleX(tidal);
      this.tidalWarn.set(tidal > 0.35);
      this.tidalDanger.set(tidal > 0.7);
    }

    this.wormhole.off.set(!w.active);
    if (w.active) {
      this.wormhole.value.set(fmtPercent(w.progress));
      this.wormhole.bar?.scaleX(w.progress);
    }
  }

  private row(label: string, withSub: boolean, withBar: boolean): EnvRow {
    const root = el('div', 'env-row is-off', this.root);
    const head = el('div', 'env-head', root);
    el('span', 'env-k', head, label);
    const value = new TextSlot(el('span', 'env-v mono', head), '');
    const row: EnvRow = { root, off: new ClassSlot(root, 'is-off'), value };
    row.off.set(true);
    if (withSub) row.sub = new TextSlot(el('div', 'env-sub', root), '');
    if (withBar) {
      const track = el('div', 'env-track', root);
      row.bar = new TransformSlot(el('div', 'env-fill', track));
      row.bar.scaleX(0);
    }
    return row;
  }
}

// ---------------------------------------------------------------------------------------------

export class WormholeOverlay {
  readonly root: HTMLElement;
  private readonly on: ClassSlot;
  private readonly dest: TextSlot;
  private readonly fill: TransformSlot;
  private readonly pct: TextSlot;

  constructor(parent: HTMLElement) {
    const root = (this.root = el('div', 'fn-wormhole', parent));
    root.setAttribute('aria-hidden', 'true');
    this.on = new ClassSlot(root, 'is-on');
    el('div', 'wh-kicker', root, 'Einstein–Rosen bridge');
    this.dest = new TextSlot(el('div', 'wh-dest', root), '');
    const track = el('div', 'wh-track', root);
    this.fill = new TransformSlot(el('div', 'wh-fill', track));
    this.fill.scaleX(0);
    this.pct = new TextSlot(el('div', 'wh-pct mono', root), '');
  }

  frame(state: SimState): void {
    const w = state.wormhole;
    // Fade out just before the exit flash so the white-out stays clean.
    const on = w.active && w.progress < 0.93;
    this.on.set(on);
    if (on) this.fill.scaleX(w.progress);
  }

  text(state: SimState, nameOf: (id: string | null) => string | null): void {
    const w = state.wormhole;
    if (!w.active) return;
    this.dest.set(`→ ${nameOf(w.toId) ?? 'unknown space'}`);
    this.pct.set(w.progress < 0.5 ? 'folding space' : 'emerging');
  }
}

// ---------------------------------------------------------------------------------------------

export class PerfReadout {
  readonly root: HTMLElement;
  private readonly text: TextSlot;
  private acc = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'fn-perf mono', parent);
    this.root.setAttribute('aria-hidden', 'true');
    this.text = new TextSlot(this.root, '');
  }

  update(dt: number, stats: { fps: number; renderScale: number }): void {
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    const fps = Number.isFinite(stats.fps) ? Math.round(stats.fps) : 0;
    const rs = Number.isFinite(stats.renderScale) ? Math.round(stats.renderScale * 100) : 0;
    this.text.set(`${fps} fps · ${rs}% res`);
  }
}
