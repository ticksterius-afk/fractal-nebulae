/**
 * First Light — the authored chapters in play order (design/20-first-light.md §3.1). Chapters 1–3
 * open at once; each later chapter opens when 4 of 6 puzzles are solved in any two earlier chapters
 * (parallel lines, never a hard block — design §3.1 "Progression").
 */
import type { ChapterDef, LevelDef } from './types';
import { BEND } from './levels/bend';
import { THREAD } from './levels/thread';
import { REFLECT } from './levels/reflect';

export const CHAPTERS: readonly ChapterDef[] = [BEND, THREAD, REFLECT];

/** Every authored level in play order. */
export const ALL_LEVELS: readonly LevelDef[] = CHAPTERS.flatMap((c) => c.levels);

export function findLevel(id: string): { chapter: ChapterDef; level: LevelDef; index: number } | null {
  for (const chapter of CHAPTERS) {
    const index = chapter.levels.findIndex((l) => l.id === id);
    if (index >= 0) return { chapter, level: chapter.levels[index], index };
  }
  return null;
}

/** Unlock rule: the first OPEN_CHAPTERS are open; later ones need SOLVED_PER_CHAPTER in CHAPTERS_NEEDED earlier chapters. */
export const UNLOCK = { openChapters: 3, solvedPerChapter: 4, chaptersNeeded: 2 } as const;
export const UNLOCK_TEXT = 'Solve 4 puzzles in two chapters';

/** Whether chapter `index` of `chapters` is open, given which level ids are solved. */
export function chapterUnlocked(chapters: readonly ChapterDef[], index: number, solved: (id: string) => boolean): boolean {
  if (index < UNLOCK.openChapters) return true;
  let ready = 0;
  for (let i = 0; i < index && i < chapters.length; i++) {
    let n = 0;
    for (const l of chapters[i].levels) if (solved(l.id)) n++;
    if (n >= Math.min(UNLOCK.solvedPerChapter, chapters[i].levels.length)) ready++;
  }
  return ready >= UNLOCK.chaptersNeeded;
}

/** The level after `id` in its chapter, or null at the chapter's end (or for unknown ids). */
export function nextLevelAfter(id: string): LevelDef | null {
  const f = findLevel(id);
  if (!f) return null;
  return f.chapter.levels[f.index + 1] ?? null;
}

/**
 * Goal seeds in the levels BEFORE `id` in its chapter: GameAudio.seedLit(base + order) then climbs
 * the nebula's scale across the whole chapter, so a chapter plays as one melody.
 */
export function chapterSeedBase(id: string): number {
  const f = findLevel(id);
  if (!f) return 0;
  let n = 0;
  for (let i = 0; i < f.index; i++) for (const s of f.chapter.levels[i].seeds) if (s.goal) n++;
  return n;
}
