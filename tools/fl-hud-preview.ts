/**
 * Dev preview for the First Light HUD (WP H, design/60-first-light-build.md §H).
 *
 * Mounts FirstLightHud exactly as the mode will (inside a `.fn-flight` in-flight layer, next to
 * the real Voyage reticle) over a painted nebula backdrop, feeds it mock view-models every frame
 * (setPlay runs per frame, as in the game) and offers a dev panel to cycle the states.
 *
 *   Vite dev server → http://localhost:5190/tools/fl-hud-preview.html   (?s=<state> jumps to a state)
 *
 * Keys while playing (mode stand-ins): 1/2/3 size · Tab lab ⇄ flight · Z / Shift+Z undo / redo ·
 * ? hint · C clear · ` toggles the dev panel. The panel shows DOM mutations per frame
 * (MutationObserver on the HUD layer): steady state must read 0.
 * Not part of the production build (only index.html is an entry).
 */
import '@fontsource/rajdhani/300.css';
import '@fontsource/rajdhani/400.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/inter/wght-italic.css';
import '../src/styles/base.css';
import '../src/styles/flight.css';
import '../src/styles/panels.css';

import { el } from '../src/hud/dom';
import { Reticle } from '../src/hud/Reticle';
import { FirstLightHud } from '../src/game/firstlight/hud/FirstLightHud';
import type {
  AtlasChapter,
  AtlasModel,
  FirstLightHudCallbacks,
  LevelHeader,
  PlayHudState,
  SolvedCard,
} from '../src/game/firstlight/hud/hudTypes';
import type { MassSize } from '../src/game/firstlight/types';

// ---------------------------------------------------------------------------------------------
// Backdrop: a painted stand-in for the raymarched nebula (so the glass and legibility read true)
// ---------------------------------------------------------------------------------------------

function paintBackdrop(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block';
  const g = canvas.getContext('2d');
  if (!g) return;
  g.scale(dpr, dpr);
  g.fillStyle = '#02040a';
  g.fillRect(0, 0, w, h);
  const blob = (x: number, y: number, r: number, c: string): void => {
    const grad = g.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * Math.max(w, h));
    grad.addColorStop(0, c);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  };
  g.globalCompositeOperation = 'lighter';
  blob(0.62, 0.42, 0.42, 'rgba(40, 90, 120, 0.55)'); // OIII teal
  blob(0.3, 0.62, 0.36, 'rgba(150, 70, 40, 0.42)'); // Hα / SII
  blob(0.75, 0.7, 0.3, 'rgba(110, 50, 90, 0.35)');
  blob(0.48, 0.3, 0.22, 'rgba(200, 160, 110, 0.25)');
  blob(0.2, 0.25, 0.25, 'rgba(30, 60, 110, 0.4)');
  // A dusty pillar silhouette with a lit rim.
  g.globalCompositeOperation = 'source-over';
  const pillar = g.createLinearGradient(0, h, 0, h * 0.35);
  pillar.addColorStop(0, 'rgba(8, 6, 10, 0.95)');
  pillar.addColorStop(1, 'rgba(8, 6, 10, 0)');
  g.fillStyle = pillar;
  g.beginPath();
  g.moveTo(w * 0.38, h);
  g.bezierCurveTo(w * 0.4, h * 0.7, w * 0.47, h * 0.5, w * 0.5, h * 0.4);
  g.bezierCurveTo(w * 0.54, h * 0.5, w * 0.58, h * 0.72, w * 0.6, h);
  g.fill();
  // Stars.
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 900; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const m = rnd() ** 6;
    g.fillStyle = `rgba(${200 + rnd() * 55 | 0}, ${215 + rnd() * 40 | 0}, 255, ${0.25 + m * 0.75})`;
    g.fillRect(x, y, 0.8 + m * 1.6, 0.8 + m * 1.6);
  }
}

const bg = document.getElementById('bg') as HTMLCanvasElement;
paintBackdrop(bg);
window.addEventListener('resize', () => paintBackdrop(bg));

// ---------------------------------------------------------------------------------------------
// HUD mount (the same structure Hud.ts builds: .fn-hud > .fn-flight.is-live > mode layer)
// ---------------------------------------------------------------------------------------------

const hudRoot = document.getElementById('hud-root') as HTMLElement;
hudRoot.classList.add('fn-hud');
const flight = el('div', 'fn-flight is-live', hudRoot);
new Reticle(flight);
const layer = el('div', 'fn-mode-layer', flight);
layer.style.cssText = 'position:absolute;inset:0;pointer-events:none';

// ---------------------------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------------------------

const NAMES: Record<string, string[]> = {
  bend: ['Almost', 'Two Florets', 'Around', 'Swallowed', 'The Long Way', 'Eclipse'],
  thread: ['First Tunnel', 'Two Tunnels', 'Lattice', 'Corridor', 'Deeper', 'Ninefold'],
  reflect: ['Pearl', 'Corner', 'Ricochet', 'Two Pearls', 'Glass Garden', 'Halo'],
  echo: ['Relay', 'Order', 'Four Rooms', 'Chain', 'Backwards', 'Pyramid'],
};
const CHAPTERS: { id: string; name: string; nebula: string; rule: string }[] = [
  { id: 'bend', name: 'Bend', nebula: 'The Cauliflower Nebula', rule: 'A mass bends light toward itself; closer bends harder, too close swallows it.' },
  { id: 'thread', name: 'Thread', nebula: 'The Menger Lattice', rule: 'Line of sight through tunnels: two lenses in series.' },
  { id: 'reflect', name: 'Reflect', nebula: 'The Pearl Foam', rule: 'Pearls reflect; each bounce keeps seven tenths of the light.' },
  { id: 'echo', name: 'Echo', nebula: "Sierpiński's Pyramid", rule: 'Echo seeds relay the beam: which one first?' },
];

type Progress = 'first' | 'returning' | 'locked';

function atlasModel(p: Progress): AtlasModel {
  const chapters: AtlasChapter[] = [];
  let stars = 0;
  let total = 0;
  for (const c of CHAPTERS) {
    if (c.id === 'echo' && p !== 'locked') continue;
    const levels = NAMES[c.id].map((name, i) => {
      const solved = p !== 'first' && ((c.id === 'bend' && i < 4) || (c.id === 'thread' && i < 1));
      const help = solved && c.id === 'bend' && i === 2;
      const par = solved && !help && i !== 3;
      const current = p === 'first' ? c.id === 'bend' && i === 0 : c.id === 'bend' && i === 4;
      if (par) stars++;
      total++;
      return { id: `${c.id}-${i + 1}`, index: i + 1, name, solved, par, help, current };
    });
    const locked = c.id === 'echo';
    if (locked) total -= levels.length;
    chapters.push({
      id: c.id,
      name: c.name,
      nebulaName: c.nebula,
      rule: c.rule,
      levels,
      solvedCount: levels.filter((l) => l.solved).length,
      locked,
      lockText: locked ? 'Opens when four puzzles are solved in two chapters' : undefined,
    });
  }
  return {
    chapters,
    daily: {
      date: '2026-10-02',
      label: 'First Light #1 · Menger',
      solved: p === 'returning',
      streak: p === 'first' ? 0 : 3,
      nextIn: '07:42',
      time: p === 'returning' ? '1:12' : undefined,
    },
    stars,
    starsTotal: total,
  };
}

function header(id: string): LevelHeader {
  if (id === 'daily') {
    return { nebulaName: 'The Menger Lattice', chapterName: 'Daily', index: 1, total: 1, name: 'First Light #1', isDaily: true };
  }
  const [cid, n] = id.split('-');
  const c = CHAPTERS.find((x) => x.id === cid) ?? CHAPTERS[0];
  const i = Math.max(1, Math.min(6, Number(n) || 1));
  return { nebulaName: c.nebula, chapterName: c.name, index: i, total: 6, name: NAMES[c.id][i - 1], isDaily: false };
}

const HINTS = [
  'The seed sits just past the floret’s shoulder. The beam needs only a nudge, not a turn.',
  'Look between the source and the first floret: one light mass in that space is enough.',
  'Designer’s note: place the light mass about two floret-widths left of the beam, level with the star. The beam curls around the shoulder into the seed.',
];

const SOLVED_LEVEL: SolvedCard = {
  title: 'First light',
  teach: 'A mass bends light toward itself — a near pass bends it more than a far one.',
  massesUsed: 1,
  par: 1,
  parMet: true,
  help: false,
  nextLabel: 'Next · Two Florets',
  isDaily: false,
};
const SOLVED_END: SolvedCard = {
  title: 'First light',
  teach: 'Bent light can circle a mass that would swallow it head-on.',
  massesUsed: 3,
  par: 2,
  parMet: false,
  help: true,
  nextLabel: null,
  isDaily: false,
};
const SOLVED_DAILY: SolvedCard = {
  title: 'Daily solved',
  teach: 'Two lenses in series thread a tunnel that no straight line can.',
  massesUsed: 2,
  par: 2,
  parMet: true,
  help: false,
  nextLabel: null,
  isDaily: true,
  share: `First Light #1 · Menger · ◆◆◇  ⚬⚬  1:12\n${location.origin}/?mode=firstlight&daily=2026-10-02`,
  streak: 4,
  time: '1:12',
  nextIn: '07:42',
};

// The per-frame view-model, mutated in place (as the mode should do).
const play: PlayHudState = {
  view: 'flight',
  seeds: [
    { goal: true, lit: false, almost: 0 },
    { goal: true, lit: false, almost: 0 },
    { goal: true, lit: false, almost: 0 },
    { goal: false, lit: false, almost: 0 },
  ],
  masses: [
    { size: 'light', total: 2, placed: 0 },
    { size: 'medium', total: 1, placed: 0 },
    { size: 'heavy', total: 1, placed: 0 },
  ],
  selected: 'light',
  placement: { legal: true, reason: null },
  depth: 0.5,
  hintAvailable: false,
  hintLevel: 0,
  timer: null,
  canUndo: false,
  canRedo: false,
  dragging: false,
};

const sim = {
  animateAlmost: true,
  illegal: false,
  copyFails: false,
  daily: false,
  dailyTime: 0,
  placedStack: [] as MassSize[],
  redoStack: [] as MassSize[],
  level: 'bend-1',
  mouse: { x: 0, y: 0 },
};

// ---------------------------------------------------------------------------------------------
// HUD + callbacks
// ---------------------------------------------------------------------------------------------

const log: string[] = [];
function note(s: string): void {
  log.unshift(s);
  log.length = Math.min(log.length, 6);
  logEl.textContent = log.join('\n');
}

const cb: FirstLightHudCallbacks = {
  onSelectLevel: (id) => {
    note(`onSelectLevel(${id})`);
    hud.hideAtlas();
    enterLevel(id);
  },
  onDaily: () => {
    note('onDaily()');
    hud.hideAtlas();
    enterLevel('daily');
  },
  onCloseAtlas: () => {
    note('onCloseAtlas()');
    hud.hideAtlas();
  },
  onNext: () => {
    note('onNext()');
    hud.hideSolved();
    const [c, n] = sim.level.split('-');
    enterLevel(`${c}-${Math.min(6, (Number(n) || 1) + 1)}`);
  },
  onReplay: () => {
    note('onReplay()');
    hud.hideSolved();
    enterLevel(sim.level);
  },
  onOpenAtlas: () => {
    note('onOpenAtlas()');
    hud.hideSolved();
    hud.showAtlas(atlasModel('returning'), true);
  },
  onHint: () => {
    note('onHint()');
    play.hintAvailable = true;
    showHintStep(Math.min(3, play.hintLevel + (hud.solvedOpen ? 0 : 1)));
  },
  onSelectSize: (size) => {
    note(`onSelectSize(${size})`);
    play.selected = size;
  },
  onCopyShare: async () => {
    note('onCopyShare()');
    if (sim.copyFails) return false;
    try {
      await navigator.clipboard.writeText(SOLVED_DAILY.share ?? '');
      return true;
    } catch {
      return false;
    }
  },
  onUndo: () => {
    note('onUndo()');
    undo();
  },
  onRedo: () => {
    note('onRedo()');
    redo();
  },
};

const hud = new FirstLightHud(layer, cb);

function resetPlay(): void {
  for (const s of play.seeds) {
    s.lit = false;
    s.almost = 0;
  }
  for (const m of play.masses) m.placed = 0;
  sim.placedStack.length = 0;
  sim.redoStack.length = 0;
  play.hintLevel = 0;
  play.hintAvailable = false;
  play.dragging = false;
  sim.dailyTime = 0;
  hud.hideHint();
  syncUndo();
}

function enterLevel(id: string): void {
  sim.level = id;
  sim.daily = id === 'daily';
  play.timer = sim.daily ? '0:00' : null;
  resetPlay();
  hud.setLevel(header(id));
}

function showHintStep(step: number): void {
  const s = Math.max(1, Math.min(3, step)) as 1 | 2 | 3;
  play.hintLevel = Math.max(play.hintLevel, s);
  hud.showHint(s, HINTS[s - 1]);
}

function place(): void {
  const m = play.masses.find((x) => x.size === play.selected);
  if (!m || m.placed >= m.total) return;
  m.placed++;
  sim.placedStack.push(m.size);
  sim.redoStack.length = 0;
  syncUndo();
}

function undo(): void {
  const size = sim.placedStack.pop();
  if (!size) return;
  const m = play.masses.find((x) => x.size === size);
  if (m) m.placed = Math.max(0, m.placed - 1);
  sim.redoStack.push(size);
  syncUndo();
}

function redo(): void {
  const size = sim.redoStack.pop();
  if (!size) return;
  const m = play.masses.find((x) => x.size === size);
  if (m && m.placed < m.total) m.placed++;
  sim.placedStack.push(size);
  syncUndo();
}

function syncUndo(): void {
  play.canUndo = sim.placedStack.length > 0;
  play.canRedo = sim.redoStack.length > 0;
}

function lightNext(): void {
  const s = play.seeds.find((x) => x.goal && !x.lit);
  if (s) s.lit = true;
  else for (const x of play.seeds) x.lit = false;
}

// ---------------------------------------------------------------------------------------------
// States (dev panel + ?s=)
// ---------------------------------------------------------------------------------------------

const STATES: { id: string; label: string; run: () => void }[] = [
  { id: 'atlas-first', label: 'Atlas · first time', run: () => { hud.hideSolved(); hud.setLevel(null); hud.showAtlas(atlasModel('first'), false); } },
  { id: 'atlas', label: 'Atlas · returning', run: () => { hud.hideSolved(); if (!sim.level) enterLevel('bend-5'); hud.showAtlas(atlasModel('returning'), true); } },
  { id: 'atlas-locked', label: 'Atlas · locked chapter', run: () => { hud.hideSolved(); hud.showAtlas(atlasModel('locked'), true); } },
  { id: 'flight', label: 'Play · flight', run: () => { closePanels(); play.view = 'flight'; play.depth = 0.5; } },
  { id: 'lab', label: 'Play · lab', run: () => { closePanels(); play.view = 'lab'; play.depth = null; } },
  { id: 'illegal', label: 'Toggle placement illegal', run: () => { sim.illegal = !sim.illegal; } },
  { id: 'drag', label: 'Toggle dragging', run: () => { play.dragging = !play.dragging; } },
  { id: 'almost', label: 'Toggle almost animation', run: () => { sim.animateAlmost = !sim.animateAlmost; } },
  { id: 'light', label: 'Light next seed', run: () => lightNext() },
  { id: 'place', label: 'Place selected mass', run: () => place() },
  { id: 'hint-chip', label: 'Toggle hint chip', run: () => { play.hintAvailable = !play.hintAvailable; } },
  { id: 'hint1', label: 'Hint 1', run: () => { closePanels(); play.hintAvailable = true; showHintStep(1); } },
  { id: 'hint2', label: 'Hint 2', run: () => { closePanels(); play.hintAvailable = true; showHintStep(2); } },
  { id: 'hint3', label: 'Hint 3', run: () => { closePanels(); play.hintAvailable = true; showHintStep(3); } },
  { id: 'solved', label: 'Solved', run: () => { hud.hideAtlas(); for (const s of play.seeds) if (s.goal) s.lit = true; hud.showSolved(SOLVED_LEVEL); } },
  { id: 'solved-end', label: 'Solved · chapter end, help', run: () => { hud.hideAtlas(); hud.showSolved(SOLVED_END); } },
  { id: 'daily', label: 'Daily · play', run: () => { closePanels(); enterLevel('daily'); } },
  { id: 'daily-solved', label: 'Daily · solved', run: () => { hud.hideAtlas(); if (!sim.daily) enterLevel('daily'); for (const s of play.seeds) if (s.goal) s.lit = true; hud.showSolved(SOLVED_DAILY); } },
  { id: 'copy-fail', label: 'Toggle copy failure', run: () => { sim.copyFails = !sim.copyFails; } },
  {
    id: 'tip',
    label: 'Physics tip',
    run: () =>
      hud.showTip(
        'Gravitational lensing',
        'Light passing a mass is deflected by α = 2rₛ/b — twice what Newton predicted. Eddington measured it during the 1919 eclipse.',
      ),
  },
  { id: 'hide-level', label: 'setLevel(null)', run: () => { closePanels(); hud.setLevel(null); } },
];

function closePanels(): void {
  hud.hideAtlas();
  hud.hideSolved();
  if (!document.querySelector('.flh-play:not([hidden])')) enterLevel(sim.level || 'bend-1');
}

// ---------------------------------------------------------------------------------------------
// Dev panel
// ---------------------------------------------------------------------------------------------

const dev = document.getElementById('dev') as HTMLElement;
dev.style.cssText =
  'position:fixed;right:10px;top:50%;transform:translateY(-50%);z-index:100;width:196px;max-height:86vh;overflow:auto;' +
  'padding:8px;border-radius:8px;background:rgba(10,8,4,0.82);border:1px dashed rgba(255,200,120,0.35);' +
  'font:11px/1.3 ui-monospace,Consolas,monospace;color:#e8d9bd;user-select:none';
const devTitle = el('div', '', dev, 'WP H · dev panel (` hides)');
devTitle.style.cssText = 'margin-bottom:6px;color:#ffcf8a';
for (const s of STATES) {
  const b = el('button', '', dev, s.label);
  b.type = 'button';
  b.style.cssText =
    'display:block;width:100%;margin:2px 0;padding:3px 6px;text-align:left;cursor:pointer;border-radius:4px;' +
    'border:1px solid rgba(255,200,120,0.25);background:rgba(255,200,120,0.06);color:inherit;font:inherit';
  b.addEventListener('click', (e) => {
    if (e.detail > 0) b.blur();
    note(`state: ${s.id}`);
    s.run();
  });
}
const statsEl = el('div', '', dev);
statsEl.style.cssText = 'margin-top:8px;color:#bfe9ff;white-space:pre';
const logEl = el('div', '', dev);
logEl.style.cssText = 'margin-top:6px;color:#9fb3c8;white-space:pre-wrap;min-height:6em';

// DOM writes per frame (the HUD must be silent in steady state).
let mutations = 0;
new MutationObserver((records) => {
  mutations += records.length;
}).observe(layer, { subtree: true, childList: true, attributes: true, characterData: true });

// ---------------------------------------------------------------------------------------------
// Mode stand-in input
// ---------------------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') {
    dev.hidden = !dev.hidden;
    return;
  }
  if (hud.atlasOpen || hud.solvedOpen || e.repeat) return;
  switch (e.code) {
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
      play.selected = (['light', 'medium', 'heavy'] as const)[Number(e.code.slice(5)) - 1];
      break;
    case 'Tab':
      e.preventDefault();
      play.view = play.view === 'lab' ? 'flight' : 'lab';
      play.depth = play.view === 'flight' ? 0.5 : null;
      break;
    case 'KeyZ':
      if (e.shiftKey) redo();
      else undo();
      break;
    case 'KeyC':
      for (const m of play.masses) m.placed = 0;
      sim.placedStack.length = 0;
      syncUndo();
      break;
    case 'Slash':
      cb.onHint();
      break;
  }
});

window.addEventListener('mousemove', (e) => {
  sim.mouse.x = e.clientX;
  sim.mouse.y = e.clientY;
});
window.addEventListener('wheel', (e) => {
  if (play.view === 'flight' && play.depth !== null) play.depth = Math.min(1.2, Math.max(0.02, play.depth * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
});

// ---------------------------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------------------------

let last = performance.now();
let t = 0;
let frames = 0;
let statAcc = 0;
let mutFrames = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  t += dt;

  if (sim.animateAlmost) {
    play.seeds[1].almost = play.seeds[1].lit ? 0 : 0.5 + 0.5 * Math.sin(t * 0.9);
    play.seeds[2].almost = play.seeds[2].lit ? 0 : Math.max(0, Math.sin(t * 0.37)) * 0.6;
  }
  if (sim.daily && !hud.solvedOpen) {
    sim.dailyTime += dt;
    const s = Math.floor(sim.dailyTime);
    play.timer = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  const spent = play.masses.every((m) => m.placed >= m.total);
  const p = play.placement;
  if (spent) play.placement = null;
  else {
    play.placement = p ?? { legal: true, reason: null };
    play.placement.legal = !sim.illegal;
    play.placement.reason = sim.illegal ? 'inside structure' : null;
  }

  hud.setPlay(play);
  if (play.view === 'lab' && !hud.atlasOpen && !hud.solvedOpen) {
    // A fake mass at (62 %, 44 %): hovering it shows "remove", else the legality reason.
    const near = Math.hypot(sim.mouse.x - window.innerWidth * 0.62, sim.mouse.y - window.innerHeight * 0.44) < 30;
    hud.setCursorTip(sim.mouse.x, sim.mouse.y, near ? 'Remove' : sim.illegal && !play.dragging ? 'inside structure' : null);
  } else {
    hud.setCursorTip(0, 0, null);
  }
  hud.update(dt);

  frames++;
  statAcc += dt;
  mutFrames += mutations;
  mutations = 0;
  if (statAcc >= 0.5) {
    statsEl.textContent =
      `fps ${(frames / statAcc).toFixed(0)}\nDOM writes/frame ${(mutFrames / frames).toFixed(2)}\n` +
      `almost anim ${sim.animateAlmost ? 'on' : 'off'} · copy ${sim.copyFails ? 'fails' : 'ok'}`;
    frames = 0;
    statAcc = 0;
    mutFrames = 0;
  }
  requestAnimationFrame(frame);
}

// Start: ?s=<state id> jumps straight to a state (default: flight play).
const start = new URLSearchParams(location.search).get('s') ?? 'flight';
enterLevel('bend-1');
(STATES.find((s) => s.id === start) ?? STATES[3]).run();
requestAnimationFrame(frame);
