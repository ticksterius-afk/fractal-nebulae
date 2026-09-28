/**
 * CPU raymarch preview of a FractalDef's JS distance estimator → PNG you can open/view.
 * Validates shape, bound radius and DE quality (shows step-count heat if requested).
 *
 *   import { renderFractalPNG } from '../tools/cpu-render';
 *   renderFractalPNG(mandelbulb, 'C:/.../scratchpad/bulb.png', { size: 320, dist: 3.2, yaw: 0.6, pitch: 0.35 });
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { FractalDef } from '../src/core/types';

function crc32(buf: Uint8Array): number {
  let c: number, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function writePNG(path: string, w: number, h: number, rgb: Uint8Array): void {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)),
  ]);
  writeFileSync(path, png);
}

export interface CpuRenderOpts {
  size?: number; dist?: number; yaw?: number; pitch?: number; fovDeg?: number;
  maxSteps?: number; iter?: number; params?: Float32Array; heat?: boolean; time?: number;
  /** Camera target offset (local units). */
  target?: [number, number, number];
}

export function renderFractalPNG(f: FractalDef, path: string, o: CpuRenderOpts = {}): { hitRatio: number; maxHitRadius: number } {
  const size = o.size ?? 256, dist = o.dist ?? f.boundRadius * 2.6, yaw = o.yaw ?? 0.6, pitch = o.pitch ?? 0.3;
  const fov = ((o.fovDeg ?? 50) * Math.PI) / 180, maxSteps = o.maxSteps ?? 200, iter = o.iter ?? f.cpuIter;
  const params = o.params ?? Float32Array.from(f.defaultParams);
  if (f.animate && o.time !== undefined) f.animate(f.defaultParams, o.time, params);
  const tgt = o.target ?? [0, 0, 0];
  const ro = [tgt[0] + dist * Math.cos(pitch) * Math.sin(yaw), tgt[1] + dist * Math.sin(pitch), tgt[2] + dist * Math.cos(pitch) * Math.cos(yaw)];
  const fw = [tgt[0] - ro[0], tgt[1] - ro[1], tgt[2] - ro[2]];
  const fl = Math.hypot(fw[0], fw[1], fw[2]); fw[0] /= fl; fw[1] /= fl; fw[2] /= fl;
  const rt = [fw[2], 0, -fw[0]]; const rl = Math.hypot(rt[0], rt[2]) || 1; rt[0] /= rl; rt[2] /= rl;
  const up = [rt[1] * fw[2] - rt[2] * fw[1], rt[2] * fw[0] - rt[0] * fw[2], rt[0] * fw[1] - rt[1] * fw[0]];
  const out = new Uint8Array(size * size * 3);
  const L = [0.577, 0.577, 0.577];
  const th = Math.tan(fov / 2);
  let hits = 0, maxR = 0;
  const de = (x: number, y: number, z: number) => f.de(x, y, z, params, iter);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = ((px + 0.5) / size * 2 - 1) * th, v = (1 - (py + 0.5) / size * 2) * th;
      let rd = [fw[0] + rt[0] * u + up[0] * v, fw[1] + rt[1] * u + up[1] * v, fw[2] + rt[2] * u + up[2] * v];
      const l = Math.hypot(rd[0], rd[1], rd[2]); rd = [rd[0] / l, rd[1] / l, rd[2] / l];
      let t = 0, steps = 0, hit = false;
      const pixA = (2 * th) / size;
      for (; steps < maxSteps; steps++) {
        const x = ro[0] + rd[0] * t, y = ro[1] + rd[1] * t, z = ro[2] + rd[2] * t;
        const d = de(x, y, z);
        if (d < Math.max(1e-5, t * pixA * 0.5)) { hit = true; break; }
        t += d;
        if (t > dist * 3) break;
      }
      let r = 8, g = 10, b = 16;
      if (hit) {
        hits++;
        const x = ro[0] + rd[0] * t, y = ro[1] + rd[1] * t, z = ro[2] + rd[2] * t;
        maxR = Math.max(maxR, Math.hypot(x, y, z));
        const e = Math.max(1e-5, t * pixA * 0.5);
        const nx = de(x + e, y, z) - de(x - e, y, z), ny = de(x, y + e, z) - de(x, y - e, z), nz = de(x, y, z + e) - de(x, y, z - e);
        const nl = Math.hypot(nx, ny, nz) || 1;
        const dif = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / nl);
        const ao = 1 - Math.min(1, steps / maxSteps) * 0.85;
        const base = 40 + 200 * dif;
        r = base * ao * 1.0; g = base * ao * 0.9; b = base * ao * 0.8;
      }
      if (o.heat) { const hsc = Math.min(1, steps / maxSteps); r = r * 0.5 + 255 * hsc * 0.5; }
      const i = (py * size + px) * 3;
      out[i] = Math.min(255, r); out[i + 1] = Math.min(255, g); out[i + 2] = Math.min(255, b);
    }
  }
  writePNG(path, size, size, out);
  return { hitRatio: hits / (size * size), maxHitRadius: maxR };
}
