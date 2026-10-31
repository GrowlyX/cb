import { mean, percentile } from './format.ts';
import { fpsReport } from './frames.ts';
import type { MonitorRow, MonitorSummary } from './types.ts';

/** Thresholds behind the plain-language warnings. */
const HEAP_GROWTH_MB = 20;
const HEAP_GROWTH_SHARE = 0.2;
const MAIN_THREAD_SATURATED = 0.8;
const SYSTEM_CPU_SATURATED = 90;
const LOW_MEMORY_MB = 300;
const CLOCK_DROP_SHARE = 0.7;
const BUSY_CPU = 60;
const HOT_C = 85;
const SMOOTH_FPS = 50;
const IDLE_MAIN_THREAD = 0.5;

/** Totals for a monitor session, from its rows and every frame interval it saw. */
export function summarizeMonitor(rows: MonitorRow[], intervals: number[], seconds: number): MonitorSummary {
  const frames = fpsReport(intervals);
  const drawing = rows.filter((row) => row.frames > 0);
  const cpu = defined(rows.map((row) => row.systemCpu));
  const memory = defined(rows.map((row) => row.memAvailableMb));
  const clocks = defined(rows.map((row) => row.cpuMHz));
  const temps = defined(rows.map((row) => row.maxTempC));
  const busy = rows.map((row) => row.mainBusy);
  const heap = rows.map((row) => row.heapMb);
  const p99 = percentile(intervals, 99);

  const summary: MonitorSummary = {
    seconds,
    frames: frames.frames,
    fps: frames.fps,
    lowFps: p99 > 0 ? 1000 / p99 : 0,
    worstIntervalFps: drawing.length > 0 ? Math.min(...drawing.map((row) => row.fps)) : 0,
    frameP95Ms: frames.p95,
    frameP99Ms: p99,
    over33: frames.over33,
    over50: frames.over50,
    mainBusyAvg: mean(busy),
    mainBusyMax: busy.length > 0 ? Math.max(...busy) : 0,
    heapStartMb: heap[0] ?? 0,
    heapEndMb: heap.at(-1) ?? 0,
    heapMaxMb: heap.length > 0 ? Math.max(...heap) : 0,
    systemCpuAvg: cpu.length > 0 ? mean(cpu) : undefined,
    systemCpuMax: cpu.length > 0 ? Math.max(...cpu) : undefined,
    memAvailableMinMb: memory.length > 0 ? Math.min(...memory) : undefined,
    cpuMHzMin: clocks.length > 0 ? Math.min(...clocks) : undefined,
    cpuMHzMax: clocks.length > 0 ? Math.max(...clocks) : undefined,
    maxTempC: temps.length > 0 ? Math.max(...temps) : undefined,
    warnings: [],
  };

  summary.warnings = warningsFor(summary, rows);

  return summary;
}

/** Observations worth acting on, most specific first. */
export function warningsFor(summary: MonitorSummary, rows: MonitorRow[]): string[] {
  const warnings: string[] = [];
  const heapGrowth = summary.heapEndMb - summary.heapStartMb;

  if (heapGrowth > HEAP_GROWTH_MB && heapGrowth > summary.heapStartMb * HEAP_GROWTH_SHARE) {
    warnings.push(
      `JS heap grew from ${Math.round(summary.heapStartMb)}MB to ${Math.round(summary.heapEndMb)}MB: ` +
        'possible leak, or caches still filling',
    );
  }

  if (summary.mainBusyAvg > MAIN_THREAD_SATURATED) {
    warnings.push('main thread busy most of the time: the page is CPU bound on JS or layout (try `cb profile`)');
  }

  if (summary.systemCpuAvg !== undefined && summary.systemCpuAvg > SYSTEM_CPU_SATURATED) {
    warnings.push('Chromebook CPU saturated: every core is busy (see `cb top`)');
  }

  if (summary.memAvailableMinMb !== undefined && summary.memAvailableMinMb < LOW_MEMORY_MB) {
    warnings.push(
      `only ${summary.memAvailableMinMb}MB memory available at worst: ChromeOS may compress memory or discard tabs`,
    );
  }

  const throttled = throttledClock(rows, summary.cpuMHzMax);

  if (throttled !== undefined) {
    const hot =
      summary.maxTempC !== undefined && summary.maxTempC >= HOT_C ? ` at ${Math.round(summary.maxTempC)}°C` : '';
    warnings.push(
      `CPU clock fell to ${throttled} MHz (peak ${summary.cpuMHzMax}) while the CPU was busy${hot}: thermal or power throttling`,
    );
  }

  const otherLoad = summary.systemCpuAvg !== undefined && summary.systemCpuAvg > SYSTEM_CPU_SATURATED * 0.8;

  if (summary.frames > 0 && summary.fps < SMOOTH_FPS && summary.mainBusyAvg < IDLE_MAIN_THREAD && otherLoad) {
    warnings.push('low frame rate while the page main thread is mostly idle: GPU or other processes may be the limit');
  }

  return warnings;
}

/**
 * The lowest clock seen while the CPU was busy, when it is well under the peak. An idle CPU
 * running slow is normal power saving, so only busy intervals count.
 */
function throttledClock(rows: MonitorRow[], peakMHz?: number): number | undefined {
  if (peakMHz === undefined) {
    return undefined;
  }

  const busyClocks = rows
    .filter((row) => row.systemCpu !== undefined && row.systemCpu >= BUSY_CPU)
    .map((row) => row.cpuMHz)
    .filter((mhz): mhz is number => mhz !== undefined);

  if (busyClocks.length === 0) {
    return undefined;
  }

  const lowest = Math.min(...busyClocks);

  return lowest < peakMHz * CLOCK_DROP_SHARE ? lowest : undefined;
}

/** The values that are set. */
function defined(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => value !== undefined);
}
