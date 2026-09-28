// Sanity check that the shared GLSL contracts compile.
import { COMMON_GLSL, CAMERA_UNIFORMS_GLSL } from '../src/render/shaders/common';
import { SKY_SAMPLE_GLSL } from '../src/render/sky/skyShared';
import { FULLSCREEN_VERT } from '../src/render/RenderContext';
import { checkShader } from './glsl-check';

const frag = `${COMMON_GLSL}\n${CAMERA_UNIFORMS_GLSL}\n${SKY_SAMPLE_GLSL}\nin vec2 vUv;\nvoid main(){\n  vec3 rd = cameraRay(gl_FragCoord.xy, uResolution, uCamRot, uTanHalf);\n  vec3 c = sampleSky(rd) + blackbody(5800.0)*fbm3(rd*4.0, 4);\n  gl_FragColor = vec4(c, 1.0);\n  gl_FragDepth = logDepth(1.0);\n}\n`;
const ok = checkShader('vert', FULLSCREEN_VERT, 'contracts') && checkShader('frag', frag, 'contracts');
process.exit(ok ? 0 : 1);
