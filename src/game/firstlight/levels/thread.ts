/**
 * First Light — chapter 2 "Thread", The Menger Lattice (Menger sponge, absorbing surfaces).
 * design/20-first-light.md §3.1, §3.2, §6; design/60-first-light-build.md §L. Authored by WP L2.
 *
 * The sponge's straight square tunnels are the feature: light keeps to lines of sight, and turns only
 * where a mass bends it. One true thing per level:
 *   1 Threshold      (show)     outside the sponge, the beam strikes the face just below a tunnel mouth’s sill;
 *                               one mass above it lifts the light into the doorway.
 *   2 Chimney        (use)      the beam crosses a junction too shallowly and strikes the chimney wall; a mass
 *                               above it steepens the climb (there is no "down": light bends toward the mass).
 *   3 Elbow          (use)      a rising beam must swing ~47° into a side tunnel: one heavy mass passed close,
 *                               where the true bend far exceeds 2rₛ/b.
 *   4 Periscope      (combine)  two heavy masses, opposite bends: the beam rises across the junction and levels
 *                               again, shifted up (two seeds, one per leg).
 *   5 Sightline      (combine)  two seeds mark a line toward the far tunnel that the beam's line never meets
 *                               (skew by 5 r): two masses in series, one to aim and one to align.
 *   6 Deep Sightline (surprise) level 5 one self-similar step down (p → ⅔ + p/3: arena, seeds, masses ⅓ as large).
 *
 * Frames (local): the mouth of the corner sub-cube's +x tunnel on the x = 1 face [1, ⅔, ⅔] (1); the corner
 * sub-cube's junction [⅔, ⅔, ⅔] (2, 4, 5); the edge sub-cube's junction [0, ⅔, ⅔] (3); and the corner of the
 * corner sub-cube [8/9, 8/9, 8/9] (6). Tunnels there are 2/9 wide with 2/27 windows; arenas R 0.13–0.16 (6: 0.053).
 *
 * Placement (decision #2 of the build plan): a click snaps the mass to the beam's depth, so a snapped mass always
 * sits at right angles to the line of sight and bends the light across the screen, never into it. Every vantage
 * therefore looks straight at the plane of its bends (each authored mass's offset from the beam is within 5° of
 * the view plane), and every authored mass is itself a snapped click from the vantage (56–79 px from the beam at
 * 720p; the snap reaches 86 px). Flight-click windows from the vantage (720p px²): 1 ≈ 8200, 2 ≈ 8500,
 * 3 ≈ 2200; 4–6: second mass ≈ 2300–3200 after the authored first, first-click region ≈ 5000.
 * Levels 4–6 also pass a strong single-mass search (12 seeds × 6000 evaluations: none solves). Every level passes
 * `npx tsx tools/fl-check.ts --levels src/game/firstlight/levels/thread.ts` (gate seeds = the level ids).
 * Budget = par everywhere (no spare mass).
 */
import type { ChapterDef } from '../types';

export const THREAD: ChapterDef = {
  id: 'thread',
  name: 'Thread',
  nebula: 'menger',
  rule: 'Line of sight through tunnels; two lenses in series.',
  levels: [
    {
      id: 'thread-1',
      chapter: 'thread',
      index: 1,
      name: 'Threshold',
      nebula: 'menger',
      clock: 0,
      arena: {
        centerLocal: [1.04, 0.606667, 0.586667],
        radiusLocal: 0.13,
        vantage: { pos: [1.2, 0.596667, 0.586667], lookAt: [1, 0.556667, 0.576667] },
      },
      source: {
        pos: [1.075, 0.541667, 0.476667],
        dir: [-0.4995450660931236, -0.026642403524966617, 0.8658781145614143],
      },
      seeds: [
        { id: 'a', pos: [0.985, 0.568667, 0.616667], radius: 0.0078, kind: 'seed', goal: true },
      ],
      masses: { light: 0.00156, medium: 0.00286, heavy: 0.00455 },
      budget: { medium: 1 },
      solution: [
        { size: 'medium', pos: [1.043621, 0.566271, 0.521802] },
      ],
      hints: [
        'The beam strikes the wall just below the doorway’s sill, where the seed glows. Light bends toward a mass: what would lift it a little?',
        'A mass in this sphere, just above the beam, lifts it over the sill.',
        'Place the medium mass a little over a third of the way from the star to the wall, nearly two seed-widths above the beam. The beam bends upward about 15°, clears the sill and crosses the seed just inside the doorway.',
      ],
      hintMass: 0,
      teach: 'Light keeps a straight line of sight until a mass bends it.',
      tip: {
        label: 'Line of sight',
        text: 'Around 1020 Ibn al-Haytham showed with the camera obscura that light travels in straight lines. In empty space only gravity can bend it.',
      },
      par: 1,
    },
    {
      id: 'thread-2',
      chapter: 'thread',
      index: 2,
      name: 'Chimney',
      nebula: 'menger',
      clock: 0,
      arena: {
        centerLocal: [0.676667, 0.686667, 0.636667],
        radiusLocal: 0.15,
        vantage: { pos: [0.696667, 0.663167, 0.466667], lookAt: [0.676667, 0.691667, 0.666667] },
      },
      source: {
        pos: [0.816667, 0.596667, 0.666667],
        dir: [-0.7885023060177911, 0.6150317986938771, 0],
      },
      seeds: [
        { id: 'a', pos: [0.628542, 0.803542, 0.656042], radius: 0.0075, kind: 'seed', goal: true },
      ],
      masses: { light: 0.0018, medium: 0.0033, heavy: 0.00525 },
      budget: { medium: 1 },
      solution: [
        { size: 'medium', pos: [0.745801, 0.685858, 0.660013] },
      ],
      hints: [
        'The beam climbs too shallowly and strikes the chimney wall just inside its mouth. What would make it climb more steeply?',
        'A mass in this sphere, above the beam, steepens its climb.',
        'Place the medium mass inside the crossing, just above the beam, nearly two seed-widths from it. The beam bends about 17° upward and climbs the chimney to the seed.',
      ],
      hintMass: 0,
      teach: 'There is no down in space: light bends toward a mass, whichever way it lies.',
      par: 1,
    },
    {
      id: 'thread-3',
      chapter: 'thread',
      index: 3,
      name: 'Elbow',
      nebula: 'menger',
      clock: 0,
      arena: {
        centerLocal: [-0.04, 0.646667, 0.696667],
        radiusLocal: 0.15,
        vantage: { pos: [-0.25, 0.636667, 0.743967], lookAt: [0, 0.626667, 0.746667] },
      },
      source: {
        pos: [0, 0.506667, 0.696667],
        dir: [0, 0.9396836309567854, 0.34204484166826987],
      },
      seeds: [
        { id: 'a', pos: [-0.00775, 0.608417, 0.793917], radius: 0.009, kind: 'seed', goal: true },
      ],
      masses: { light: 0.0018, medium: 0.0033, heavy: 0.0075 },
      budget: { heavy: 1 },
      solution: [
        { size: 'heavy', pos: [-0.003684, 0.552587, 0.74543] },
      ],
      hints: [
        'The seed waits just inside the side tunnel, off to one side of the rising beam. A gentle bend would not turn the light that far; a close pass by a heavy mass can.',
        'The heavy mass belongs in this sphere, close beside the rising beam.',
        'Place the heavy mass low in the shaft, beside the beam on the side-tunnel side, about four rₛ from it: its dark disc nearly touches the beam. The light swings through about 47° into the side tunnel and crosses the seed. Much closer and it is captured.',
      ],
      hintMass: 0,
      teach: 'A close pass bends light far more than 2rₛ/b: near a mass, light turns corners.',
      par: 1,
    },
    {
      id: 'thread-4',
      chapter: 'thread',
      index: 4,
      name: 'Periscope',
      nebula: 'menger',
      clock: 0,
      arena: {
        centerLocal: [0.666667, 0.666667, 0.686667],
        radiusLocal: 0.15,
        vantage: { pos: [0.707367, 0.623267, 0.884967], lookAt: [0.697267, 0.625167, 0.685267] },
      },
      source: {
        pos: [0.506667, 0.596667, 0.666667],
        dir: [1, 0, 0],
      },
      seeds: [
        { id: 'a', pos: [0.683367, 0.642267, 0.666667], radius: 0.0075, kind: 'seed', goal: true },
        { id: 'b', pos: [0.823567, 0.656167, 0.666667], radius: 0.0075, kind: 'seed', goal: true },
      ],
      masses: { light: 0.0018, medium: 0.0033, heavy: 0.00525 },
      budget: { heavy: 2 },
      solution: [
        { size: 'heavy', pos: [0.537485, 0.632005, 0.667448] },
        { size: 'heavy', pos: [0.745476, 0.63595, 0.668252] },
      ],
      hints: [
        'Both seeds sit above the beam, and the far one lies on a line parallel to it. One bend leaves the light tilted: it can cross one seed, never both.',
        'The first heavy mass belongs in this sphere, close to the star.',
        'Place one heavy mass above the beam close to the star, about five seed radii up: the beam rises about 20° and crosses the near seed. Place the other just below the rising beam past the crossing, about four seed radii from it: it bends the light back down, level again and higher, through the far seed.',
      ],
      hintMass: 0,
      teach: 'Two opposite bends shift a beam sideways; equal ones leave it parallel.',
      par: 2,
    },
    {
      id: 'thread-5',
      chapter: 'thread',
      index: 5,
      name: 'Sightline',
      nebula: 'menger',
      clock: 0,
      arena: {
        centerLocal: [0.616667, 0.666667, 0.696667],
        radiusLocal: 0.16,
        vantage: { pos: [0.626667, 0.666667, 0.476667], lookAt: [0.686667, 0.636667, 0.766667] },
      },
      source: {
        pos: [0.561667, 0.571667, 0.631667],
        dir: [0.7557628568737571, 0.030688839718020534, 0.6541259047666426],
      },
      seeds: [
        { id: 'a', pos: [0.681719, 0.626437, 0.76344], radius: 0.008, kind: 'seed', goal: true },
        { id: 'b', pos: [0.757054, 0.6384, 0.821709], radius: 0.008, kind: 'seed', goal: true },
      ],
      masses: { light: 0.00192, medium: 0.004, heavy: 0.0056 },
      budget: { medium: 2 },
      solution: [
        { size: 'medium', pos: [0.567705, 0.594551, 0.650598] },
        { size: 'medium', pos: [0.687519, 0.602884, 0.743985] },
      ],
      hints: [
        'Follow the line through the two seeds back toward the star: it runs beside the beam’s line but never meets it.',
        'The first mass belongs in this sphere, just after the star.',
        'Place one medium mass just after the star, about three seed radii above the beam: it aims the light up toward the seeds’ line. Place the second just below that new path, shortly before the first seed: it bends the light back down along the line through both seeds.',
      ],
      hintMass: 0,
      teach: 'To join a line it never crosses, light needs two bends: one to aim, one to align.',
      par: 2,
    },
    {
      id: 'thread-6',
      chapter: 'thread',
      index: 6,
      name: 'Deep Sightline',
      nebula: 'menger',
      clock: 0,
      arena: {
        centerLocal: [0.872222, 0.888889, 0.898889],
        radiusLocal: 0.053333,
        vantage: { pos: [0.875556, 0.888889, 0.825556], lookAt: [0.895556, 0.878889, 0.922222] },
      },
      source: {
        pos: [0.853889, 0.857222, 0.877222],
        dir: [0.7557628568737571, 0.030688839718020534, 0.6541259047666426],
      },
      seeds: [
        { id: 'a', pos: [0.893906, 0.875479, 0.921147], radius: 0.002667, kind: 'seed', goal: true },
        { id: 'b', pos: [0.919018, 0.879467, 0.94057], radius: 0.002667, kind: 'seed', goal: true },
      ],
      masses: { light: 0.00064, medium: 0.001333, heavy: 0.001867 },
      budget: { medium: 2 },
      solution: [
        { size: 'medium', pos: [0.855902, 0.86485, 0.883533] },
        { size: 'medium', pos: [0.89584, 0.867628, 0.914662] },
      ],
      hints: [
        'Have you been here before? Compare the tunnels with the last level’s: their shape, not their size.',
        'The first mass belongs in this sphere, just after the star, where it went last time.',
        'This is the last level’s junction one self-similar step down: every length, the masses included, is a third as large. Place the masses as before: one just after the star, a little above the beam; one shortly before the first seed, just below the new path.',
      ],
      hintMass: 0,
      teach: 'The same junction, three times smaller: the sponge repeats itself at every scale.',
      par: 2,
    },
  ],
};
