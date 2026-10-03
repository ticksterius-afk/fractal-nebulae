/**
 * First Light — chapter "Reflect" (apollonian, The Pearl Foam). Authored by WP L3, re-cut by its playtest critic
 * (design/20-first-light.md §3.1, §6; design/60-first-light-build.md §L): every surface here is a mirror and each
 * bounce keeps 0.7 of the light (a seed needs 0.3, so three bounces at most). Order: show → use → use → combine →
 * combine → surprise. Every solution mass sits beside the beam at the beam's own depth from the vantage, where the
 * game's beam snap puts a click: a click aimed at it solves, with a one-click window of ≥ 400 px² (fl-check's `reach`
 * gate; levels 2–5 were re-aimed by WP L4 — new vantages, and new solution points for 2, 4 and 5, 2 with a medium
 * mass — because the snap picked another leg of the beam there; the 2 and 5 points then moved a little toward the
 * beam so the aimed click also snaps with a 60° FOV). Every level passes tools/fl-check.ts.
 */
import type { ChapterDef } from '../types';

export const REFLECT: ChapterDef = {
  id: 'reflect',
  name: 'Reflect',
  nebula: 'apollonian',
  rule: 'Pearls reflect; each bounce keeps seven tenths of the light.',
  levels: [
    {
      id: 'reflect-1',
      chapter: 'reflect',
      index: 1,
      name: 'Glance',
      nebula: 'apollonian',
      clock: 0,
      arena: {
        centerLocal: [1.018224, -0.450821, -0.205749],
        radiusLocal: 0.0765,
        vantage: { pos: [0.913608, -0.460347, -0.192586], lookAt: [0.992979, -0.457947, -0.19343] },
      },
      source: {
        pos: [0.977873, -0.462527, -0.220531],
        dir: [0.2304580318534493, -0.25752863366046846, 0.9383859005756676],
      },
      seeds: [
        {
          id: 'a',
          pos: [0.975275, -0.458702, -0.164596],
          radius: 0.00459,
          kind: 'seed',
          goal: true,
        },
      ],
      masses: { light: 0.000918, medium: 0.001683, heavy: 0.002678 },
      budget: { medium: 1 },
      solution: [{ size: 'medium', pos: [0.985284, -0.453407, -0.195229] }],
      hints: [
        'The light already glances off the great pearl and climbs just under the seed. Watch how the bounce swings when the beam meets the pearl a little further along.',
        'Above the incoming beam, a little past halfway from the star to the pearl.',
        'A medium mass just above the incoming beam lifts it; the light meets the pearl a little further along and climbs more steeply, through the seed.',
      ],
      hintMass: 0,
      teach: 'Angle in equals angle out: move where light meets a pearl and the bounce swings.',
      tip: {
        label: 'Law of reflection',
        text: 'Angle in equals angle out, both measured from the surface normal. Hero of Alexandria saw why, about 60 CE: of all the paths that touch a mirror on the way between two points, light takes the shortest.',
      },
      par: 1,
    },
    {
      id: 'reflect-2',
      chapter: 'reflect',
      index: 2,
      name: 'Turn Away',
      nebula: 'apollonian',
      clock: 0,
      arena: {
        centerLocal: [-0.28901, -0.38488, -0.938493],
        radiusLocal: 0.1071,
        vantage: { pos: [-0.239991, -0.310101, -1.038131], lookAt: [-0.218688, -0.368747, -0.926346] },
      },
      source: {
        pos: [-0.263245, -0.378883, -0.898531],
        dir: [0.8628837214811875, 0.039252791732027524, -0.5038758791051805],
      },
      seeds: [
        {
          id: 'a',
          pos: [-0.215511, -0.352384, -0.931794],
          radius: 0.00482,
          kind: 'seed',
          goal: true,
        },
      ],
      masses: { light: 0.001285, medium: 0.002356, heavy: 0.003749 },
      budget: { medium: 1 },
      solution: [{ size: 'medium', pos: [-0.206526, -0.395616, -0.953132] }],
      hints: [
        'The bounce runs up the channel just past the seed. On a curved pearl, where the light strikes decides where it goes: which way should the incoming beam lean?',
        'Below the beam, on the side away from the seed, nearer the pearl than the star.',
        'A medium mass below the beam, two thirds of the way from the star to the pearl, tugs the light down so it strikes the pearl lower; the bounce swings right, up through the seed.',
      ],
      hintMass: 0,
      teach: 'Off a curved pearl, bending light away from a seed can swing its bounce toward it.',
      par: 1,
    },
    {
      id: 'reflect-3',
      chapter: 'reflect',
      index: 3,
      name: 'Hairpin',
      nebula: 'apollonian',
      clock: 0,
      arena: {
        centerLocal: [0.816435, -0.468285, -0.32053],
        radiusLocal: 0.0918,
        vantage: { pos: [0.909464, -0.500476, -0.369972], lookAt: [0.867872, -0.479514, -0.303375] },
      },
      source: {
        pos: [0.861369, -0.510064, -0.294838],
        dir: [-0.5783272163443071, 0.5963876406317764, -0.5566501710563898],
      },
      seeds: [
        {
          id: 'a',
          pos: [0.867962, -0.445947, -0.316041],
          radius: 0.005049,
          kind: 'seed',
          goal: true,
        },
      ],
      masses: { light: 0.001102, medium: 0.00202, heavy: 0.003213 },
      budget: { heavy: 1 },
      solution: [{ size: 'heavy', pos: [0.874285, -0.48253, -0.299247] }],
      hints: [
        'The great pearl already turns the light almost all the way back, just under the seed. What would make it come back a little higher?',
        'Above the star, to the left of the rising beam.',
        'A heavy mass above the star, left of the rising beam, leans the light so it meets the great pearl higher up; the pearl turns it back through about 120 degrees, through the seed.',
      ],
      hintMass: 0,
      teach: 'A small bend into a pearl makes a sharp corner: the mirror does the turning.',
      par: 1,
    },
    {
      id: 'reflect-4',
      chapter: 'reflect',
      index: 4,
      name: 'Two Mirrors',
      nebula: 'apollonian',
      clock: 0,
      arena: {
        centerLocal: [0.720035, 0.588939, -0.409091],
        radiusLocal: 0.1377,
        vantage: { pos: [0.816233, 0.73719, -0.502008], lookAt: [0.730493, 0.589992, -0.451182] },
      },
      source: {
        pos: [0.751585, 0.585553, -0.464602],
        dir: [-0.8800923780097828, 0.24152188477386421, -0.40878427727147937],
      },
      seeds: [
        {
          id: 'a',
          pos: [0.797463, 0.583817, -0.378093],
          radius: 0.008262,
          kind: 'seed',
          goal: true,
        },
      ],
      masses: { light: 0.001652, medium: 0.003029, heavy: 0.00482 },
      budget: { heavy: 1 },
      solution: [{ size: 'heavy', pos: [0.764925, 0.625254, -0.501149] }],
      hints: [
        'No single bounce reaches the seed. Look for two pearls that could hand the light from one to the other, toward it.',
        'Just below the beam, a little past the star.',
        'A heavy mass just below the beam, a little past the star, bends the light so the great pearl on the right throws it back to the round pearl above the star, which sends it through the seed with 0.7 × 0.7 = 0.49 of its strength.',
      ],
      hintMass: 0,
      teach: 'Light can bank off two pearls in turn; two bounces still keep 0.7 × 0.7 = 0.49.',
      par: 1,
    },
    {
      id: 'reflect-5',
      chapter: 'reflect',
      index: 5,
      name: 'Mirror and Lens',
      nebula: 'apollonian',
      clock: 0,
      arena: {
        centerLocal: [0.133634, 0.389316, 0.588551],
        radiusLocal: 0.11475,
        vantage: { pos: [-0.019793, 0.371964, 0.650549], lookAt: [0.105121, 0.388916, 0.625983] },
      },
      source: {
        pos: [0.156001, 0.375256, 0.679008],
        dir: [-0.025803842255975585, 0.5463426658730687, -0.8371641733683645],
      },
      seeds: [
        {
          id: 'a',
          pos: [0.109061, 0.396227, 0.603285],
          radius: 0.006311,
          kind: 'seed',
          goal: true,
        },
        {
          id: 'b',
          pos: [0.0503, 0.395264, 0.595655],
          radius: 0.006311,
          kind: 'seed',
          goal: true,
        },
      ],
      masses: { light: 0.001377, medium: 0.002525, heavy: 0.004016 },
      budget: { heavy: 2 },
      solution: [
        { size: 'heavy', pos: [0.150605, 0.354239, 0.639351] },
        { size: 'heavy', pos: [0.081564, 0.412484, 0.598952] },
      ],
      hints: [
        'One mass cannot light both seeds. The pearl can aim the light at one of them; what could steer it on to the other?',
        'Below the rising beam, a little past halfway to the pearl.',
        'A heavy mass below the rising beam lowers it, so it meets the pearl a little further along and the bounce runs through the first seed; a second heavy mass above the light, past that seed, pulls it back up into the second.',
      ],
      hintMass: 0,
      teach: 'Bounces and bends work in series: a pearl aims the light, then a mass steers it on.',
      par: 2,
    },
    {
      id: 'reflect-6',
      chapter: 'reflect',
      index: 6,
      name: 'The Long Way',
      nebula: 'apollonian',
      clock: 0,
      arena: {
        centerLocal: [-0.865493, -0.144954, -0.402498],
        radiusLocal: 0.1377,
        vantage: { pos: [-0.94576, -0.138146, -0.249079], lookAt: [-0.876008, -0.170608, -0.391524] },
      },
      source: {
        pos: [-0.925792, -0.228499, -0.416326],
        dir: [0.8507426356591815, 0.36907728086426755, 0.37419103225693107],
      },
      seeds: [
        {
          id: 'a',
          pos: [-0.861325, -0.145106, -0.345736],
          radius: 0.00661,
          kind: 'seed',
          goal: true,
        },
      ],
      masses: { light: 0.001652, medium: 0.003029, heavy: 0.00482 },
      budget: { medium: 1 },
      solution: [{ size: 'medium', pos: [-0.89753, -0.171266, -0.407147] }],
      hints: [
        'Count the bounces: the light gives out at the fourth pearl, short of the seed, because each bounce keeps only seven tenths. How could it arrive with fewer?',
        "Above the star's first leg, before it reaches the first pearl.",
        'A medium mass above the first leg lifts it clear of the first pearl onto the next, which throws it straight up through the seed: one bounce and 0.7 of the light, instead of four.',
      ],
      hintMass: 0,
      teach: 'Each bounce keeps 0.7: four leave 0.7⁴ ≈ 0.24, too dim for a seed. Go shorter.',
      par: 1,
    },
  ],
};
