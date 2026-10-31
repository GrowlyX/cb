import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Cdp } from '../cdp.ts';
import { evaluate, note, num, str, untilStopped, withSession } from '../command.ts';
import { clock, fixedRow, ms, orDash, pct, table, truncate } from '../format.ts';
import { drainRecorder, fpsReport, installRecorder, removeRecorder } from '../frames.ts';
import { summarizeMonitor } from '../monitor-summary.ts';
import { parseSample, samplerScript, systemCpu } from '../system.ts';
import type {
  Command,
  Metrics,
  MonitorCapture,
  MonitorOptions,
  MonitorRow,
  MonitorSummary,
  SystemState,
} from '../types.ts';
import { metricShare, readMetrics } from './perf.ts';

/** Column headers and widths for the live table. */
const HEADER = ['time', 'fps', 'p95', 'slow', 'main', 'heap', 'cpu', 'free', 'MHz', 'temp'];
const WIDTHS = [8, 5, 7, 4, 5, 6, 5, 7, 5, 5];

/** CSV columns, in MonitorRow field order. */
const CSV_FIELDS: Array<keyof MonitorRow> = [
  'time',
  'frames',
  'fps',
  'frameP95Ms',
  'slowFrames',
  'mainBusy',
  'heapMb',
  'systemCpu',
  'memAvailableMb',
  'cpuMHz',
  'maxTempC',
];

export const monitor: Command = {
  name: 'monitor',
  summary: 'Live dashboard of page frame rate and main thread with Chromebook CPU, memory, clock and heat',
  usage: '[-t target] [-d seconds] [-i seconds] [--csv file]',
  details: [
    'One row per interval: fps and p95 frame time in the target, frames over 33ms, main thread busy,',
    'JS heap, whole-system CPU, available memory, CPU clock and the hottest thermal zone.',
    'Ends with a summary and warnings (heap growth, saturation, low memory, throttling).',
    'Point -t at the frame that draws. --json prints one JSON object per row, then the summary.',
    'While running it keeps a requestAnimationFrame loop in the page; it is removed on exit.',
  ],
  options: {
    duration: { type: 'string', short: 'd' },
    interval: { type: 'string', short: 'i' },
    csv: { type: 'string' },
  },

  async run(ctx, _args, values) {
    const seconds = num(values, 'duration', 0);
    const interval = Math.max(0.5, num(values, 'interval', 1));
    const csvPath = str(values, 'csv');
    const csv = csvPath ? resolve(csvPath) : undefined;
    const system: SystemState = {};

    const stopSampler = await ctx.cb.remote.stream(samplerScript(interval), (line) => {
      const sample = parseSample(line);

      if (!sample) {
        return;
      }

      if (system.latest) {
        system.cpu = systemCpu(system.latest, sample);
      }

      system.latest = sample;
    });

    if (csv) {
      writeFileSync(csv, `${CSV_FIELDS.join(',')}\n`);
    }

    try {
      const { rows, intervals, elapsed } = await withSession(ctx, {}, async ({ target, cdp }) => {
        note(`monitoring "${truncate(target.title || target.url, 60)}" every ${interval}s, Ctrl+C to stop`);

        return watch(cdp, { seconds, interval, json: ctx.json, csv, system });
      });

      const summary = summarizeMonitor(rows, intervals, elapsed);

      if (ctx.json) {
        console.log(JSON.stringify({ summary }));
      } else {
        printMonitorSummary(summary);
      }

      if (csv) {
        note(`rows written to ${csv}`);
      }
    } finally {
      stopSampler();
    }
  },
};

/** Collects one row per interval until the duration passes or Ctrl+C, then cleans up the page. */
async function watch(cdp: Cdp, options: MonitorOptions): Promise<MonitorCapture> {
  const rows: MonitorRow[] = [];
  const intervals: number[] = [];
  const started = performance.now();
  const stop = untilStopped(options.seconds);
  let stopped = false;

  void stop.then(() => {
    stopped = true;
  });

  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
  await evaluate(cdp, installRecorder());

  if (!options.json) {
    console.log(fixedRow(HEADER, WIDTHS));
  }

  try {
    let previous = await readMetrics(cdp);

    while (!stopped) {
      await Promise.race([Bun.sleep(options.interval * 1000), stop]);

      if (stopped) {
        break;
      }

      const [drained, current] = await Promise.all([evaluate<number[]>(cdp, drainRecorder()), readMetrics(cdp)]);
      const row = buildRow(drained, previous, current, options.system);

      intervals.push(...drained);
      rows.push(row);
      emitRow(row, options.json, options.csv);
      previous = current;
    }
  } finally {
    await evaluate(cdp, removeRecorder()).catch(() => undefined);
  }

  return { rows, intervals, elapsed: (performance.now() - started) / 1000 };
}

/** One interval's frame stats, main-thread load and heap, with the latest system reading. */
function buildRow(intervals: number[], previous: Metrics, current: Metrics, system: SystemState): MonitorRow {
  const frames = fpsReport(intervals);

  return {
    time: clock(),
    frames: frames.frames,
    fps: frames.fps,
    frameP95Ms: frames.p95,
    slowFrames: frames.over33,
    mainBusy: metricShare(previous, current, 'TaskDuration'),
    heapMb: (current.JSHeapUsedSize ?? 0) / 1024 / 1024,
    systemCpu: system.cpu,
    memAvailableMb: system.latest?.memAvailableMb,
    cpuMHz: system.latest?.cpuMHz,
    maxTempC: system.latest?.maxTempC,
  };
}

/** Prints a row to the terminal (or as JSON) and appends it to the CSV file. */
function emitRow(row: MonitorRow, json: boolean, csv?: string): void {
  if (json) {
    console.log(JSON.stringify(row));
  } else {
    console.log(fixedRow(formatRow(row), WIDTHS));
  }

  if (csv) {
    const cells = CSV_FIELDS.map((field) => {
      const value = row[field];

      if (value === undefined) {
        return '';
      }

      return typeof value === 'number' ? String(Number(value.toFixed(3))) : value;
    });

    appendFileSync(csv, `${cells.join(',')}\n`);
  }
}

/** A row's cells for the live table; system values print `-` until the sampler reports. */
function formatRow(row: MonitorRow): string[] {
  return [
    row.time,
    row.frames > 0 ? row.fps.toFixed(1) : '-',
    row.frames > 0 ? ms(row.frameP95Ms) : '-',
    String(row.slowFrames),
    pct(row.mainBusy),
    `${Math.round(row.heapMb)}MB`,
    orDash(row.systemCpu, (v) => `${Math.round(v)}%`),
    orDash(row.memAvailableMb, (v) => `${v}MB`),
    orDash(row.cpuMHz, (v) => String(v)),
    orDash(row.maxTempC, (v) => `${Math.round(v)}°C`),
  ];
}

/** The session totals, then any warnings. */
export function printMonitorSummary(summary: MonitorSummary): void {
  let fpsLine = 'no frames drawn';

  if (summary.frames > 0) {
    const low = summary.lowFps.toFixed(1);
    const worst = summary.worstIntervalFps.toFixed(1);
    fpsLine = `${summary.fps.toFixed(1)} avg, ${low} 1% low, ${worst} worst interval`;
  }

  const percent = (value: number) => `${Math.round(value)}%`;
  const heap = `${Math.round(summary.heapStartMb)}MB → ${Math.round(summary.heapEndMb)}MB, ${Math.round(summary.heapMaxMb)}MB max`;

  console.log('');
  console.log(`summary over ${summary.seconds.toFixed(0)}s`);
  console.log(
    table([
      ['fps', fpsLine],
      ['frame time', `p95 ${ms(summary.frameP95Ms)}  p99 ${ms(summary.frameP99Ms)}`],
      ['slow frames', `${summary.over33} over 33ms, ${summary.over50} over 50ms (of ${summary.frames})`],
      ['main thread', `${pct(summary.mainBusyAvg)} avg, ${pct(summary.mainBusyMax)} max`],
      ['JS heap', heap],
      ['system cpu', `${orDash(summary.systemCpuAvg, percent)} avg, ${orDash(summary.systemCpuMax, percent)} max`],
      ['memory', `${orDash(summary.memAvailableMinMb, (v) => `${v}MB`)} available at worst`],
      ['cpu clock', `${orDash(summary.cpuMHzMin, String)}-${orDash(summary.cpuMHzMax, String)} MHz`],
      ['hottest', orDash(summary.maxTempC, (v) => `${Math.round(v)}°C`)],
    ]),
  );

  if (summary.warnings.length > 0) {
    console.log('');

    for (const warning of summary.warnings) {
      console.log(`! ${warning}`);
    }
  }
}
