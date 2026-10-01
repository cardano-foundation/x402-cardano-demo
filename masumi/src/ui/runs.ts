/**
 * One purchase at a time. Each run (real or replayed example) gets a token;
 * starting a new run aborts the previous one, and a stale run's state writes
 * are dropped, so a replay can never touch a real payment's UI.
 */
export type RunKind = "real" | "example";
export interface RunToken {
  kind: RunKind;
  signal: AbortSignal;
  /** Runs `write` only if this run is still the current one. */
  guard(write: () => void): void;
}

export function createRuns() {
  let current: (RunToken & { controller: AbortController }) | undefined;
  return {
    start(kind: RunKind): RunToken {
      current?.controller.abort();
      const controller = new AbortController();
      const token = {
        kind, controller, signal: controller.signal,
        guard: (write: () => void) => { if (current === token) write(); },
      };
      current = token;
      return token;
    },
    current: () => current,
    /** Retires the current run: its pending work aborts and its late writes are dropped. */
    stop() { current?.controller.abort(); current = undefined; },
  };
}
