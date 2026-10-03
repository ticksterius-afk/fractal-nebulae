// Dev-only helpers for visual tuning in the browser console. Load with:
//   await import('/tools/devtools.js').then(m => m.setup())

// The built-in browser pane refuses pointer lock: stand in for it so locked flight (First Light
// placement, Tab, grabs) can be tested there. Call it before Launch / Resume:
//   await import('/tools/devtools.js').then(m => m.fakeLock())
// `__fakeLock.refuse = true` makes later requests fail; `__look(dx, dy)` sends locked mouse movement.
export function fakeLock({ refuse = false } = {}) {
  if (window.__fakeLock) {
    window.__fakeLock.refuse = refuse;
    return 'fake pointer lock already installed';
  }
  const st = { el: null, refuse };
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get: () => st.el });
  Element.prototype.requestPointerLock = function () {
    return new Promise((res, rej) => setTimeout(() => {
      if (st.refuse) {
        document.dispatchEvent(new Event('pointerlockerror'));
        rej(new DOMException('refused by the stand-in', 'NotAllowedError'));
        return;
      }
      st.el = this;
      document.dispatchEvent(new Event('pointerlockchange'));
      res();
    }, 30));
  };
  Document.prototype.exitPointerLock = function () {
    if (!st.el) return;
    st.el = null;
    setTimeout(() => document.dispatchEvent(new Event('pointerlockchange')), 10);
  };
  window.__fakeLock = st;
  window.__look = (dx, dy) =>
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, bubbles: true }));
  return 'fake pointer lock installed';
}

// First Light playtest rig for the built-in pane (rAF throttled, pointer lock refused, often hidden):
//   await import('/tools/devtools.js').then(m => m.flRig())   then Launch (or __launch())
//   __run(sec)            drive frames at 60 Hz by hand
//   __aim(localPos)       turn the ship so the reticle looks at a level-local point
//   __click(button)       press + release a mouse button on the canvas (locked flight)
//   __key(code, opts)     key down + up (e.g. 'Tab', 'Digit2', 'KeyZ')
//   __playLevel(id)       load a level, then aim + click each authored solution mass → result
//   __shot(name)          POST a canvas JPEG to a local receiver on 127.0.0.1:5199 (when screenshots fail;
//                         start it first: npm run shots, i.e. tools/shot-receiver.mjs)
export async function flRig() {
  fakeLock();
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const { findLevel } = await import('/src/game/firstlight/chapters.ts');
  const a = window.__app;
  window.__run = (sec) => new Promise((res) => {
    let t = performance.now();
    const t0 = t;
    const iv = setInterval(() => { t += 1000 / 60; a.frame(t); if (t - t0 > sec * 1000) { clearInterval(iv); res(); } }, 4);
  });
  window.__launch = () => [...document.querySelectorAll('button')].find((b) => /launch/i.test(b.textContent))?.click();
  window.__aim = (local) => {
    const st = a.sim.state;
    const id = window.__fl?.state().level;
    const def = id ? findLevel(id)?.level : null;
    const neb = a.sim.nebulae.find((n) => n.def.id === (def?.nebula ?? window.__fl?.state().nebula));
    if (!neb) return false;
    const w = new THREE.Vector3(...local).multiplyScalar(neb.scale).applyQuaternion(neb.rotation).add(neb.position);
    st.ship.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(st.ship.position.clone(), w, st.ship.up.clone()));
    const s = a.sim;
    s.baseQ?.copy(st.ship.orientation); s.lastGoodQ?.copy(st.ship.orientation); s.bank = 0;
    s.yawPending = 0; s.pitchPending = 0; s.yawStage = 0; s.pitchStage = 0;
    return true;
  };
  window.__click = (button = 0) => {
    document.getElementById('gl').dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
    setTimeout(() => window.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true })), 40);
  };
  window.__key = (code, opts = {}) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true, ...opts }));
    setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true, ...opts })), 30);
  };
  window.__playLevel = async (id) => {
    window.__fl.load(id);
    await window.__run(4.5);
    if (window.__fl.state().view === 'lab') { window.__key('Tab'); await window.__run(1.2); }
    const L = findLevel(id).level;
    for (const m of L.solution) {
      window.__key({ light: 'Digit1', medium: 'Digit2', heavy: 'Digit3' }[m.size]);
      await window.__run(0.15);
      window.__aim(m.pos);
      await window.__run(0.25);
      window.__click(0);
      await window.__run(0.5);
    }
    await window.__run(0.3);
    const s = window.__fl.state();
    return { id, solved: s.solved, phase: s.phase, masses: s.masses.length };
  };
  window.__shot = async (name, frames = 6) => {
    let t = performance.now();
    const c = document.getElementById('gl');
    const out = document.createElement('canvas');
    out.width = c.width; out.height = c.height;
    for (let i = 0; i < frames; i++) { t += 1000 / 60; a.frame(t); }
    out.getContext('2d').drawImage(c, 0, 0);
    const data = out.toDataURL('image/jpeg', 0.85);
    const r = await fetch('http://127.0.0.1:5199/', { method: 'POST', body: JSON.stringify({ name, data }) });
    return r.text();
  };
  return 'First Light rig ready';
}
export async function setup({ hideHud = true } = {}) {
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const a = window.__app;
  while (!a.rendererReady) await new Promise((r) => setTimeout(r, 200));
  const r = a.renderer, st = a.sim.state, neb = a.sim.nebulae, gl = r.three.getContext();
  a.sim.setAttractMode(false);
  if (hideHud) document.querySelector('#hud-root').style.opacity = '0';
  const px = new Uint8Array(4);
  // The simulation owns an internal base orientation (+ bank); keep it in sync with debug moves.
  const syncOrientation = () => {
    if (a.sim.baseQ) a.sim.baseQ.copy(st.ship.orientation);
    if (a.sim.lastGoodQ) a.sim.lastGoodQ.copy(st.ship.orientation);
    if (typeof a.sim.bank === 'number') a.sim.bank = 0;
  };
  window.__lookFrom = (id, mul, off = [0.3, 0.25, 1], target = null) => {
    const n = neb.find((x) => x.def.id === id);
    const c = target ? n.position.clone().add(new THREE.Vector3(...target).multiplyScalar(n.scale)) : n.position;
    const p = n.position.clone().add(new THREE.Vector3(...off).normalize().multiplyScalar(n.boundRadiusWorld * mul));
    st.ship.position.copy(p);
    st.ship.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(p, c, new THREE.Vector3(0, 1, 0)));
    syncOrientation();
    st.ship.velocity.set(0, 0, 0);
    a.sim.universe.update(st.time, st.ship.position);
  };
  // Place the camera at a LOCAL-space point of a nebula looking at another local point.
  window.__local = (id, eye, look) => {
    const n = neb.find((x) => x.def.id === id);
    const toW = (v) => new THREE.Vector3(...v).multiplyScalar(n.scale).applyQuaternion(n.rotation).add(n.position);
    const p = toW(eye), c = toW(look);
    st.ship.position.copy(p);
    st.ship.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(p, c, new THREE.Vector3(0, 1, 0).applyQuaternion(n.rotation)));
    syncOrientation();
    st.ship.velocity.set(0, 0, 0);
    a.sim.universe.update(st.time, st.ship.position);
  };
  window.__view = window.__lookFrom;
  window.__gpu = (n = 6) => {
    for (let i = 0; i < 3; i++) { r.render(st, neb); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { r.render(st, neb); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    return +((performance.now() - t0) / n).toFixed(1);
  };
  window.__setDef = (name, value) => {
    for (const p of r.passes.values()) {
      if (p.isBlackHole) continue;
      const m = p.material;
      m.fragmentShader = m.fragmentShader.replace(new RegExp('#define ' + name + ' [^\n]*'), '#define ' + name + ' ' + value);
      m.needsUpdate = true;
    }
  };
  window.__only = (id) => { for (const p of r.passes.values()) p.mesh.visible = !id || p.neb.def.id === id; };
  // Ghost-mode rig: place the ship `clrMul` clearances off nebula `id`'s surface (approached from
  // direction `off`), facing the centre; optionally as if arriving from a cruise at scale `cruise`.
  const sim = a.sim, U = sim.universe;
  window.__placeNear = (id, clrMul = 9, off = [0.3, 0.25, 1], cruise = 0) => {
    const n = neb.find((x) => x.def.id === id);
    const clr = U.clearance(id);
    const dir = new THREE.Vector3(...off).normalize();
    let t = n.boundRadiusWorld * 1.1, p = n.position.clone();
    for (let i = 0; i < 4000; i++) {
      p = n.position.clone().addScaledVector(dir, t);
      const d = U.distanceValue(p);
      if (d < clrMul * clr) break;
      t -= Math.max(d * 0.5, clr);
    }
    st.ship.position.copy(p);
    st.ship.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(p, n.position, new THREE.Vector3(0, 1, 0)));
    syncOrientation();
    sim.vCtrl?.set(0, 0, 0); sim.vGrav?.set(0, 0, 0); st.ship.velocity.set(0, 0, 0);
    sim.ghostActive = false; sim.ghostInside = false; sim.ghostClip = 0; sim.ghostOutTime = Infinity;
    U.update(st.time, p); sim.measureSurface();
    sim.dirScale = cruise || sim.speedScale; sim.flightScale = cruise || sim.speedScale;
    return +(t / n.boundRadiusWorld).toFixed(3);
  };
  // Hold RMB+W (hold = true) through the input poll; drive frames at 60 Hz (the pane throttles rAF).
  if (!a.input.__ghostWrapped) {
    const poll = a.input.poll.bind(a.input);
    a.input.poll = (...args) => {
      const f = poll(...args);
      if (window.__hold) { f.hyper = true; f.forward = 1; f.anyMoveInput = true; }
      return f;
    };
    a.input.__ghostWrapped = true;
  }
  window.__drive = (sec, hold = window.__hold) => new Promise((res) => {
    window.__hold = hold;
    let tt = performance.now();
    const t0 = tt;
    const iv = setInterval(() => { tt += 1000 / 60; a.frame(tt); if (tt - t0 >= sec * 1000) { clearInterval(iv); res(); } }, 16);
  });
  window.__diag = (id) => {
    const s = st.ship, d = U.distanceValue(s.position), rid = id ?? U.distance(s.position).id;
    const n = neb.find((x) => x.def.id === rid), clr = U.clearance(rid);
    return { id: rid, dClr: +(d / clr).toFixed(1), ghost: sim.ghostActive, inside: sim.ghostInside,
      ghostScale: +sim.ghostScale.toPrecision(3), clipB: n ? +(s.ghostClip / n.boundRadiusWorld).toFixed(3) : 0,
      speed: +s.speed.toPrecision(3), hyper: +s.hyper.toFixed(2), rB: n ? +(s.position.distanceTo(n.position) / n.boundRadiusWorld).toFixed(3) : 0 };
  };
  window.__NM = await import('/src/render/NebulaMaterial.ts');
  return 'devtools ready';
}
