/**
 * The Codex: educational content for every nebula in the catalog (ARCHITECTURE.md §3.9).
 *
 *   CODEX         one entry per nebula id (title = catalog name)
 *   VOID_FACTS    short facts shown one at a time while cruising between nebulae
 *   PHYSICS_TIPS  one-line explanations of what the traveller is seeing / doing
 *
 * Sizes and black-hole figures are derived from the live catalog (see ./astro.ts), so they
 * stay true if the catalog is retuned. Everything else is hand-checked prose: when a figure
 * is uncertain it is phrased as "about", "roughly" or "reported".
 */
import type { CodexEntry } from '../core/types';
import { NEBULA_BY_ID } from '../universe/catalog';
import { FRACTALS } from '../fractals/registry';
import { KM_PER_LY, sci } from '../core/units';
import {
  ORION_NEBULA_LY,
  blackHoleOf,
  evaporationLog10Years,
  formatCount,
  hawkingTemperatureK,
  inMandelbrot,
  kerrEfficiency,
  kerrHorizonRs,
  kerrIscoRs,
  lyPerLocal,
  pillars,
  roundNice,
  sig2,
  sig3,
  solarMassesForRs,
  spanLy,
  superscript,
} from './astro';

export { VOID_FACTS, PHYSICS_TIPS } from './facts';
export type { PhysicsTipKey } from './facts';

type EntryBody = Omit<CodexEntry, 'id' | 'title'>;

/** Builds an entry whose id/title always match the catalog. */
function entry(id: string, fallbackTitle: string, body: EntryBody): CodexEntry {
  return { id, title: NEBULA_BY_ID[id]?.name ?? fallbackTitle, ...body };
}

// ---------------------------------------------------------------------------------------------
// Derived figures. The ly-per-local-unit scale comes from the live catalog and fractal registry
// (worldRadius / boundRadius). The shapes' LOCAL extents are fixed by construction in
// src/fractals/*.ts; update them here if a fractal's framing changes:
//   Menger: cube [−1, 1]³                         → side   = 2 local units
//   Mandelbox: cube corners at ≈ 1.5 from centre  → side   = 2 · 1.5/√3
//   Sierpiński: circumradius 1.5 (uP[0].w)        → height = ⁴⁄₃ · 1.5
//   Apollonian & Kleinian: ball radius 1.5        → width  = 3
// Bulb, Julia, KIFS and tree are quoted by their bounding-sphere diameter ("up to").
// ---------------------------------------------------------------------------------------------
const BULB_LY = spanLy('bulb', 45);
/**
 * Range of the Mandelbulb's (polar) power over its breathing loop (mandelbulb.ts animate: uP[0].x),
 * sampled so the text follows retuning; null when it does not breathe noticeably.
 */
function bulbPowerRange(): { lo: string; hi: string } | null {
  const f = FRACTALS.mandelbulb;
  if (!f.animate) return null;
  const p = new Float32Array(16);
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 0; t < 600; t += 0.5) {
    f.animate(f.defaultParams, t, p);
    if (!Number.isFinite(p[0])) return null;
    lo = Math.min(lo, p[0]);
    hi = Math.max(hi, p[0]);
  }
  return hi - lo >= 0.1 ? { lo: lo.toFixed(1), hi: hi.toFixed(1) } : null;
}
const BULB_POWER = bulbPowerRange();
const MENGER_SIDE_LY = roundNice(2 * lyPerLocal('menger', 50 / 1.8));
const BOX_SIDE_LY = roundNice(((2 * 1.5) / Math.sqrt(3)) * lyPerLocal('box', 55 / 1.6));
const JULIA_LY = spanLy('julia', 42);
const SIERPINSKI_HEIGHT_LY = roundNice((4 / 3) * 1.5 * lyPerLocal('sierpinski', 48 / 1.56));
const APOLLONIAN_LY = roundNice(3 * lyPerLocal('apollonian', 45 / 1.53));
const KLEINIAN_LY = roundNice(3 * lyPerLocal('kleinian', 60 / 1.53));
const KIFS_LY = spanLy('kifs', 40);
const TREE_LY = spanLy('tree', 55);
/** A real lightning channel is a few kilometres long (≈ 5 km). */
const TREE_VS_LIGHTNING = sci((TREE_LY * KM_PER_LY) / 5, 2);

/** Mandelbox scale S (uP[0].x), guarded so a layout change cannot print nonsense. */
const BOX_SCALE_RAW = FRACTALS.mandelbox.defaultParams[0];
const BOX_SCALE = Number.isFinite(BOX_SCALE_RAW) && Math.abs(BOX_SCALE_RAW) > 1 && Math.abs(BOX_SCALE_RAW) < 5
  ? sig3(BOX_SCALE_RAW)
  : '2.75';
/**
 * Where the Julia veil's constant sits relative to the Mandelbrot set over its morph loop
 * (julia.ts: uP[0] = c quaternion; the loop closes every 1200 s). The set's connectivity follows
 * the complex Julia set of a + b·i, with b = |imaginary part|.
 */
function juliaEdge(): 'inside' | 'outside' | 'both' {
  const f = FRACTALS.julia;
  const p = new Float32Array(16);
  let inside = 0;
  let n = 0;
  for (let t = 0; t < 1200; t += 30, n++) {
    if (f.animate) f.animate(f.defaultParams, t, p);
    else for (let i = 0; i < 16; i++) p[i] = f.defaultParams[i] ?? 0;
    if (!Number.isFinite(p[0] + p[1] + p[2] + p[3])) return 'both';
    if (inMandelbrot(p[0], Math.hypot(p[1], p[2], p[3]))) inside++;
  }
  return inside === 0 ? 'outside' : inside === n ? 'inside' : 'both';
}
const JULIA_EDGE_NOTE = {
  outside: 'This veil’s c hovers just outside the edge: dust on the verge of joining up.',
  inside: 'This veil’s c sits just inside the edge: a veil that barely holds together.',
  both: 'This veil’s c wanders back and forth across the edge, so the veil tears and knits again.',
}[juliaEdge()];

/** Dimension figures shared with the HUD banner ("label · D≈…"), so both always agree. */
const KLEINIAN_D = sig2(FRACTALS.kleinian.dimension);
const KIFS_D = sig3(FRACTALS.kifs.dimension);
const TREE_D = sig2(FRACTALS.tree.dimension);

const EYE = blackHoleOf('bh-eye', 3, 0.9, 1.6);
const EYE_MASS = formatCount(solarMassesForRs(EYE.rs));
const EYE_SPIN_PCT = Math.round(EYE.spin * 100);
const EYE_HORIZON = sig2(kerrHorizonRs(EYE.spin));
const EYE_ISCO = sig3(kerrIscoRs(EYE.spin, true));
const EYE_EFFICIENCY_PCT = Math.round(kerrEfficiency(EYE.spin) * 100);

const MAW = blackHoleOf('bh-maw', 5, 0, 3);
const MAW_M = solarMassesForRs(MAW.rs);
const MAW_MASS = formatCount(MAW_M);
const MAW_SHADOW_LY = Math.max(1, Math.round(Math.sqrt(27) * MAW.rs)); // diameter = 2 · (√27/2) rₛ
const MAW_HAWKING_K = sci(hawkingTemperatureK(MAW_M), 2);
const MAW_EVAP = `10${superscript(evaporationLog10Years(MAW_M))}`;
/** Whether the Maw's disk is drawn with its inner edge at the Schwarzschild ISCO (3 rₛ). */
const MAW_DISK_AT_ISCO = Math.abs(MAW.diskInner - 3) < 0.25;

// ---------------------------------------------------------------------------------------------

export const CODEX: Record<string, CodexEntry> = {
  bulb: entry('bulb', 'The Cauliflower Nebula', {
    fractalName: 'Mandelbulb (power 8)',
    formula: 'zₙ₊₁ = zₙ⁸ + c   (spherical coordinates: r → r⁸, θ → 8θ, φ → 8φ)',
    dimension: 'A solid, so 3 by volume; its surface’s dimension is not known rigorously — perhaps close to 3',
    discovered:
      'Daniel White & Paul Nylander, 2009 — after 3-D Mandelbrot experiments by Rudy Rucker (1987) and ' +
      'Jules Ruis (1997). Their spherical “triplex” power formula bloomed most beautifully at power 8.',
    summary:
      'Take the Mandelbrot rule — square and add — and lift it into three dimensions: treat each point as a ' +
      'radius and two angles, raise the radius to the 8th power, multiply both angles by 8, add the starting ' +
      'point, and repeat. The points that never escape form the Mandelbulb, a bulbous bloom whose every floret ' +
      'sprouts smaller florets, forever.',
    nature: [
      'Cauliflower and broccoli — florets of florets (reported dimensions ≈ 2.8 and ≈ 2.7)',
      'Romanesco — spiralling cones of cones, with Fibonacci numbers of spirals',
      'Cumulus clouds, billowing in lumps upon lumps',
      'Volcanic eruption columns and “cauliflower” ash plumes',
      'Cauliflower coral (Pocillopora) heads on tropical reefs',
      'Cauliflower-like grains in thin films grown from vapour',
    ],
    facts: [
      'No 3-D number system can divide the way complex numbers do — mathematicians proved it; the next one up is ' +
        'the 4-D quaternions. The Mandelbulb’s spherical power is an ingenious workaround.',
      'Low powers look soft and blobby; around power 8 the detail explodes into florets, spires and whorls — ' +
        'which is why this power became the classic.' +
        (BULB_POWER
          ? ` Here the power slowly breathes between about ${BULB_POWER.lo} and ${BULB_POWER.hi}, so the florets ` +
            'swell and fold as you watch.'
          : ''),
      'Its details never quite repeat: zoom in and you meet whipped-cream swirls, coral, spirals and spires, ' +
        'endlessly varied rather than exact copies.',
      'Film artists love it: the wormhole climax of Disney’s “Big Hero 6” (2014) is a stylised Mandelbulb ' +
        'interior, and the alien being in “Annihilation” (2018) takes the form of a partial Mandelbulb.',
      `This nebula spans roughly ${BULB_LY} light-years — compare the whole Eagle Nebula, home of the Pillars ` +
        'of Creation, at about 70 × 55 light-years.',
    ],
    musicNote:
      'D Lydian warmth at 64 bpm — analog pads bloom like florets while a soft marimba arpeggio of eight steps ' +
      '(one per power) mutates cycle by cycle, and a flute wanders in call and response.',
  }),

  menger: entry('menger', 'The Menger Lattice', {
    fractalName: 'Menger sponge',
    formula: 'Mₙ₊₁ = ⋃ (⅓·Mₙ + tᵢ), i = 1…20   — keep 20 of 27 sub-cubes, forever',
    dimension: '≈ 2.7268 (log 20 / log 3)',
    discovered:
      'Karl Menger, 1926 — while pinning down what “dimension” really means. It is the 3-D sibling of ' +
      'Sierpiński’s carpet (1916).',
    summary:
      'Split a cube into 27 like a Rubik’s cube, then remove the centre cube and the six at the centres of the ' +
      'faces. Repeat on each of the 20 survivors, forever. What remains has zero volume yet infinite surface — ' +
      'a lattice of square tunnels within tunnels.',
    nature: [
      'Spongy bone (trabeculae) — strength with very little weight',
      'Sea sponges and their porous skeletons',
      'Metal foams and aerogels — mostly empty, with vast inner surfaces',
      'Activated charcoal — hundreds to thousands of m² of surface per gram',
      'Porous rocks and soils, whose pore networks are often fractal',
      'Engineering: fractal antennas and ultralight lattice materials',
    ],
    facts: [
      'Zero volume, infinite surface: each step keeps 20/27 of the volume — after 10 steps only about 5 % is ' +
        'left — while the surface area grows without limit.',
      'Menger proved it is a “universal curve”: every curve you could ever draw, however tangled, fits ' +
        'topologically inside it.',
      'Each face is a Sierpiński carpet — and a slice through the centre, perpendicular to a long diagonal, ' +
        'reveals a hidden pattern of six-pointed stars.',
      'Origami artist Jeannine Mosely folded a level-3 Menger sponge from about 66,000 business cards.',
      'Its geometry speaks in threes: 3 × 3 × 3 grids, ⅓ scaling, and a dimension, log 20 / log 3, that ' +
        'literally means “20 copies at one-third size”.',
      `This lattice is about ${MENGER_SIDE_LY} light-years on a side, with a hot young star blazing in its ` +
        'central chamber — its light pours out along every tunnel.',
    ],
    musicNote:
      'C♯ minor pentatonic in 3/4 at 72 bpm — the number three everywhere. Glassy plucks play a Cantor-set ' +
      'rhythm (27 triplet steps with the middle thirds removed, the sponge’s one-dimensional cousin) over a ' +
      'resonant low pedal, like light echoing down stone tunnels.',
  }),

  box: entry('box', 'The Cathedral Nebula', {
    fractalName: 'Mandelbox',
    formula: `z ← S · sphereFold(boxFold(z)) + c   (scale S = ${BOX_SCALE} here)`,
    dimension: 'Not known rigorously — at this scale the folding leaves mostly open space: vaulted walls and lace around vast halls',
    discovered: 'Tom Lowe (“Tglad”), 2010 — discovered and explored by the Fractal Forums community.',
    summary:
      'The Mandelbox bends space instead of multiplying numbers. Each step folds a point back into a box, ' +
      'turns space inside-out within a small sphere, then scales it and adds the starting point. Repeat, and ' +
      'the points that never fly away form vaulted galleries, rose windows and endless halls.',
    nature: [
      'Karst caves — chambers opening into chambers, carved by water',
      '“Box folds” in rock strata — a real term in structural geology',
      'Termite mounds, laced with galleries and ventilation shafts',
      'Gothic cathedrals — arches within arches, tracery within tracery',
      'Hindu temple spires (shikharas) built from miniature copies of the whole',
      'Fractal village layouts in African design (Ron Eglash, 1999)',
    ],
    facts: [
      'Its folds are conformal — they preserve angles — so its ornaments stay crisp spheres, cubes and arches ' +
        'instead of smearing like the Mandelbulb’s.',
      'The box fold is just a reflection and the sphere fold an inversion — the same mirror tools that weave ' +
        'the Kleinian web elsewhere in this sky.',
      `One number, the scale, reshapes everything: at 2 the Mandelbox is a dense, ornate fortress; at ${BOX_SCALE}, ` +
        'used here, its interior opens into halls wide enough to fly through.',
      'It was discovered on an online forum and mapped by a whole community sharing renders — a fractal born in ' +
        'the age of forums, not journals.',
      `This cathedral is about ${BOX_SIDE_LY} light-years on a side: a ray of light entering one rose window ` +
        'needs decades to cross the nave.',
    ],
    musicNote:
      'A Dorian at a stately 56 bpm — organ- and choir-like pads over a pedal bass and rare deep bell tolls, ' +
      'sent deep into a vast, dark hall reverb that lets every note fill the vaults.',
  }),

  julia: entry('julia', 'The Julia Veil', {
    fractalName: 'Quaternion Julia set',
    formula: 'qₙ₊₁ = qₙ² + c,   q, c ∈ ℍ (quaternions)   — a 3-D slice of a 4-D set',
    dimension: 'Depends on c — flat Julia sets reach at most 2; no exact figure is known for this 3-D slice of a 4-D set',
    discovered:
      'Gaston Julia & Pierre Fatou, 1918 (complex Julia sets); Alan Norton, 1982 (first quaternion images); ' +
      'ray-traced by Hart, Sandin & Kauffman, 1989.',
    summary:
      'Julia sets come from the simplest rule in chaos: square a number, add a constant c, repeat — the points ' +
      'that never escape form the set. Here the numbers are quaternions, four-dimensional numbers, so the set ' +
      'is a 4-D object and you are flying through one 3-D slice of it. As c slowly wanders, the veil breathes ' +
      'and tears.',
    nature: [
      'The Veil Nebula in Cygnus — shock filaments from a star that exploded roughly 10,000–20,000 years ago',
      'Kelvin–Helmholtz billows in clouds and in Jupiter’s cloud bands',
      'Cream swirling into coffee — chaos stretching and folding',
      'Animal populations: the logistic map x → r·x(1 − x) is z² + c in disguise',
      'Dripping taps, heart rhythms and lasers that turn chaotic by period doubling',
    ],
    facts: [
      'William Rowan Hamilton discovered quaternions in a flash on 16 October 1843 and carved ' +
        'i² = j² = k² = ijk = −1 into Dublin’s Broom Bridge.',
      'Gaston Julia wrote his prize-winning 1918 memoir while recovering from severe First World War wounds — ' +
        'six decades before computers could draw the sets he described.',
      'Every constant c gives a different Julia set. The Mandelbrot set is their map: inside it, Julia sets are ' +
        `connected; outside, they shatter into “Fatou dust”. ${JULIA_EDGE_NOTE}`,
      'Quaternions quietly run the world of rotation: spacecraft, phones and game engines — and this ship’s ' +
        'orientation — use them to avoid gimbal lock.',
      'You are seeing a shadow of the fourth dimension: a 3-D slice of a 4-D shape, the way a CT scan shows 2-D ' +
        'slices of a 3-D body.',
      `The veil spans up to ~${JULIA_LY} light-years — about ${pillars(JULIA_LY)} Pillars of Creation laid end ` +
        'to end.',
    ],
    musicNote:
      'Whole-tone and Lydian-augmented harmony with no firm home, at 60 bpm — shimmering detuned choir pads and ' +
      'harp-like glissandi drift like the veil itself.',
  }),

  sierpinski: entry('sierpinski', 'Sierpiński’s Pyramid', {
    fractalName: 'Sierpiński tetrahedron (tetrix)',
    formula: 'T = ⋃ ½(T + vᵢ), i = 1…4   — four half-size copies toward the corners',
    dimension: 'Exactly 2 (log 4 / log 2)',
    discovered:
      'Wacław Sierpiński, 1915 (the triangle); the tetrahedron is its 3-D extension. The motif already ' +
      'decorates medieval Cosmati floors in Italian churches.',
    summary:
      'Take a tetrahedron, keep the four half-size tetrahedra at its corners and throw away the octahedron in ' +
      'the middle. Repeat forever: four copies at half the size, every time. The result has dimension exactly ' +
      '2 — a pyramid that is, in a precise sense, as “thin” as a flat sheet.',
    nature: [
      'Conus textile sea-snail shells — pigment patterns like cellular automata',
      'Pascal’s triangle: colour its odd numbers and Sierpiński’s triangle appears',
      'Molecules coaxed into self-assembling nanoscale Sierpiński triangles (2015)',
      'Fractal antennas — Sierpiński-gasket shapes that resonate on several bands',
      'Alexander Graham Bell’s tetrahedral kites, built from thousands of cells (1900s)',
    ],
    facts: [
      'Each step keeps exactly half the volume (4 × ⅛), so after 10 steps less than 0.1 % remains — yet the ' +
        'total surface area never changes at all.',
      'Seen along the line joining the midpoints of two opposite edges, its shadow is a perfect, completely ' +
        'filled square — fitting for a shape of dimension 2.',
      'Play the chaos game: pick a random corner, jump halfway there, mark a dot, repeat. Out of pure ' +
        'randomness, this pyramid appears.',
      'Sierpiński published more than 700 papers and 50 books; a crater on the Moon bears his name.',
      `This pyramid stands about ${SIERPINSKI_HEIGHT_LY} light-years tall — some ${pillars(SIERPINSKI_HEIGHT_LY)} ` +
        'Pillars of Creation stacked end to end.',
    ],
    musicNote:
      'A major pentatonic at 80 bpm — FM bells in perfect fifths and octaves play a rhythm read from Pascal’s ' +
      'triangle (its odd entries draw Sierpiński’s triangle), then replay it at half and a quarter of the size, ' +
      'just as the pyramid repeats itself.',
  }),

  apollonian: entry('apollonian', 'The Pearl Foam', {
    fractalName: 'Apollonian sphere packing',
    formula: '(k₁ + k₂ + k₃ + k₄ + k₅)² = 3(k₁² + … + k₅²)   — curvatures of 5 kissing spheres',
    dimension: '≈ 2.4739 (numerical estimate)',
    discovered:
      'Apollonius of Perga, c. 200 BC (the tangent-circle problem); Descartes’ circle theorem, 1643; Frederick ' +
      'Soddy extended it to spheres in “The Kiss Precise”, 1936.',
    summary:
      'Fill a ball with four mutually touching pearls, then keep filling every curved gap with the largest ' +
      'sphere that fits — forever. The pearls shrink without end until they fill the whole volume, yet an ' +
      'infinitely intricate froth of gaps and contact points remains. Here each pearl is shrunk a little, ' +
      'opening passages you can fly through.',
    nature: [
      'Soap foam and bubble rafts, with bubbles of every size',
      'Pumice and lava, riddled with gas bubbles across many scales',
      'Concrete and asphalt — stones of many sizes packed to leave few voids',
      'Sand and powders, fine grains filling the gaps between coarse ones',
      'Network science: “Apollonian networks” model scale-free webs (2005)',
    ],
    facts: [
      'Frederick Soddy, 1921 Nobel laureate in Chemistry, announced the kissing-sphere law as a poem, ' +
        '“The Kiss Precise”, published in Nature in 1936.',
      'In the flat Apollonian gasket, if the first four circles have whole-number curvatures, every one of the ' +
        'infinitely many circles does too.',
      'The flat gasket has dimension ≈ 1.3057; in 3-D the packing rises to ≈ 2.4739 — a dust of gaps with no ' +
        'volume at all.',
      'Inversion in a sphere turns space inside-out yet maps every sphere to a sphere — so this whole foam can ' +
        'be generated by just five mirror spheres.',
      'René Descartes described the circle version in a 1643 letter to Princess Elisabeth of Bohemia.',
      `The foam fills a ball about ${APOLLONIAN_LY} light-years wide — roughly ` +
        `${Math.max(1, Math.round(APOLLONIAN_LY / ORION_NEBULA_LY))} Orion Nebulae side by side.`,
    ],
    musicNote:
      'F Dorian at 66 bpm — glassy FM bells on golden-ratio timing (a Fibonacci rhythm that never quite ' +
      'repeats), with quick bubbly figures rising like pearls through foam.',
  }),

  kleinian: entry('kleinian', 'Indra’s Web', {
    fractalName: 'Pseudo-Kleinian limit set',
    formula: 'z ← 2·clamp(z, −c, c) − z;   z ← z · max(R²/|z|², 1)   — box mirrors + sphere inversion',
    dimension: `≈ ${KLEINIAN_D} (rough estimate — limit-set dimensions vary with the group)`,
    discovered:
      'Felix Klein & Henri Poincaré, 1880s (Kleinian groups); popularised by “Indra’s Pearls” (Mumford, ' +
      'Series & Wright, 2002); the 3-D pseudo-Kleinian form by Knighty, 2011.',
    summary:
      'A Kleinian group is a family of symmetries built from reflections and sphere inversions; apply them ' +
      'again and again, and points pile up on an infinitely detailed “limit set”. Here box mirrors and one ' +
      'mirror sphere repeat forever, so every jewel in the web reflects every other — the ancient image of ' +
      'Indra’s net, made mathematical.',
    nature: [
      'Dew-covered spider webs — every droplet mirrors the rest',
      'Facing mirrors and kaleidoscopes, reflecting into infinity',
      'Ruffled corals, lettuce leaves and sea slugs — hyperbolic growth',
      'Crystal symmetry groups that tile space atom by atom',
      'M. C. Escher’s “Circle Limit” prints (1958–60), after Coxeter’s hyperbolic tilings',
      'Cosmology: some candidate shapes for the universe are built from such symmetry groups',
    ],
    facts: [
      'Indra’s net comes from Buddhist philosophy (the Avataṃsaka Sūtra): an infinite net with a jewel at every ' +
        'knot, each reflecting all the others.',
      'Klein and Poincaré raced each other through a flurry of letters in 1881–82 to understand these groups; ' +
        'Poincaré named them after his rival.',
      'Fields medallist David Mumford co-wrote “Indra’s Pearls” to share these limit sets with everyone, with ' +
        'pictures computed over many years.',
      'Knighty’s 2011 trick replaced true Möbius maps with box folds and a sphere inversion — turning flat ' +
        'limit-set art into worlds you can fly through.',
      'Thurston showed that, in a precise sense, most 3-D spaces are hyperbolic — described by Kleinian groups; ' +
        'Perelman’s 2003 proof of geometrisation completed the picture.',
      `The web is about ${KLEINIAN_LY} light-years across, and each tiny jewel near its heart is an inverted ` +
        'image of an entire infinite lattice.',
    ],
    musicNote:
      'B Dorian at 58 bpm — canons, then phrases mirrored in time (retrograde) and in pitch (inversion), answer ' +
      'each other between bell and celesta through ping-pong echoes: the music reflects itself, as the web does.',
  }),

  kifs: entry('kifs', 'The Frost Kaleidoscope', {
    fractalName: 'Kaleidoscopic IFS snow crystal',
    formula: 'z ← S · R(fold(z)) − (S − 1)·C   — mirror-fold, rotate, scale, repeat',
    dimension: `≈ ${KIFS_D} (estimate for this crystal; in general log N / log S)`,
    discovered:
      'Knighty, 2010, on Fractal Forums — building on iterated function systems (John Hutchinson, 1981; ' +
      'Michael Barnsley, 1980s).',
    summary:
      'A kaleidoscopic IFS folds space through mirrors, as a kaleidoscope does, then rotates, scales and shifts ' +
      'it — and repeats. Each pass multiplies the pattern into mirrored copies of itself, so a few planes grow ' +
      'spires, frost ferns and snowflake arms. This one is a “capped column”: a hexagonal ice lantern with a ' +
      'star-shaped plate at each end, lit by a star inside.',
    nature: [
      'Snowflakes — six-fold dendrites grown from hexagonal ice',
      'Capped columns — a real snow habit formed as a crystal falls through changing temperatures',
      'Frost ferns on windowpanes and hoarfrost on branches',
      'Metal dendrites in cooling alloys and ammonium-chloride crystals',
      'Radiolarian and diatom skeletons — glassy symmetry (Haeckel, 1904)',
    ],
    facts: [
      'Johannes Kepler wrote “On the Six-Cornered Snowflake” in 1611, wondering why snow is always six-fold. ' +
        'The answer — hexagonal ice — came with X-ray crystallography three centuries later.',
      'Ukichiro Nakaya grew the first artificial snow crystals in the 1930s and mapped their shapes: plates ' +
        'near −2 °C, needles near −5 °C, ferny dendrites near −15 °C.',
      'Wilson Bentley photographed his first snowflake in 1885 and captured more than 5,000 in his lifetime, ' +
        'finding no two alike.',
      'The Sierpiński pyramid and the Menger sponge are special cases of kaleidoscopic IFS — just particular ' +
        'choices of mirrors and scale.',
      'Sir David Brewster invented the kaleidoscope in 1816 while studying the polarisation of light.',
      `This snowflake spans up to ~${KIFS_LY} light-years — as wide as a globular star cluster packed with ` +
        'hundreds of thousands of stars.',
    ],
    musicNote:
      'E Lydian and major-9 colours at 76 bpm — celesta arpeggios climb six notes and mirror back down like ' +
      'snowflake arms, sparkling in a cold, shimmering reverb, like light through ice.',
  }),

  tree: entry('tree', 'The Lichtenberg Nebula', {
    fractalName: 'Branching dendrite (Lichtenberg figure)',
    formula: 'branch → 2 branches × r, turned ±θ;   cluster mass N(R) ∝ Rᴰ',
    dimension: `≈ ${TREE_D} for this dendrite (estimate) · diffusion-limited aggregation: ≈ 1.71 in 2-D, ≈ 2.5 in 3-D`,
    discovered:
      'Georg Christoph Lichtenberg, 1777 (discharge figures in dust); diffusion-limited aggregation by Thomas ' +
      'Witten & Leonard Sander, 1981; dielectric-breakdown model by Niemeyer, Pietronero & Wiesmann, 1984.',
    summary:
      'When electricity punches through an insulator, it forks again and again into a luminous tree — a ' +
      'Lichtenberg figure. The same branching appears whenever growth feeds on something diffusing in: the tips ' +
      'that reach furthest catch the most, so they grow faster and split. Branches of branches of branches — ' +
      'the shape of lightning, rivers, lungs and neurons.',
    nature: [
      'Lightning bolts, forking across the sky',
      'Fern-like “Lichtenberg” marks on lightning-strike survivors (they usually fade within a day)',
      'River networks and deltas seen from orbit',
      'Your airways: about 23 generations of branching from windpipe to alveoli',
      'Neurons — dendritic arbours like the cerebellum’s Purkinje cells',
      'Blood vessels, tree crowns and roots',
      'Manganese-oxide dendrites on rock, often mistaken for fossil plants',
    ],
    facts: [
      'Your lungs pack roughly 50–75 m² of gas-exchange surface into your chest; that surface’s reported ' +
        'fractal dimension is ≈ 2.97 — almost space-filling.',
      'A lightning channel is only a few centimetres wide, yet heats the air to around 30,000 K — roughly five ' +
        'times hotter than the surface of the Sun.',
      'Lichtenberg saw his first figures in 1777, in dust settling on a charged resin plate — the same trick of ' +
        'powder and static charge that photocopiers use today.',
      'Leonardo da Vinci noticed that when a tree forks, the daughter branches’ cross-sections add up to the ' +
        'parent’s — a tree’s thickness is conserved as it branches.',
      'Murray’s law (1926): at each fork of a blood vessel, the cube of the parent’s radius equals the sum of ' +
        'the cubes of its daughters’ — the cheapest way to pump blood.',
      `This nebula spans up to ~${TREE_LY} light-years — a lightning bolt frozen mid-strike, some ` +
        `${TREE_VS_LIGHTNING} times longer than a real one.`,
    ],
    musicNote:
      'G Mixolydian at 70 bpm — soft electric-piano melodies fork into two voices like a branching bolt and ' +
      'rejoin, over warm pads and distant thunder swells.',
  }),

  'bh-eye': entry('bh-eye', 'Ouroboros', {
    fractalName: 'Rotating (Kerr) black hole · Julia-set accretion disk',
    formula: `r₊ = ½rₛ(1 + √(1 − χ²)) ≈ ${EYE_HORIZON} rₛ at χ = ${sig2(EYE.spin)}   ·   disk: zₙ₊₁ = zₙ² + c`,
    dimension: 'Horizon: a smooth 2-D surface · disk: Julia-set filigree from a c at the very edge of the Mandelbrot set (up to 2)',
    discovered:
      'Roy Kerr, 1963 (the rotating black-hole solution); Karl Schwarzschild, 1916; the name “black hole” ' +
      'popularised by John Wheeler, 1967; first image: Event Horizon Telescope, M87*, 2019.',
    summary:
      `A black hole spinning at ${EYE_SPIN_PCT} % of the maximum possible rate, dragging space itself around ` +
      'like water circling a drain. Its accretion disk — gas spiralling inward at a large fraction of light ' +
      'speed — is painted with the feathery filigree of a Julia set, while twin relativistic jets blast out along ' +
      'the spin axis. Ouroboros, the serpent eating its tail: here, light itself can loop around and return.',
    nature: [
      'M87* — 6.5 billion Suns, imaged by the Event Horizon Telescope in 2019',
      'M87’s jet — a plasma beam about 5,000 light-years long',
      'Blazars — galaxies whose black-hole jets point almost straight at us',
      'SS 433 — a microquasar in our galaxy with precessing jets at about 26 % of light speed',
      'Young stars like HL Tauri, whose dusty disks ALMA imaged in 2014',
      'Whirlpools and hurricanes — rotating flows that wind patterns into spirals',
    ],
    facts: [
      'In 2019 the Event Horizon Telescope — radio dishes across the Earth acting as one planet-sized telescope ' +
        '— revealed the first image of a black hole: M87*, about 55 million light-years away.',
      'For “Interstellar” (2014), Kip Thorne and the visual-effects team computed the spinning black hole ' +
        'Gargantua so carefully that they published a scientific paper on its lensing (2015).',
      'Roger Penrose showed in 1969 that energy can be mined from a black hole’s spin — up to 29 % of the mass ' +
        'of a maximally rotating one.',
      'Some supermassive black holes appear to spin at over 90 % of the maximum rate — much like this one.',
      'The disk’s pattern is a Julia set for z² + c (c ≈ −0.10 + 0.65i), sheared by Kepler’s laws: inner gas ' +
        'orbits faster than outer gas, winding the fractal into trailing spirals.',
    ],
    physics: [
      `Mass & size: rₛ = 2GM/c² — about 3 km for the Sun. Here rₛ ≈ ${sig2(EYE.rs)} ly, a mass of ~${EYE_MASS} ` +
        'Suns — far heavier than any known black hole (the record-holders weigh tens of billions).',
      `Spin χ = ${sig2(EYE.spin)} shrinks the horizon to r₊ ≈ ${EYE_HORIZON} rₛ, wrapped in an ergosphere ` +
        '(out to rₛ at the equator) where nothing can stay still relative to the distant stars.',
      'Frame dragging (Lense–Thirring, 1918): spinning mass twists spacetime. Gravity Probe B measured the tiny ' +
        'effect around Earth in 2011; here it swirls the whole sky.',
      `ISCO: gas orbits stably down to 3 rₛ around a non-spinning hole, but prograde orbits here reach ≈ ${EYE_ISCO} rₛ ` +
        `(~0.5 rₛ for a maximal spinner). Falling that deep, gas can shine away ~${EYE_EFFICIENCY_PCT} % of its mass ` +
        'as light — versus ~6 % with no spin and up to ~42 % at maximal spin.',
      'Doppler beaming: gas swinging toward you looks brighter and bluer, the receding side dimmer and redder — ' +
        'the lopsided glow in the EHT image of M87*.',
      'Relativistic jets: magnetic fields threading the spinning horizon can tap its rotation and launch plasma ' +
        'at nearly light speed (Blandford–Znajek, 1977).',
      'Wormhole: Einstein and Rosen found in 1935 that black-hole geometry can bridge two regions of space — ' +
        'but the bridge pinches shut before even light can cross. This passage is poetic licence.',
      'Simulation note: the lensing here uses Schwarzschild light paths plus a frame-dragging swirl — a visual ' +
        'stand-in for the full Kerr geometry.',
    ],
    musicNote:
      'B Phrygian at a slow 48 bpm — auto-panned pads swirl around you like dragged spacetime while an endless ' +
      'descending Shepard tone pulls you down; near the horizon, time dilation slows and deepens everything.',
  }),

  'bh-maw': entry('bh-maw', 'The Maw', {
    fractalName: 'Schwarzschild black hole · Mandelbrot-set accretion disk',
    formula: 'rₛ = 2GM/c²   ·   dτ/dt = √(1 − rₛ/r)   ·   disk: zₙ₊₁ = zₙ² + c',
    dimension: 'Horizon: a smooth sphere · disk: Mandelbrot boundary, exactly 2 (Shishikura, 1998)',
    discovered:
      'Karl Schwarzschild, 1916 — the first exact solution of Einstein’s equations, found while serving on the ' +
      'Russian front. The Mandelbrot set was first drawn by computer in 1978–80 (Brooks & Matelski; Benoît ' +
      'Mandelbrot at IBM).',
    summary:
      'The simplest black hole there is: no spin, no charge — just mass curving spacetime so steeply that inside ' +
      'the horizon every path leads inward. Its accretion disk is spun from the Mandelbrot set, sheared into ' +
      `rings of fire by orbital motion. The black disk ahead is its shadow, about ${MAW_SHADOW_LY} light-years across.`,
    nature: [
      'Sagittarius A* — 4 million Suns at the heart of the Milky Way, imaged in 2022',
      'Cygnus X-1 — the first widely accepted black hole (1970s), about 21 Suns',
      'GW150914 — two black holes (≈ 36 and 29 Suns) merging, heard by LIGO in 2015',
      'Quasars — accretion disks outshining whole galaxies across the universe',
      'X-ray binaries, where a black hole strips gas from a companion star',
    ],
    facts: [
      'The Mandelbrot set is the map of all Julia sets: one rule, z² + c, yet its boundary is so convoluted ' +
        'that its dimension is exactly 2 (Shishikura, 1998).',
      'π hides in the Mandelbrot set: count the iterations near its “neck” at c = −¾ and π appears — found by ' +
        'Dave Boll in 1991.',
      'For all the computing power thrown at it, the Mandelbrot set’s area is still known only approximately — ' +
        'about 1.506.',
      'John Michell imagined “dark stars”, too massive for light to escape, in 1783 — more than a century ' +
        'before Einstein.',
      'The 2022 image of Sgr A*, our galaxy’s own black hole, looks strikingly like M87* although it is over a ' +
        'thousand times less massive — just as general relativity predicts.',
    ],
    physics: [
      `Event horizon at rₛ = 2GM/c² — about 3 km for the Sun, 9 mm for Earth. Here rₛ = ${sig2(MAW.rs)} ly: ` +
        `a mass of ~${MAW_MASS} Suns, heavier than any black hole known.`,
      'Photon sphere at 1.5 rₛ: light can orbit here, unstably. Hovering there and looking sideways, you could ' +
        'in principle see the back of your own head.',
      'Shadow: the black disk has a radius of ≈ 2.6 rₛ (√27 ⁄ 2 · rₛ) — larger than the horizon, because the ' +
        'hole lenses its own silhouette.',
      'ISCO at 3 rₛ: closer in, no stable orbit exists and gas plunges inward — ' +
        (MAW_DISK_AT_ISCO
          ? 'which is why this disk’s bright inner edge sits right there.'
          : 'so a real accretion disk’s bright inner edge sits near there.'),
      'Time dilation & redshift: a clock hovering at r ticks at √(1 − rₛ/r) of a distant clock’s rate. At ' +
        '1.1 rₛ one of your hours is ~3.3 hours outside, and your light arrives stretched 3.3× in wavelength.',
      'Spaghettification: tidal stretching grows as M/r³. A stellar-mass black hole would shred you before its ' +
        'horizon; one this huge could be crossed without feeling a thing — the tidal peril here is dramatic licence.',
      `Hawking radiation (1974): quantum effects make black holes glow. This one would sit near ${MAW_HAWKING_K} K ` +
        `— far colder than the 2.7 K cosmic background — and need ~${MAW_EVAP} years to evaporate.`,
      'Einstein–Rosen bridge (1935): mathematically this geometry links to another region of space, but the ' +
        'throat pinches shut faster than light can cross. A traversable wormhole would need exotic negative ' +
        'energy (Morris & Thorne, 1988) — this passage is poetic licence.',
    ],
    musicNote:
      'C minor with Locrian shadows at 40 bpm — deep sub drones and low brass-like swells over a slow heartbeat; ' +
      'near the horizon, time dilation drags tempo and pitch down.',
  }),
};
