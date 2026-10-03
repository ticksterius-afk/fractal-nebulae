/**
 * Offline compile check of EVERY shader program the app builds, for all four quality presets,
 * through tools/glsl-check.ts (glslangValidator + the three.js r186 ShaderMaterial prefix).
 *
 *   npx tsx tools/check-all-shaders.ts            # everything
 *   npx tsx tools/check-all-shaders.ts nebula     # only programs whose name contains "nebula"
 *
 * Programs are built through the real factories (createNebulaMaterial, createBlackHoleMaterial,
 * SkySystem, the star groups, the game-overlay layers, BloomPass, LayerSumPass, TaaPass, CompositePass), so the
 * defines are exactly the ones the renderer uses. Identical (stage, defines, source) triples are validated once.
 * Also asserts the project-wide shader contract: no glslVersion (three must declare pc_fragColor),
 * no hand-declared location-0 output, and no `#version` line in any source.
 * Exits with code 1 if anything fails.
 */
import * as THREE from 'three';
import type { NebulaRuntime, QualityName } from '../src/core/types';
import { QUALITY_PRESETS } from '../src/app/config';
import { FRACTALS } from '../src/fractals/registry';
import { NEBULAE } from '../src/universe/catalog';
import { Universe } from '../src/universe/Universe';
import { createNebulaMaterial } from '../src/render/NebulaMaterial';
import { createBlackHoleMaterial } from '../src/fractals/blackhole/BlackHoleMaterial';
import { SkySystem } from '../src/render/sky/SkySystem';
import { FarStars } from '../src/render/stars/FarStars';
import { NearStars } from '../src/render/stars/NearStars';
import { DustMotes } from '../src/render/stars/DustMotes';
import { NebulaStars } from '../src/render/stars/NebulaStars';
import { makeSharedSpriteUniforms } from '../src/render/stars/sprites';
import { LineSystem } from '../src/render/game/LineSystem';
import { GlyphSprites } from '../src/render/game/GlyphSprites';
import { GameStars } from '../src/render/game/GameStars';
import { BloomPass } from '../src/render/post/BloomPass';
import { TaaPass } from '../src/render/post/TaaPass';
import { CompositePass } from '../src/render/post/CompositePass';
import { LayerSumPass } from '../src/render/post/LayerSumPass';
import { checkShader } from './glsl-check';

type ShaderLike = {
  vertexShader: string;
  fragmentShader: string;
  defines?: Record<string, unknown>;
  glslVersion?: string | null;
};

const filter = (process.argv[2] ?? '').toLowerCase();
const seen = new Map<string, boolean>();
const failures: string[] = [];
let programs = 0;
let validated = 0;

function contract(name: string, m: ShaderLike): boolean {
  const problems: string[] = [];
  if (m.glslVersion) problems.push(`glslVersion is set (${m.glslVersion}): three would not declare pc_fragColor`);
  for (const [stage, src] of [['vert', m.vertexShader], ['frag', m.fragmentShader]] as const) {
    if (/^\s*#\s*version\b/m.test(src)) problems.push(`${stage}: contains a #version line`);
  }
  if (/layout\s*\(\s*location\s*=\s*0\s*\)\s*out\b/.test(m.fragmentShader)) {
    problems.push('frag: declares its own location-0 output (three already declares pc_fragColor)');
  }
  if (/^\s*out\s+(highp\s+|mediump\s+|lowp\s+)?vec4\s+\w+\s*;/m.test(m.fragmentShader)) {
    problems.push('frag: declares an unqualified `out vec4` (collides with pc_fragColor)');
  }
  for (const p of problems) console.log(`✘ ${name}: ${p}`);
  return problems.length === 0;
}

function stage(name: string, kind: 'vert' | 'frag', src: string, defines?: Record<string, unknown>): boolean {
  const key = `${kind}\u0000${JSON.stringify(defines ?? {})}\u0000${src}`;
  const cached = seen.get(key);
  if (cached !== undefined) return cached;
  validated++;
  const ok = checkShader(kind, src, name, defines);
  seen.set(key, ok);
  return ok;
}

function check(name: string, m: ShaderLike): void {
  if (filter && !name.toLowerCase().includes(filter)) return;
  programs++;
  let ok = contract(name, m);
  ok = stage(name, 'vert', m.vertexShader, m.defines) && ok;
  ok = stage(name, 'frag', m.fragmentShader, m.defines) && ok;
  if (!ok) failures.push(name);
}

const QUALITIES = Object.keys(QUALITY_PRESETS) as QualityName[];
const runtimes: NebulaRuntime[] = new Universe(NEBULAE).runtimes;
const blackHoles = runtimes.filter((r) => r.fractal === null);

// ---- per quality: nebulae (9 fractals), black holes, sky generator + sky pass ----
for (const qn of QUALITIES) {
  const q = QUALITY_PRESETS[qn];
  for (const [kind, fractal] of Object.entries(FRACTALS)) check(`nebula-${kind}-${qn}`, createNebulaMaterial(fractal, q));
  for (const bh of blackHoles) check(`blackhole-${bh.def.id}-${qn}`, createBlackHoleMaterial(bh, q));
  const sky = new SkySystem({} as THREE.WebGLRenderer, q) as unknown as {
    genMaterial: THREE.ShaderMaterial;
    passMaterial: THREE.ShaderMaterial;
  };
  check(`sky-generator-${qn}`, sky.genMaterial);
  check(`sky-pass-${qn}`, sky.passMaterial);
}

// ---- star sprites (quality only changes instance counts) ----
const shared = makeSharedSpriteUniforms();
check('stars-far', new FarStars(16, shared).material);
check('stars-near', new NearStars(16, shared).material);
const dust = new DustMotes(16, shared);
dust.meshes.forEach((m, i) => check(`stars-dust-${i}`, m.material as THREE.ShaderMaterial));
check('stars-nebula', new NebulaStars(runtimes, shared).material);

// ---- game overlay (quality-independent): lines, glyphs, star sprites × visible/occluded pass ----
// The two passes share their sources (one program each in three); both are listed to enforce it.
const passNames = ['visible', 'occluded'];
for (const [kind, layer] of [
  ['lines', new LineSystem(shared)],
  ['glyphs', new GlyphSprites(shared)],
  ['stars', new GameStars(shared)],
] as const) {
  layer.materials.forEach((m, i) => check(`overlay-${kind}-${passNames[i]}`, m));
  const [a, b] = layer.materials;
  if ((!filter || `overlay-${kind}`.includes(filter)) && (a.vertexShader !== b.vertexShader || a.fragmentShader !== b.fragmentShader)) {
    console.log(`✘ overlay-${kind}: the visible and occluded passes must share their sources (one program)`);
    failures.push(`overlay-${kind}-shared-sources`);
  }
}

// ---- post: bloom chain (+ its layer sum), TAA resolve, final composite (with WORMHOLE_GLSL) ----
const bloom = new BloomPass(6);
const bloomNames = ['bloom-down-first', 'bloom-down', 'bloom-up'];
bloom.compileObjects().forEach((o, i) => check(bloomNames[i] ?? `bloom-${i}`, (o as THREE.Mesh).material as THREE.ShaderMaterial));
check('layer-sum', new LayerSumPass().material);
new TaaPass().compileObjects().forEach((o) => check('taa-resolve', (o as THREE.Mesh).material as THREE.ShaderMaterial));
check('composite', new CompositePass().material);

console.log(
  `\n${programs} programs (${validated} distinct shader stages validated)` +
    (failures.length ? `, ${failures.length} FAILED:\n  ${failures.join('\n  ')}` : ', all OK'),
);
if (programs === 0) console.log(`(no program name contains "${filter}")`);
process.exit(failures.length || programs === 0 ? 1 : 0);
