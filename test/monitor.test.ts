import { describe, expect, test } from 'bun:test';
import { summarizeMonitor } from '../src/monitor-summary.ts';
import type { MonitorRow } from '../src/types.ts';

/** A monitor row with healthy defaults, overridden per test. */
function row(overrides: Partial<MonitorRow>): MonitorRow {
  return {
    time: '00:00:00',
    frames: 60,
    fps: 60,
    frameP95Ms: 16.7,
    slowFrames: 0,
    mainBusy: 0.3,
    heapMb: 100,
    systemCpu: 40,
    memAvailableMb: 1000,
    cpuMHz: 2800,
    maxTempC: 50,
    ...overrides,
  };
}

describe('summarizeMonitor', () => {
  test('totals frames and ranges across rows', () => {
    const intervals = [...Array(99).fill(16.7), 100];
    const summary = summarizeMonitor([row({ fps: 58 }), row({ fps: 41, heapMb: 110 })], intervals, 2);

    expect(summary.frames).toBe(100);
    expect(summary.worstIntervalFps).toBe(41);
    expect(summary.lowFps).toBeCloseTo(1000 / 16.7, 5);
    expect(summary.over50).toBe(1);
    expect(summary.heapStartMb).toBe(100);
    expect(summary.heapEndMb).toBe(110);
    expect(summary.warnings).toEqual([]);
  });

  test('missing system readings stay undefined', () => {
    const summary = summarizeMonitor([row({ systemCpu: undefined, cpuMHz: undefined })], [16.7], 1);

    expect(summary.systemCpuAvg).toBeUndefined();
    expect(summary.cpuMHzMin).toBeUndefined();
  });

  test('warns about heap growth, saturation, low memory and throttling', () => {
    const rows = [
      row({ heapMb: 100, mainBusy: 0.9, systemCpu: 95, cpuMHz: 2800 }),
      row({ heapMb: 180, mainBusy: 0.95, systemCpu: 97, cpuMHz: 1100, memAvailableMb: 200, maxTempC: 90 }),
    ];

    const warnings = summarizeMonitor(rows, [16.7], 2).warnings.join('\n');

    expect(warnings).toContain('JS heap grew from 100MB to 180MB');
    expect(warnings).toContain('main thread busy');
    expect(warnings).toContain('CPU saturated');
    expect(warnings).toContain('only 200MB memory available');
    expect(warnings).toContain('CPU clock fell to 1100 MHz (peak 2800) while the CPU was busy at 90°C');
  });

  test('a slow clock while idle is power saving, not throttling', () => {
    const rows = [row({ systemCpu: 15, cpuMHz: 800 }), row({ systemCpu: 70, cpuMHz: 2800 })];

    expect(summarizeMonitor(rows, [16.7], 2).warnings).toEqual([]);
  });
});
