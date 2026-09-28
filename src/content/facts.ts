/**
 * Short texts for the HUD: facts shown one at a time while cruising the void between nebulae,
 * and physics tips flashed when the traveller first experiences an effect.
 * Every void fact stays ≤ 180 characters so it fits the small HUD ticker.
 */
import {
  C_MULTIPLE_PER_LY_S,
  MPH_PER_LY_S,
  formatCount,
  formatInt,
  nebulaDiameterRange,
  voyageExtentLy,
} from './astro';
import { sci } from '../core/units';

export type PhysicsTipKey = 'hyper' | 'aberration' | 'lensing' | 'timeDilation' | 'wormhole' | 'pulse' | 'scale';

const DIAM = nebulaDiameterRange();
const C_MULT = formatCount(C_MULTIPLE_PER_LY_S, 3); // "31.6 million"
const MPH = sci(MPH_PER_LY_S, 2); // "2.1 × 10¹⁶"

export const VOID_FACTS: string[] = [
  // --- Fractals: words, coastlines, dimensions -----------------------------------------------
  'Benoît Mandelbrot coined the word “fractal” in 1975, from the Latin fractus — “broken” or “fractured”.',
  'How long is Britain’s coastline? It depends on your ruler: the finer you measure, the longer it gets. Mandelbrot made this paradox famous in 1967.',
  'Using Lewis Fry Richardson’s data, Mandelbrot showed Britain’s west coast behaves like a curve of dimension ≈ 1.25 — more than a line, less than a plane.',
  'Mandelbrot (1982): “Clouds are not spheres, mountains are not cones.” Nature’s geometry is rough — and roughness has its own mathematics.',
  'Clouds are fractal: their outlines have a dimension of about 1.35 whether they span one kilometre or a thousand (Lovejoy, 1982).',
  'A dimension can be a fraction: the Koch snowflake curve is ≈ 1.26-dimensional — more than a line, not quite a surface.',
  'The Koch snowflake has an infinitely long perimeter, yet it encloses a finite area: exactly 8/5 of the triangle it grew from.',
  'The whole Mandelbrot set fits inside a circle of radius 2, yet its edge is infinitely detailed — infinity you could hold in your palm.',
  'Zoom into the Mandelbrot set’s edge anywhere and you will eventually meet tiny copies of the whole set — “minibrots”, without end.',

  // --- The universe & scale ------------------------------------------------------------------
  'The cosmic web: galaxies gather into filaments and walls around vast empty voids — clustered like a fractal on smaller scales, smooth on the very largest.',
  'The Milky Way is about 100,000 light-years across and holds some 100–400 billion stars. Light from its centre takes about 26,000 years to reach us.',
  'Andromeda’s light left it about 2.5 million years ago — you see it as it was when our distant ancestors were chipping simple stone tools in Africa.',
  'The observable universe is about 93 billion light-years across and holds hundreds of billions of galaxies — perhaps even trillions.',
  'Real star-forming nebulae are this big: the Eagle Nebula spans about 70 × 55 light-years, and its tallest Pillar of Creation is about 4 light-years long.',
  `The nebulae on this voyage are ${DIAM.min}–${DIAM.max} light-years across: even light needs ${DIAM.min} to ${DIAM.max} years to cross one.`,
  `This voyage’s nebulae are scattered across some ${formatInt(voyageExtentLy())} light-years. For comparison, the Orion Nebula lies about 1,350 light-years from Earth.`,
  `This ship’s gravity drive is pure fiction: 1 ly/s is about ${C_MULT} times light speed. Relativity forbids it — imagination doesn’t.`,
  'Sunlight takes about 8 minutes 20 seconds to reach Earth. From the nearest other star, Proxima Centauri, light needs about 4.2 years.',
  'One astronomical unit (AU) is the Earth–Sun distance, about 150 million km. A single light-year is about 63,000 AU.',

  // --- Fractals in living things -------------------------------------------------------------
  'Your lungs fold roughly 50–75 m² of breathing surface — the floor of a small apartment — into your chest by branching about 23 times.',
  'Your blood vessels branch so thoroughly that almost every cell in your body lies within a fraction of a millimetre of a capillary.',
  'A healthy heartbeat is not a metronome: the intervals between beats fluctuate in a fractal pattern, and losing that complexity can signal illness.',
  'Romanesco broccoli is a living fractal: every cone is built from smaller cones, arranged in spirals whose counts are Fibonacci numbers.',
  'Trees, lungs, rivers and blood vessels branch alike, perhaps because they face the same problem: linking every point of a space to one trunk at low cost.',
  'A single Purkinje neuron in your cerebellum spreads a flat, fractal fan of dendrites that can receive signals through as many as 200,000 synapses.',
  'Lettuce leaves, corals and sea slugs ruffle because they grow more edge than flat space can hold — nature doing non-Euclidean geometry.',
  'Snowflakes, ferns, lightning, rivers, clouds: nature reuses a handful of fractal strategies to branch, fill space and spread with little effort.',
  'Fractal antennas — self-similar shapes that pick up many frequencies in a tiny space — have been used in mobile devices and radios since the 1990s.',

  // --- Perception ----------------------------------------------------------------------------
  'People tend to find fractals of medium complexity (dimension ≈ 1.3–1.5) the most relaxing — the range of many clouds, trees and coastlines (Richard Taylor).',
  'Physicist Richard Taylor found that Jackson Pollock’s drip paintings are fractal — and grew more complex, with higher dimension, as his career went on.',
  'Eye-tracking studies suggest our gaze itself wanders in fractal paths — one reason nature’s fractals may feel so effortless, even soothing, to look at.',
  'Under a truly dark sky you can see a few thousand stars with the naked eye — out of hundreds of billions in the Milky Way alone.',

  // --- Light, colour & telescopes ------------------------------------------------------------
  'The Hubble palette maps invisible chemistry to colour: sulfur (SII) shows as red, hydrogen-alpha as green, doubly ionised oxygen (OIII) as blue.',
  'Hydrogen’s famous red glow, Hα, comes from electrons dropping from the third energy level to the second, emitting light at 656 nanometres.',
  'JWST’s six bright star spikes come from the edges of its hexagonal mirror segments; the vertical strut holding its secondary mirror adds a faint horizontal pair.',
  'The Pillars of Creation are sculpted by light: ultraviolet from hot young stars boils gas away, leaving dense columns shadowed by denser knots.',
  'Nearly every atom in you heavier than hydrogen — the carbon, the oxygen, the iron in your blood — was forged in stars and scattered by their deaths.',
  'Aberration of starlight: in 1729 James Bradley reported that stars shift as Earth moves, like rain slanting as you run. Near light speed the sky crowds forward.',
  'Doppler shift: light from something approaching is squeezed bluer; from something receding, stretched redder. Galaxy redshifts revealed the expanding universe.',

  // --- Sound -----------------------------------------------------------------------------------
  'Space is silent to our ears, but not to physics: pressure waves around a black hole in the Perseus cluster sound a B-flat 57 octaves below middle C.',
  'NASA “sonifies” telescope images, turning light into sound — just as this voyage turns every fractal nebula into music.',
];

export const PHYSICS_TIPS: Record<PhysicsTipKey, string> = {
  hyper:
    `Right mouse engages the gravity drive — pure science fiction. The HUD’s numbers are honest arithmetic, though: ` +
    `1 ly/s is about ${C_MULT} times light speed (c), or ${MPH} mph.`,
  aberration:
    'At extreme speed the sky rushes ahead of you: starlight crowds toward your direction of travel and turns bluer, ' +
    'while the view behind reddens and fades — relativistic aberration and Doppler shift.',
  lensing:
    'Mass bends light. Around a black hole, starlight curves into arcs and a bright Einstein ring — ' +
    'you are seeing stars that actually lie behind it.',
  timeDilation:
    'Deep in a black hole’s gravity, time itself slows: a clock at radius r ticks at √(1 − rₛ/r) of a distant ' +
    'clock’s rate, slower still toward the horizon. Listen — the music slows and deepens with it.',
  wormhole:
    'You crossed the horizon into an Einstein–Rosen bridge. Real ones (1935) pinch shut before even light can pass — ' +
    'this ride is poetic licence. Enjoy the far side.',
  pulse:
    'A resonance pulse: like sonar or LIDAR, a wavefront sweeps outward, lighting every surface it touches ' +
    'and revealing every nebula on your HUD.',
  scale:
    'Fractals are self-similar: however deep you dive, more detail waits. Your drive slows near surfaces, ' +
    'so you can keep falling into structure — forever.',
};
