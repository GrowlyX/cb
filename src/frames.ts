import { percentile } from './format.ts';
import type { FpsReport } from './types.ts';

/** Global the continuous recorder keeps its state on, inside the measured page. */
const RECORDER = '__cbFrameRecorder';

/** Frame times above these are counted as slow (below 30 and 20 fps). */
const SLOW_MS = 33.4;
const VERY_SLOW_MS = 50;

/**
 * An expression that collects requestAnimationFrame intervals for `durationMs`, then
 * resolves with them. A fallback timer resolves anyway if the page stops painting.
 */
export function fpsProbe(durationMs: number): string {
  return `new Promise((resolve) => {
    const intervals = [];
    const end = performance.now() + ${durationMs};
    let last;

    const finish = () => resolve({ intervals, visibility: document.visibilityState });

    const tick = (now) => {
      if (last !== undefined) {
        intervals.push(now - last);
      }

      last = now;

      if (now < end) {
        requestAnimationFrame(tick);
      } else {
        finish();
      }
    };

    requestAnimationFrame(tick);
    setTimeout(finish, ${durationMs + 2000});
  })`;
}

/**
 * An expression that starts a requestAnimationFrame loop recording frame intervals into a
 * page global, for `cb monitor` to drain each second. Running it again resets the buffer.
 */
export function installRecorder(): string {
  return `(() => {
    const existing = window.${RECORDER};

    if (existing) {
      existing.intervals = [];
      existing.stopped = false;
      return true;
    }

    const state = { intervals: [], last: undefined, stopped: false };
    window.${RECORDER} = state;

    const tick = (now) => {
      if (state.stopped) {
        return;
      }

      if (state.last !== undefined) {
        state.intervals.push(now - state.last);
      }

      state.last = now;
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
    return true;
  })()`;
}

/** An expression that returns and clears the intervals recorded since the last drain. */
export function drainRecorder(): string {
  return `(() => {
    const state = window.${RECORDER};

    if (!state) {
      return [];
    }

    const intervals = state.intervals;
    state.intervals = [];
    return intervals;
  })()`;
}

/** An expression that stops the recorder's loop and removes it from the page. */
export function removeRecorder(): string {
  return `(() => {
    const state = window.${RECORDER};

    if (state) {
      state.stopped = true;
      delete window.${RECORDER};
    }

    return true;
  })()`;
}

/** Frame rate and frame-time statistics from requestAnimationFrame intervals in ms. */
export function fpsReport(intervals: number[]): FpsReport {
  const total = intervals.reduce((sum, value) => sum + value, 0);

  return {
    frames: intervals.length,
    fps: total > 0 ? (intervals.length / total) * 1000 : 0,
    p50: percentile(intervals, 50),
    p95: percentile(intervals, 95),
    p99: percentile(intervals, 99),
    max: intervals.length > 0 ? Math.max(...intervals) : 0,
    over33: intervals.filter((value) => value > SLOW_MS).length,
    over50: intervals.filter((value) => value > VERY_SLOW_MS).length,
  };
}
