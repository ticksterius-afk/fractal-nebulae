/**
 * Pause overlay: dims and blurs the scene, Resume button, live settings, full controls table.
 * Every settings change is reported immediately through onChange.
 */
import type { AppSettings, QualityName } from '../core/types';
import { controlsList } from './controls';
import { el, TextSlot } from './dom';

const QUALITY_OPTIONS: { id: QualityName; name: string }[] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'ultra', name: 'Ultra' },
];

interface RangeSpec {
  key: 'musicVolume' | 'sfxVolume' | 'mouseSensitivity' | 'fovDeg';
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

const RANGES: RangeSpec[] = [
  { key: 'musicVolume', label: 'Music volume', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'sfxVolume', label: 'Effects volume', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'mouseSensitivity', label: 'Mouse sensitivity', min: 0.2, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
  { key: 'fovDeg', label: 'Field of view', min: 60, max: 100, step: 1, format: (v) => `${Math.round(v)}°` },
];

/** Input types without an Enter behaviour of their own. */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio']);

/** Pointer re-capture status shown on the card (App drives it). */
export type ResumeState = 'idle' | 'pending' | 'failed';

const RESUME_TEXT: Record<ResumeState, string> = {
  idle: '',
  pending: 'Engaging the drive…',
  failed: 'The browser did not capture the mouse · click Resume or press Enter to try again',
};

interface RangeCtl {
  spec: RangeSpec;
  input: HTMLInputElement;
  value: TextSlot;
}

export class PauseScreen {
  readonly root: HTMLElement;
  private settings: AppSettings;
  private readonly qualityRadios: HTMLInputElement[] = [];
  private readonly ranges: RangeCtl[] = [];
  private readonly invertY: HTMLInputElement;
  private readonly showHints: HTMLInputElement;
  private readonly fullscreen: HTMLInputElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly status: TextSlot;
  private shown = false;
  private hideTimer = 0;

  constructor(
    parent: HTMLElement,
    settings: AppSettings,
    private readonly onResume: () => void,
    private readonly onChange: (s: AppSettings) => void,
  ) {
    this.settings = { ...settings };
    const root = (this.root = el('section', 'fn-pause', parent));
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Paused');

    const card = el('div', 'ps-card glass', root);
    const head = el('header', 'ps-head', card);
    const titles = el('div', 'ps-titles', head);
    el('div', 'ps-kicker', titles, 'Drive holding position');
    el('h2', 'ps-title', titles, 'Paused');
    el('p', 'ps-sub', titles, 'The nebulae will wait. Adjust anything below — changes apply instantly.');
    this.statusEl = el('p', 'ps-status', titles);
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');
    this.status = new TextSlot(this.statusEl);

    const btn = (this.resumeBtn = el('button', 'ps-resume btn-primary', head));
    btn.type = 'button';
    el('span', '', btn, 'Resume');
    el('span', 'ps-resume-hint', btn, 'Enter');
    btn.addEventListener('click', () => this.onResume());

    const body = el('div', 'ps-body', card);

    // ---- settings column ----
    const set = el('div', 'ps-col ps-settings', body);
    el('div', 'ps-col-title', set, 'Settings');

    const qRow = el('div', 'ps-row ps-row--stack', set);
    el('span', 'ps-label', qRow, 'Render quality');
    const seg = el('div', 'seg seg--compact', qRow);
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Render quality');
    for (const q of QUALITY_OPTIONS) {
      const lab = el('label', 'seg-opt', seg);
      const input = el('input', '', lab);
      input.type = 'radio';
      input.name = 'fn-pause-quality';
      input.value = q.id;
      input.checked = q.id === this.settings.quality;
      input.addEventListener('change', () => {
        if (input.checked) this.emit({ ...this.settings, quality: q.id });
      });
      this.qualityRadios.push(input);
      const face = el('span', 'seg-face', lab);
      el('span', 'seg-name', face, q.name);
    }
    el('span', 'ps-note', qRow, 'Applies instantly · nebulae may take a moment to recompile');

    for (const spec of RANGES) {
      const row = el('label', 'ps-row', set);
      el('span', 'ps-label', row, spec.label);
      const input = el('input', 'range', row);
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      const value = new TextSlot(el('span', 'ps-value mono', row));
      const ctl: RangeCtl = { spec, input, value };
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        this.paintRange(ctl, v);
        this.emit({ ...this.settings, [spec.key]: v });
      });
      this.ranges.push(ctl);
    }

    this.invertY = this.toggleRow(set, 'Invert mouse Y', (on) => this.emit({ ...this.settings, invertY: on }));
    this.showHints = this.toggleRow(set, 'Show control hints', (on) => this.emit({ ...this.settings, showHints: on }));
    this.fullscreen = this.toggleRow(set, 'Full screen', (on) => this.emit({ ...this.settings, fullscreen: on }));

    // ---- controls column ----
    const ctl = el('div', 'ps-col ps-controls', body);
    el('div', 'ps-col-title', ctl, 'Controls');
    controlsList(ctl, false);

    el('footer', 'ps-foot', card, 'Mouse released · Resume re-engages the drive');

    this.sync(this.settings);
    window.addEventListener('keydown', this.onKey);
  }

  get visible(): boolean {
    return this.shown;
  }

  show(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    window.clearTimeout(this.hideTimer);
    this.setResumeState('idle');
    if (on) {
      this.root.hidden = false;
      // Next frame so the opening transition runs from the hidden state.
      requestAnimationFrame(() => {
        if (!this.shown) return;
        this.root.classList.add('is-open');
        this.resumeBtn.focus({ preventScroll: true });
      });
    } else {
      this.root.classList.remove('is-open');
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
      this.hideTimer = window.setTimeout(() => {
        if (!this.shown) this.root.hidden = true;
      }, 500);
    }
  }

  /** Pending / refused pointer re-capture feedback (cleared whenever the card opens or closes). */
  setResumeState(state: ResumeState): void {
    this.status.set(RESUME_TEXT[state]);
    this.statusEl.setAttribute('data-state', state);
    this.resumeBtn.setAttribute('aria-busy', state === 'pending' ? 'true' : 'false');
  }

  /** Reflect externally-changed settings in the controls (no change events fired). */
  sync(s: AppSettings): void {
    this.settings = { ...s };
    for (const r of this.qualityRadios) r.checked = r.value === s.quality;
    for (const ctl of this.ranges) {
      const v = s[ctl.spec.key];
      const safe = Number.isFinite(v) ? v : ctl.spec.min;
      ctl.input.value = String(safe);
      this.paintRange(ctl, safe);
    }
    this.invertY.checked = s.invertY;
    this.showHints.checked = s.showHints;
    this.fullscreen.checked = s.fullscreen;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.clearTimeout(this.hideTimer);
    this.root.remove();
  }

  private emit(next: AppSettings): void {
    this.settings = next;
    this.onChange({ ...next });
  }

  private paintRange(ctl: RangeCtl, v: number): void {
    const { min, max } = ctl.spec;
    const p = max > min ? (Math.min(Math.max(v, min), max) - min) / (max - min) : 0;
    ctl.input.style.setProperty('--p', `${(p * 100).toFixed(1)}%`);
    ctl.value.set(ctl.spec.format(v));
  }

  private toggleRow(parent: HTMLElement, label: string, onToggle: (on: boolean) => void): HTMLInputElement {
    const row = el('label', 'ps-row', parent);
    el('span', 'ps-label', row, label);
    const input = el('input', 'switch', row);
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.addEventListener('change', () => onToggle(input.checked));
    el('span', 'ps-value', row);
    return input;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.shown || e.key !== 'Enter' || e.repeat || e.altKey) return; // Alt+Enter = full screen
    const t = e.target;
    // Buttons handle Enter themselves (click). Every control on this card is a button, radio,
    // range or checkbox — none of which uses Enter — so Enter resumes even right after a slider
    // was dragged (focus stays on it); only text-entry fields would keep it.
    if (t instanceof HTMLButtonElement || t instanceof HTMLSelectElement) return;
    if (t instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(t.type)) return;
    e.preventDefault();
    this.onResume();
  };
}
