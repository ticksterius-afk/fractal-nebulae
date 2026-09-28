import type { AppEvents } from './types';

type Handler<T> = (payload: T) => void;

/** Tiny typed event bus shared by simulation, HUD, audio and renderer. */
export class EventBus {
  private handlers = new Map<keyof AppEvents, Set<Handler<any>>>();

  on<K extends keyof AppEvents>(type: K, fn: Handler<AppEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof AppEvents>(type: K, payload: AppEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${String(type)}" failed`, err);
      }
    }
  }
}

/** The single app-wide bus. */
export const bus = new EventBus();
