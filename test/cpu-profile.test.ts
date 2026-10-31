import { describe, expect, test } from 'bun:test';
import { summarizeProfile } from '../src/cpu-profile.ts';
import type { CpuProfile, ProfileNode } from '../src/types.ts';

/** A profile node for a function in `url` at `line` (zero-based, as V8 reports it). */
function node(id: number, functionName: string, url = '', line = 0, hitCount = 0): ProfileNode {
  return { id, callFrame: { functionName, url, lineNumber: line, columnNumber: 0 }, hitCount };
}

describe('summarizeProfile', () => {
  const profile: CpuProfile = {
    nodes: [
      node(1, '(root)'),
      node(2, '(idle)'),
      node(3, 'render', 'https://app.example/js/app.js?v=3', 9),
      node(4, 'update', 'https://app.example/js/app.js', 41),
      node(5, '(garbage collector)'),
      node(6, '(program)'),
    ],
    startTime: 0,
    endTime: 10_000,
    samples: [3, 3, 4, 2, 5, 6, 3],
    timeDeltas: [0, 1000, 1000, 1000, 2000, 1000, 1000],
  };

  const summary = summarizeProfile(profile);

  test('charges each sample the time until the next', () => {
    expect(summary.durationMs).toBe(10);
    expect(summary.idleMs).toBe(2);
    expect(summary.gcMs).toBe(1);
    expect(summary.programMs).toBe(1);
  });

  test('ranks functions by self time with a short location', () => {
    expect(summary.functions.map((fn) => [fn.name, fn.location, fn.selfMs])).toEqual([
      ['render', 'app.js:10', 5],
      ['update', 'app.js:42', 1],
    ]);
  });

  test('shares are of active time', () => {
    expect(summary.functions[0]!.share).toBeCloseTo(5 / 8, 5);
  });

  test('falls back to hit counts without samples', () => {
    const counted = summarizeProfile({
      nodes: [node(1, 'a', 'x.js', 0, 3), node(2, '(idle)', '', 0, 1)],
      startTime: 0,
      endTime: 4_000,
    });

    expect(counted.functions[0]!.selfMs).toBe(3);
    expect(counted.idleMs).toBe(1);
  });
});
