/**
 * Centre reticle: a tiny dot and two thin arcs that spread with hyper, a subtle pulse on
 * click, and expanding rings when a resonance pulse is fired.
 */
import { el, markup, OpacitySlot } from './dom';

// Both arcs live on a circle of radius 12 centred in a 32×32 box that overlays the dot.
const ARC_L = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M 8.29 6.81 A 12 12 0 0 0 8.29 25.19" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
const ARC_R = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M 23.71 6.81 A 12 12 0 0 1 23.71 25.19" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;

export class Reticle {
  readonly root: HTMLElement;
  private readonly core: HTMLElement;
  private readonly arcL: HTMLElement;
  private readonly arcR: HTMLElement;
  private readonly halo: OpacitySlot;
  private readonly haloEl: HTMLElement;
  private readonly rings: HTMLElement[] = [];
  private lastHyper = -1;

  constructor(parent: HTMLElement) {
    const root = (this.root = el('div', 'fn-reticle', parent));
    root.setAttribute('aria-hidden', 'true');
    const core = (this.core = el('div', 'ret-core', root));
    el('div', 'ret-dot', core);
    this.arcL = el('div', 'ret-arc ret-arc--l', core);
    markup(ARC_L, this.arcL);
    this.arcR = el('div', 'ret-arc ret-arc--r', core);
    markup(ARC_R, this.arcR);
    this.haloEl = el('div', 'ret-halo', core);
    this.halo = new OpacitySlot(this.haloEl);
    this.halo.set(0);
    for (let i = 0; i < 2; i++) this.rings.push(el('div', 'ret-ring', root));
  }

  /** Per frame; cheap when unchanged. */
  setHyper(h: number): void {
    const v = Number.isFinite(h) ? Math.min(Math.max(h, 0), 1) : 0;
    if (Math.abs(v - this.lastHyper) < 0.003 && v !== 0 && v !== 1) return;
    if (v === this.lastHyper) return;
    this.lastHyper = v;
    const spread = (v * 11).toFixed(2);
    const s = (1 + 0.22 * v).toFixed(3);
    this.arcL.style.transform = `translate3d(-${spread}px,0,0) scale(${s})`;
    this.arcR.style.transform = `translate3d(${spread}px,0,0) scale(${s})`;
    this.haloEl.style.transform = `translate(-50%,-50%) scale(${(0.8 + 0.5 * v).toFixed(3)})`;
    this.halo.set(v * 0.55);
  }

  clickPulse(): void {
    this.core.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.35)', offset: 0.3 }, { transform: 'scale(1)' }],
      { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }

  pulseRings(): void {
    this.rings.forEach((ring, i) => {
      ring.animate(
        [
          { transform: 'translate(-50%,-50%) scale(0.04)', opacity: 0 },
          { transform: 'translate(-50%,-50%) scale(0.12)', opacity: 0.85, offset: 0.08 },
          { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 },
        ],
        { duration: 2200 + i * 500, delay: i * 220, easing: 'cubic-bezier(.12,.7,.3,1)', fill: 'backwards' },
      );
    });
  }
}
