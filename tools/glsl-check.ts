/**
 * Offline GLSL ES 3.00 validation using glslangValidator, emulating the prefix that
 * three.js r186 prepends to a ShaderMaterial (no glslVersion set — see FRAG_PREFIX).
 *
 * Usage from a script run with `npx tsx`:
 *   import { checkShader, checkMaterial } from '../tools/glsl-check';
 *   const ok = checkMaterial('mandelbulb', material);           // a THREE.ShaderMaterial
 *   const ok2 = checkShader('frag', fragmentSource, 'name');     // raw sources
 * Prints errors with line numbers mapped to the assembled source; returns true if valid.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The package ships x64 binaries for Windows, Linux (CI) and macOS.
const SUFFIX: Record<string, string> = { win32: '.exe', linux: '.linux', darwin: '.darwin' };
const EXE = resolve(
  here,
  `../node_modules/glslang-validator-prebuilt-predownloaded/bin/glslangValidator${SUFFIX[platform()] ?? '.exe'}`,
);
if (platform() !== 'win32') {
  try {
    chmodSync(EXE, 0o755); // npm does not always keep the executable bit
  } catch {
    // Missing binary: execFileSync below reports it.
  }
}

const COMMON_PREFIX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp samplerCube;
precision highp sampler3D;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
`;

const VERT_PREFIX = `${COMMON_PREFIX}#define attribute in
#define varying out
#define texture2D texture
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
in vec3 position;
in vec3 normal;
in vec2 uv;
`;

// three r186, ShaderMaterial WITHOUT glslVersion: declares pc_fragColor, #defines gl_FragColor and
// always prepends the colour-space helpers + luminance(). (With glslVersion = GLSL3 three declares
// NO output at all — this project therefore never sets glslVersion.)
const FRAG_PREFIX = `${COMMON_PREFIX}#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define gl_FragDepthEXT gl_FragDepth
#define texture2D texture
#define textureCube texture
vec4 LinearTransferOETF( in vec4 value ) { return value; }
vec4 sRGBTransferEOTF( in vec4 value ) { return value; }
vec4 sRGBTransferOETF( in vec4 value ) { return value; }
vec4 linearToOutputTexel( vec4 value ) { return LinearTransferOETF( value ); }
float luminance( const in vec3 rgb ) { const vec3 weights = vec3( 0.2126, 0.7152, 0.0722 ); return dot( weights, rgb ); }
`;

function definesBlock(defines?: Record<string, unknown>): string {
  if (!defines) return '';
  return Object.entries(defines)
    .filter(([, v]) => v !== false)
    .map(([k, v]) => `#define ${k} ${v === true ? '' : String(v)}`)
    .join('\n') + '\n';
}

export function checkShader(
  stage: 'vert' | 'frag',
  source: string,
  name = 'shader',
  defines?: Record<string, unknown>,
): boolean {
  const full = (stage === 'vert' ? VERT_PREFIX : FRAG_PREFIX) + definesBlock(defines) + source;
  const dir = mkdtempSync(join(tmpdir(), 'glslcheck-'));
  const file = join(dir, `${name.replace(/[^a-z0-9_-]/gi, '_')}.${stage}`);
  writeFileSync(file, full);
  try {
    execFileSync(EXE, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`✔ ${name}.${stage} OK`);
    return true;
  } catch (e: any) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    const lines = full.split('\n');
    console.log(`✘ ${name}.${stage} FAILED`);
    for (const line of out.split('\n')) {
      const m = line.match(/ERROR: [^:]*:(\d+): (.*)/);
      if (m) {
        const ln = Number(m[1]);
        console.log(`  line ${ln}: ${m[2]}\n    > ${(lines[ln - 1] ?? '').trim()}`);
      } else if (line.trim()) console.log('  ' + line.trim());
    }
    return false;
  }
}

/** Validate both stages of a THREE.ShaderMaterial-like object. */
export function checkMaterial(
  name: string,
  mat: { vertexShader: string; fragmentShader: string; defines?: Record<string, unknown> },
): boolean {
  const a = checkShader('vert', mat.vertexShader, name, mat.defines);
  const b = checkShader('frag', mat.fragmentShader, name, mat.defines);
  return a && b;
}
