// Dev-only helpers for visual tuning in the browser console. Load with:
//   await import('/tools/devtools.js').then(m => m.setup())
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
