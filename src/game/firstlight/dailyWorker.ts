/**
 * First Light — module worker for the daily's runtime generation (dailyClient.ts starts it; nothing
 * imports this file). It runs DailyGen.generateDaily unchanged, so the level is the one the bundles hold.
 * The generation graph (DailyGen → Generator → Reach → … → three.js maths) touches no DOM.
 *
 * Message in: { dateId }. Message out: { dateId, level, error } (level null for an invalid date).
 */
import { generateDaily } from './DailyGen';
import type { DailyReply, DailyRequest } from './dailyClient';
import type { LevelDef } from './types';

/** The parts of the dedicated worker scope used here (the project compiles against the DOM lib). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<DailyRequest>) => void) | null;
  postMessage(reply: DailyReply): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const dateId = e.data && typeof e.data.dateId === 'string' ? e.data.dateId : '';
  let level: LevelDef | null = null;
  let error: string | null = null;
  try {
    level = generateDaily(dateId);
  } catch (err) {
    error = String(err);
  }
  scope.postMessage({ dateId, level, error });
};
