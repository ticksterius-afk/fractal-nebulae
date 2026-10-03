/**
 * First Light — chapter 1 "Bend", The Cauliflower Nebula (Mandelbulb, absorbing surfaces).
 * design/20-first-light.md §3.1, §6; design/60-first-light-build.md §L. Authored by WP L1.
 *
 * The chapter teaches the whole core mechanic from zero, one true thing per level:
 *   1 Almost            (show)     the unlensed beam grazes the seed; one light mass beside it, early, leans it on.
 *   2 Behind the Floret (use)      a floret hides the seed from the star; the turn must come after the floret's tip.
 *   3 Close Pass        (use)      a 43° turn needs a pass just outside the dark disc (α = 2rₛ/b).
 *   4 Too Close         (surprise) one heavy mass: its wider dark disc swallows the beam at the distance level 3 taught.
 *   5 Serpentine        (combine)  two masses in series: dip onto the low seed, then swing up to the high one (an S).
 *   6 Garland           (combine)  a heavy lift and a medium levelling: equal, opposite bends shift the light sideways.
 *
 * Placement is 2-D in play: a click puts the mass beside the beam at the beam's depth (build plan §1 #2). So every
 * bend here is laid out face-on to the vantage: each solution is reachable by a click at the snapped depth, from the
 * vantage, in play order (checked with a snap-sheet scan from the vantage and the lab camera). Every level passes
 * `npx tsx tools/fl-check.ts --levels src/game/firstlight/levels/bend.ts` (gate seeds = the level ids).
 * Budget = par everywhere (no spare mass).
 */
import type { ChapterDef } from '../types';

export const BEND: ChapterDef = {
  id: 'bend',
  name: 'Bend',
  nebula: 'bulb',
  rule: 'A mass bends light toward itself; closer bends harder; too close swallows it.',
  levels: [
    {
      id: 'bend-1',
      chapter: 'bend',
      index: 1,
      name: 'Almost',
      nebula: 'bulb',
      clock: 0,
      arena: {
        centerLocal: [-0.053067, 0.56123, -0.709898],
        radiusLocal: 0.072,
        vantage: { pos: [-0.154033, 0.59288, -0.707317], lookAt: [-0.082006, 0.561922, -0.729087] },
      },
      source: {
        pos: [-0.10287, 0.543357, -0.700937],
        dir: [0.571640348639328, 0.529142946673599, -0.6270845666998098],
      },
      seeds: [
        { id: 'a', pos: [-0.071037, 0.572217, -0.746738], radius: 0.0036, kind: 'seed', goal: true },
      ],
      masses: { light: 0.000864, medium: 0.001584, heavy: 0.00252 },
      budget: { light: 1 },
      solution: [{ size: 'light', pos: [-0.096466, 0.549764, -0.720965] }],
      hints: [
        'The beam already passes close beside the seed. It needs only a small lean, toward the seed’s side.',
        'A light mass in this sphere, early on the beam’s path, gives that small lean room to grow.',
        'Place the light mass to the left of the beam, about a fifth of the way from the star, a little more than one seed-width out. The beam leans about 11° and crosses the seed. Nearer the seed, the mass must sit nearer the beam.',
      ],
      hintMass: 0,
      teach: 'A mass bends light toward itself: α = 2rₛ/b.',
      tip: {
        label: 'Eddington, 1919',
        text: 'On 29 May 1919, stars beside the eclipsed Sun appeared shifted outward: their light had bent by α = 2rₛ/b, 1.75″ at the Sun’s rim.',
      },
      par: 1,
    },
    {
      id: 'bend-2',
      chapter: 'bend',
      index: 2,
      name: 'Behind the Floret',
      nebula: 'bulb',
      clock: 0,
      arena: {
        centerLocal: [0.702562, -0.665742, -0.288955],
        radiusLocal: 0.144,
        vantage: { pos: [0.689261, -0.564396, -0.454314], lookAt: [0.702562, -0.665742, -0.288955] },
      },
      source: {
        pos: [0.779747, -0.720313, -0.381114],
        dir: [-0.5405661167958175, 0.8090192447557234, 0.23081623640283574],
      },
      seeds: [
        { id: 'a', pos: [0.632362, -0.584742, -0.344755], radius: 0.0072, kind: 'seed', goal: true },
      ],
      masses: { light: 0.001728, medium: 0.003168, heavy: 0.00504 },
      budget: { medium: 1 },
      solution: [{ size: 'medium', pos: [0.712006, -0.653086, -0.364441] }],
      hints: [
        'The star cannot see the seed: the hanging floret is in the way. Notice where the beam passes closest to that floret’s tip.',
        'Here, where the beam slips past the floret’s tip: a turn here clears it.',
        'Place the medium mass on the right of the beam, right beside the tip of the hanging floret, about one and a half seed-widths out. The beam turns about 25° to the right, slips past the floret and crosses the seed.',
      ],
      hintMass: 0,
      teach: 'One bend steers light around what blocks it: the star need not see the seed.',
      par: 1,
    },
    {
      id: 'bend-3',
      chapter: 'bend',
      index: 3,
      name: 'Close Pass',
      nebula: 'bulb',
      clock: 0,
      arena: {
        centerLocal: [-0.765363, 0.426528, -0.448388],
        radiusLocal: 0.072,
        vantage: { pos: [-0.850181, 0.449546, -0.406868], lookAt: [-0.765363, 0.426528, -0.448388] },
      },
      source: {
        pos: [-0.815975, 0.439752, -0.469769],
        dir: [0.4431962140321131, -0.20969046567751828, 0.8715543726420899],
      },
      seeds: [
        { id: 'a', pos: [-0.793263, 0.405828, -0.411488], radius: 0.0036, kind: 'seed', goal: true },
      ],
      masses: { light: 0.000864, medium: 0.001584, heavy: 0.00252 },
      budget: { medium: 1 },
      solution: [{ size: 'medium', pos: [-0.798978, 0.424149, -0.430355] }],
      hints: [
        'This turn is much sharper than the last one. How hard a mass bends depends on how close the light passes it.',
        'Close in, here: near enough to turn the light hard, not so near that it falls in.',
        'Place the medium mass just below the beam, a little past halfway along it, about one seed-width out, just outside its dark disc. The beam turns about 43° down the slope and crosses the seed.',
      ],
      hintMass: 0,
      teach: 'Closer passes bend more: halve the distance, double the bend (α = 2rₛ/b).',
      par: 1,
    },
    {
      id: 'bend-4',
      chapter: 'bend',
      index: 4,
      name: 'Too Close',
      nebula: 'bulb',
      clock: 0,
      arena: {
        centerLocal: [-0.660159, -0.240739, 0.446895],
        radiusLocal: 0.072,
        vantage: { pos: [-0.739112, -0.207861, 0.386499], lookAt: [-0.659181, -0.245623, 0.472241] },
      },
      source: {
        pos: [-0.709977, -0.261183, 0.461727],
        dir: [0.9799353263672421, 0.16788413766489169, 0.10743217608352962],
      },
      seeds: [
        { id: 'a', pos: [-0.633618, -0.229987, 0.483161], radius: 0.0036, kind: 'seed', goal: true },
      ],
      masses: { light: 0.000864, medium: 0.001584, heavy: 0.00252 },
      budget: { heavy: 1 },
      solution: [{ size: 'heavy', pos: [-0.656903, -0.242774, 0.474263] }],
      hints: [
        'Watch the dark disc around the heavy mass: light that enters it never comes out, and this disc is wider than the last one.',
        'Here, above the beam and well out: a heavy mass turns light hard even from a distance.',
        'Place the heavy mass above the beam, shortly before the wall, about one and a half seed-widths out. The light passes just outside its dark disc and turns about 40° up over the wall’s edge onto the seed. Much closer and the disc swallows the beam.',
      ],
      hintMass: 0,
      teach: 'Light that dips inside the photon sphere, 1.5 rₛ, never comes back out.',
      tip: {
        label: 'Photon sphere',
        text: 'At 1.5 rₛ light can orbit a mass in a circle: the photon sphere. Light that dips inside it never leaves.',
      },
      par: 1,
    },
    {
      id: 'bend-5',
      chapter: 'bend',
      index: 5,
      name: 'Serpentine',
      nebula: 'bulb',
      clock: 0,
      arena: {
        centerLocal: [-0.380728, -0.760186, 0.517696],
        radiusLocal: 0.144,
        vantage: { pos: [-0.453148, -0.773776, 0.353468], lookAt: [-0.4344, -0.781477, 0.399176] },
      },
      source: {
        pos: [-0.514331, -0.782811, 0.512163],
        dir: [0.9621781132869859, -0.020592016600875507, -0.27164176255466627],
      },
      seeds: [
        { id: 'a', pos: [-0.422722, -0.796321, 0.48276], radius: 0.0072, kind: 'seed', goal: true },
        { id: 'b', pos: [-0.274528, -0.772786, 0.436696], radius: 0.0072, kind: 'seed', goal: true },
      ],
      masses: { light: 0.001728, medium: 0.003168, heavy: 0.00504 },
      budget: { medium: 2 },
      solution: [
        { size: 'medium', pos: [-0.514224, -0.809627, 0.503913] },
        { size: 'medium', pos: [-0.380283, -0.78344, 0.46946] },
      ],
      hints: [
        'One seed sits just below the beam; the other lies higher up, past the wall where the beam dies. One mass can lean the beam only one way.',
        'Begin here, below the beam beside the star: a gentle dip toward the low seed.',
        'Place one medium mass below the beam right beside the star, about two seed-widths out, to dip it onto the low seed. Place the other just above the dipped beam, a third of the way from the low seed to the high one, about one and a half seed-widths out: it swings the light up about 24° along the cauliflower’s underside onto the high seed.',
      ],
      hintMass: 0,
      teach: 'Bends add in series: each mass turns the light once, toward itself.',
      par: 2,
    },
    {
      id: 'bend-6',
      chapter: 'bend',
      index: 6,
      name: 'Garland',
      nebula: 'bulb',
      clock: 0,
      arena: {
        centerLocal: [0.921727, 0.33554, -0.286131],
        radiusLocal: 0.096,
        vantage: { pos: [0.96141, 0.290376, -0.389984], lookAt: [0.947841, 0.321288, -0.353101] },
      },
      source: {
        pos: [0.98914, 0.35312, -0.289766],
        dir: [-0.9643331217387734, 0.10657327605425229, -0.2422886030101624],
      },
      seeds: [
        { id: 'a', pos: [0.94676, 0.366284, -0.309262], radius: 0.0048, kind: 'seed', goal: true },
        { id: 'b', pos: [0.884527, 0.37274, -0.328131], radius: 0.0048, kind: 'seed', goal: true },
        { id: 'c', pos: [0.866489, 0.373313, -0.334932], radius: 0.0048, kind: 'seed', goal: true },
      ],
      masses: { light: 0.001152, medium: 0.002112, heavy: 0.00336 },
      budget: { medium: 1, heavy: 1 },
      solution: [
        { size: 'heavy', pos: [0.986237, 0.366861, -0.304497] },
        { size: 'medium', pos: [0.928873, 0.360638, -0.309492] },
      ],
      hints: [
        'The three seeds hang in a line just above the beam and parallel to it. One bend would cross that line, not follow it.',
        'The heavy mass belongs here, above the beam close to the star, to lift the light toward the first seed.',
        'Place the heavy mass above the beam right beside the star, about two seed-widths out: the beam rises about 21° through the first seed. Then place the medium mass just below the raised beam, a little past the first seed, about one and a half seed-widths out: it turns the light back down about 22°, level along the other two.',
      ],
      hintMass: 0,
      teach: 'Two equal, opposite bends move light sideways without turning it.',
      par: 2,
    },
  ],
};
