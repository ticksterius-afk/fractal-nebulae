/**
 * Start screen: title over the live attract-mode render, quality choice, shader-compile
 * progress and the LAUNCH button (also Enter).
 */
import type { QualityName } from '../core/types';
import { keyChips } from './controls';
import { el, markup, TextSlot, TransformSlot } from './dom';

const QUALITIES: { id: QualityName; name: string; desc: string }[] = [
  { id: 'low', name: 'Low', desc: 'Laptops & integrated graphics' },
  { id: 'medium', name: 'Medium', desc: 'Balanced · mid-range GPUs' },
  { id: 'high', name: 'High', desc: 'Soft shadows & occlusion · GTX 1080 class' },
  { id: 'ultra', name: 'Ultra', desc: 'Near-native resolution · high-end GPUs' },
];

const POEMS = [
  'Every cloud out here is an equation — and every equation is a place you can drift through.',
  'Somewhere between mathematics and light, the nebulae are breathing.',
  'Fall into any detail and you will find the whole again, waiting, a little smaller.',
];

const HEADPHONES_SVG = `
<svg class="st-ico" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M4 14v-2a8 8 0 0 1 16 0v2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="3" y="13.5" width="4" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <rect x="17" y="13.5" width="4" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/>
</svg>`;

const SUMMARY: { keys: string[]; text: string }[] = [
  { keys: ['MOUSE'], text: 'look' },
  { keys: ['W', 'A', 'S', 'D'], text: 'fly' },
  { keys: ['RMB'], text: 'hyper' },
  { keys: ['LMB'], text: 'target' },
  { keys: ['Space'], text: 'pulse · hold to glide' },
  { keys: ['T'], text: 'voyage' },
  { keys: ['Esc'], text: 'pause' },
];

export class StartScreen {
  readonly root: HTMLElement;
  private readonly bar: TransformSlot;
  private readonly label: TextSlot;
  private readonly pct: TextSlot;
  private readonly launchBtn: HTMLButtonElement;
  private readonly btnLabel: TextSlot;
  private readonly radios: HTMLInputElement[] = [];
  private quality: QualityName;
  private ready = false;
  private launched = false;
  private progress = 0;
  private hideTimer = 0;
  private readonly fsInput: HTMLInputElement;

  constructor(
    parent: HTMLElement,
    initialQuality: QualityName,
    private readonly onLaunch: (q: QualityName) => void,
    initialFullscreen = true,
    onFullscreen?: (on: boolean) => void,
  ) {
    // Settings come from localStorage: never trust the stored value to be a known preset.
    if (!QUALITIES.some((q) => q.id === initialQuality)) initialQuality = 'high';
    this.quality = initialQuality;
    const root = (this.root = el('section', 'fn-start', parent));
    root.setAttribute('aria-label', 'Fractal Nebulae');
    el('div', 'st-veil', root);

    const center = el('div', 'st-center', root);
    el('div', 'st-kicker', center, 'Gravity-drive observatory · catalogue of infinite structure');

    const title = el('h1', 'st-title', center);
    title.setAttribute('aria-label', 'Fractal Nebulae');
    const glow = el('span', 'st-title-glow', title, 'Fractal Nebulae');
    glow.setAttribute('aria-hidden', 'true');
    const text = el('span', 'st-title-text', title, 'Fractal Nebulae');
    text.setAttribute('aria-hidden', 'true');

    el('div', 'st-rule', center);
    el('p', 'st-sub', center, 'a voyage through infinite structure');
    el('p', 'st-poem', center, POEMS[Math.floor(Math.random() * POEMS.length)]);

    // Quality selector (segmented radio cards).
    const qWrap = el('div', 'st-quality', center);
    el('div', 'st-section-label', qWrap, 'Render quality');
    const seg = el('div', 'seg seg--cards', qWrap);
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Render quality');
    for (const q of QUALITIES) {
      const lab = el('label', 'seg-opt', seg);
      const input = el('input', '', lab);
      input.type = 'radio';
      input.name = 'fn-start-quality';
      input.value = q.id;
      input.checked = q.id === initialQuality;
      input.addEventListener('change', () => {
        if (input.checked) this.quality = q.id;
      });
      this.radios.push(input);
      const face = el('span', 'seg-face', lab);
      el('span', 'seg-name', face, q.name);
      el('span', 'seg-desc', face, q.desc);
    }

    // Loading + launch.
    const launchRow = el('div', 'st-launch-row', center);
    const load = el('div', 'st-load', launchRow);
    const track = el('div', 'st-load-track', load);
    const fill = el('div', 'st-load-fill', track);
    this.bar = new TransformSlot(fill);
    this.bar.scaleX(0);
    const lrow = el('div', 'st-load-label', load);
    this.label = new TextSlot(el('span', 'st-load-text', lrow), 'Igniting renderer…');
    this.pct = new TextSlot(el('span', 'st-load-pct mono', lrow), '0%');

    const btn = (this.launchBtn = el('button', 'st-launch btn-primary', launchRow));
    btn.type = 'button';
    btn.disabled = true;
    this.btnLabel = new TextSlot(el('span', 'st-launch-label', btn), 'Preparing');
    markup('<svg class="st-launch-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>', btn);
    btn.addEventListener('click', () => this.launch());
    el('div', 'st-enter', launchRow, 'or press Enter');

    // Full-screen preference: Launch enters full screen with it (F11 / Alt+Enter toggle any time).
    const fs = el('label', 'st-fs', launchRow);
    const fsInput = (this.fsInput = el('input', 'switch', fs));
    fsInput.type = 'checkbox';
    fsInput.setAttribute('role', 'switch');
    fsInput.checked = initialFullscreen;
    fsInput.addEventListener('change', () => onFullscreen?.(fsInput.checked));
    el('span', 'st-fs-label', fs, 'Full screen');

    // Footer: headphones + controls summary.
    const foot = el('footer', 'st-foot', root);
    const phones = el('div', 'st-phones', foot);
    markup(HEADPHONES_SVG, phones);
    el('span', '', phones, 'Headphones recommended · the score is generated live from each nebula');
    const sum = el('div', 'st-controls', foot);
    for (const s of SUMMARY) {
      const item = el('span', 'st-ctl', sum);
      keyChips(item, s.keys);
      el('span', 'st-ctl-t', item, s.text);
    }

    window.addEventListener('keydown', this.onKey);
  }

  get visible(): boolean {
    return !this.launched;
  }

  setProgress(p: number, label: string): void {
    if (this.launched) return;
    const v = Number.isFinite(p) ? Math.min(Math.max(p, 0), 1) : 0;
    // Never run backwards (several phases may report); the ready state pins it at 100 %.
    this.progress = this.ready ? 1 : Math.max(this.progress, v);
    this.bar.scaleX(this.progress);
    this.pct.set(`${Math.round(this.progress * 100)}%`);
    if (!this.ready && label) this.label.set(label.endsWith('…') || label.endsWith('.') ? label : `${label}…`);
  }

  setReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.progress = 1;
    this.bar.scaleX(1);
    this.pct.set('100%');
    this.label.set('All nebulae compiled · drive ready');
    this.root.classList.add('is-ready');
    this.launchBtn.disabled = false;
    this.btnLabel.set('Launch');
  }

  /** Loading failed (details are printed by main.ts): stop pretending to make progress. */
  setError(message: string): void {
    if (this.launched || this.ready) return;
    this.root.classList.add('is-error');
    this.label.set(message);
    this.pct.set('—');
    this.btnLabel.set('Unavailable');
  }

  hide(): void {
    if (this.root.classList.contains('is-out')) return;
    this.launched = true;
    window.removeEventListener('keydown', this.onKey);
    this.root.classList.add('is-out');
    // Remove from layout/compositing once the exit transition is done.
    this.hideTimer = window.setTimeout(() => {
      this.root.hidden = true;
    }, 1400);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.clearTimeout(this.hideTimer);
    this.root.remove();
  }

  /** Reflect the full-screen preference (e.g. changed with F11 / Alt+Enter before launch). */
  setFullscreen(on: boolean): void {
    this.fsInput.checked = on;
  }

  private launch(): void {
    if (!this.ready || this.launched) return;
    this.launched = true;
    const checked = this.radios.find((r) => r.checked);
    const q = (checked?.value as QualityName | undefined) ?? this.quality;
    this.onLaunch(q);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' || e.repeat || e.altKey) return; // Alt+Enter = full screen
    // A focused button handles Enter itself (click) — avoid a double launch.
    if (e.target instanceof HTMLButtonElement) return;
    if (!this.ready || this.launched) return;
    e.preventDefault();
    this.launch();
  };
}
