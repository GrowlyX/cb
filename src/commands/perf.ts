import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Cdp } from '../cdp.ts';
import { evaluate, flag, note, num, str, untilStopped, withSession } from '../command.ts';
import { summarizeProfile } from '../cpu-profile.ts';
import { clock, fixedRow, mb, ms, orDash, pct, table, timestamp, truncate } from '../format.ts';
import { fpsProbe, fpsReport } from '../frames.ts';
import { summarizeTrace, traceEvents } from '../trace-summary.ts';
import type {
  Command,
  CpuProfile,
  FpsProbeResult,
  Metrics,
  ProfileSummary,
  TraceChunk,
  TraceSummary,
  Vitals,
} from '../types.ts';
import { vitalsProbe } from '../vitals.ts';

/** What the DevTools Performance panel records, plus GPU and compositor detail. */
export const TRACE_CATEGORIES = [
  'blink.console',
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'latencyInfo',
  'loading',
  'toplevel',
  'v8',
  'v8.execute',
  'gpu',
  'viz',
  'cc',
  '__metadata',
];

/** Column widths for the live `cb metrics` rows. */
const METRICS_WIDTHS = [10, 6, 7, 13, 8, 9];

export const fps: Command = {
  name: 'fps',
  summary: 'Measure frame rate and frame-time percentiles in a tab or iframe',
  usage: '[-t target] [-d seconds]',
  details: [
    'Times requestAnimationFrame in the target, so point -t at the frame that draws.',
    'Light enough to run while using the page, unlike `cb record`.',
  ],
  options: { duration: { type: 'string', short: 'd' } },

  async run(ctx, _args, values) {
    const seconds = num(values, 'duration', 10);

    await withSession(ctx, {}, async ({ target, cdp }) => {
      note(`measuring "${truncate(target.title || target.url, 60)}" for ${seconds}s`);

      const probe = fpsProbe(seconds * 1000);
      const { intervals, visibility } = await evaluate<FpsProbeResult>(cdp, probe, (seconds + 10) * 1000);

      if (intervals.length === 0) {
        throw new Error(`no animation frames ran (page is ${visibility}). Is the screen on and the tab in front?`);
      }

      const report = fpsReport(intervals);

      if (ctx.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(
        table([
          ['fps', report.fps.toFixed(1)],
          ['frame time', `p50 ${ms(report.p50)}  p95 ${ms(report.p95)}  p99 ${ms(report.p99)}  max ${ms(report.max)}`],
          ['slow frames', `${report.over33} over 33ms, ${report.over50} over 50ms (of ${report.frames})`],
        ]),
      );
    });
  },
};

export const metrics: Command = {
  name: 'metrics',
  summary: 'Live main-thread load and memory for a tab or iframe, once a second',
  usage: '[-t target] [-d seconds] [--once]',
  details: ['busy and script are the share of each second the main thread spent on tasks and on JS.'],
  options: { duration: { type: 'string', short: 'd' }, once: { type: 'boolean' } },

  async run(ctx, _args, values) {
    await withSession(ctx, {}, async ({ target, cdp }) => {
      await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });

      if (flag(values, 'once')) {
        printMetricsOnce(await readMetrics(cdp), ctx.json);
        return;
      }

      note(`watching "${truncate(target.title || target.url, 60)}", Ctrl+C to stop`);
      await watchMetrics(cdp, num(values, 'duration', 0), ctx.json);
    });
  },
};

/** `Performance.getMetrics` as a name to value map. */
export async function readMetrics(cdp: Cdp): Promise<Metrics> {
  const { metrics: list } = await cdp.send<{ metrics: Array<{ name: string; value: number }> }>(
    'Performance.getMetrics',
  );

  return Object.fromEntries(list.map((metric) => [metric.name, metric.value]));
}

/** Share of the time between two metric readings spent on a duration metric, 0-1. */
export function metricShare(previous: Metrics, current: Metrics, key: string): number {
  const wall = (current.Timestamp ?? 0) - (previous.Timestamp ?? 0);

  if (wall <= 0) {
    return 0;
  }

  return ((current[key] ?? 0) - (previous[key] ?? 0)) / wall;
}

/** Every metric Chrome reports, once. */
function printMetricsOnce(values: Metrics, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(values, null, 2));
    return;
  }

  const rows = Object.entries(values).map(([name, value]) => {
    return [name, Number.isInteger(value) ? String(value) : value.toFixed(3)];
  });

  console.log(table(rows));
}

/** Prints one row a second until the duration passes or Ctrl+C. */
async function watchMetrics(cdp: Cdp, seconds: number, json: boolean): Promise<void> {
  const stop = untilStopped(seconds);
  let stopped = false;

  void stop.then(() => {
    stopped = true;
  });

  if (!json) {
    console.log(fixedRow(['time', 'busy', 'script', 'layout+style', 'JS heap', 'DOM nodes'], METRICS_WIDTHS));
  }

  let previous = await readMetrics(cdp);

  while (!stopped) {
    await Promise.race([Bun.sleep(1000), stop]);

    if (stopped) {
      break;
    }

    const current = await readMetrics(cdp);

    if (json) {
      console.log(JSON.stringify(current));
    } else {
      const layout =
        metricShare(previous, current, 'LayoutDuration') + metricShare(previous, current, 'RecalcStyleDuration');

      const row = [
        clock(),
        pct(metricShare(previous, current, 'TaskDuration')),
        pct(metricShare(previous, current, 'ScriptDuration')),
        pct(layout),
        mb(current.JSHeapUsedSize ?? 0),
        String(current.Nodes ?? 0),
      ];

      console.log(fixedRow(row, METRICS_WIDTHS));
    }

    previous = current;
  }
}

export const trace: Command = {
  name: 'trace',
  summary: 'Record a performance trace (open it in DevTools or ui.perfetto.dev) and summarize it',
  usage: '[-d seconds] [-o file.json] [--screenshots] [--no-summary]',
  details: [
    'Records every process, so no -t is needed. -d 0 records until Ctrl+C.',
    'The file opens in the DevTools Performance panel (Load profile) or https://ui.perfetto.dev.',
  ],
  options: {
    duration: { type: 'string', short: 'd' },
    out: { type: 'string', short: 'o' },
    screenshots: { type: 'boolean' },
    'no-summary': { type: 'boolean' },
  },

  async run({ cb }, _args, values) {
    const seconds = num(values, 'duration', 10);
    const out = resolve(str(values, 'out') ?? `cb-${timestamp()}.trace.json`);
    const categories = [...TRACE_CATEGORIES];

    if (flag(values, 'screenshots')) {
      categories.push('disabled-by-default-devtools.screenshot');
    }

    const browser = await cb.browser();

    try {
      await recordTrace(browser, categories, seconds, out);
    } finally {
      browser.close();
    }

    console.log(out);

    if (!flag(values, 'no-summary')) {
      const events = traceEvents(JSON.parse(readFileSync(out, 'utf8')));

      console.log('');
      printTraceSummary(summarizeTrace(events));
    }
  },
};

/** Traces until the duration passes or Ctrl+C, then streams the trace to `out`. */
async function recordTrace(browser: Cdp, categories: string[], seconds: number, out: string): Promise<void> {
  await browser.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
    traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: categories },
  });

  note(`tracing${seconds > 0 ? ` for ${seconds}s` : ''}, Ctrl+C to stop`);
  await untilStopped(seconds);

  const complete = browser.once<{ stream: string }>('Tracing.tracingComplete', 120_000);
  await browser.send('Tracing.end');
  const { stream } = await complete;

  note('downloading trace…');
  writeFileSync(out, '');

  for (;;) {
    const chunk = await browser.send<TraceChunk>('IO.read', { handle: stream, size: 4 * 1024 * 1024 }, 60_000);

    appendFileSync(out, chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);

    if (chunk.eof) {
      break;
    }
  }

  await browser.send('IO.close', { handle: stream }).catch(() => {});
}

/** The trace summary as a table of the busiest processes. */
export function printTraceSummary(summary: TraceSummary, limit = 8): void {
  const heading = [`${(summary.durationMs / 1000).toFixed(1)}s recorded`];

  if (summary.displayFps !== undefined) {
    heading.push(`screen drew ${summary.displayFps.toFixed(1)} frames/s`);
  }

  console.log(heading.join(', '));

  const active = summary.processes.filter((process) => process.mainBusy > 0.005 || process.rafPerSecond > 0);
  const rows = active.slice(0, limit);

  if (rows.length === 0) {
    return;
  }

  const lines = rows.map((process) => [
    truncate(process.label, 48),
    pct(process.mainBusy),
    String(process.longTasks),
    ms(process.maxTaskMs),
    ms(process.gcMs),
    process.rafPerSecond > 0 ? process.rafPerSecond.toFixed(1) : '-',
    process.rafPerSecond > 0 ? ms(process.rafP95Ms) : '-',
    process.heapMb === undefined ? '-' : `${Math.round(process.heapMb)}MB`,
  ]);

  const header = ['process', 'main busy', 'long tasks', 'max task', 'GC', 'rAF/s', 'rAF p95', 'JS heap'];

  console.log('');
  console.log(table([header, ...lines]));
  console.log('');
  console.log('long task: over 50ms on the main thread. rAF p95: 95th percentile animation frame callback time.');
}

export const profile: Command = {
  name: 'profile',
  summary: 'Record a JavaScript CPU profile of a tab or iframe and list the slowest functions',
  usage: '[-t target] [-d seconds] [-o file.cpuprofile] [--interval us] [--top 15]',
  details: [
    'Samples the JS call stack in the target renderer. -d 0 records until Ctrl+C.',
    'The file opens in the DevTools Performance panel or https://www.speedscope.app.',
  ],
  options: {
    duration: { type: 'string', short: 'd' },
    out: { type: 'string', short: 'o' },
    interval: { type: 'string' },
    top: { type: 'string' },
  },

  async run(ctx, _args, values) {
    const seconds = num(values, 'duration', 10);
    const out = resolve(str(values, 'out') ?? `cb-${timestamp()}.cpuprofile`);

    const recorded = await withSession(ctx, {}, async ({ target, cdp }) => {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: num(values, 'interval', 500) });
      await cdp.send('Profiler.start');

      const forHowLong = seconds > 0 ? ` for ${seconds}s` : '';
      note(`profiling "${truncate(target.title || target.url, 60)}"${forHowLong}, Ctrl+C to stop`);
      await untilStopped(seconds);

      const result = await cdp.send<{ profile: CpuProfile }>('Profiler.stop', {}, 60_000);

      return result.profile;
    });

    writeFileSync(out, JSON.stringify(recorded));
    console.log(out);

    const summary = summarizeProfile(recorded, num(values, 'top', 15));

    if (ctx.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log('');
    printProfileSummary(summary);
  },
};

/** Where time went, then the functions with the most self time. */
export function printProfileSummary(summary: ProfileSummary): void {
  const activeMs = summary.durationMs - summary.idleMs;
  const seconds = (summary.durationMs / 1000).toFixed(1);

  console.log(
    `${seconds}s profiled: ${ms(activeMs)} active, ${ms(summary.idleMs)} idle, ` +
      `${ms(summary.gcMs)} GC, ${ms(summary.programMs)} unattributed native`,
  );

  if (summary.functions.length === 0) {
    console.log('no JavaScript ran');
    return;
  }

  const rows = summary.functions.map((fn) => [ms(fn.selfMs), pct(fn.share), truncate(fn.name, 40), fn.location]);

  console.log('');
  console.log(table([['self', 'share', 'function', 'location'], ...rows]));
}

export const vitals: Command = {
  name: 'vitals',
  summary: 'Page load timing, Largest Contentful Paint, layout shift and resource totals for a tab',
  usage: '[-t target]',
  details: ['Times are milliseconds from navigation start, from the Performance API in the page.'],

  async run(ctx) {
    await withSession(ctx, {}, async ({ cdp }) => {
      const result = await evaluate<Vitals>(cdp, vitalsProbe());

      if (ctx.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printVitals(result);
    });
  },
};

/** Vitals as a two-column table; missing values print as `-`. */
function printVitals(result: Vitals): void {
  const time = (value?: number) => orDash(value, ms);
  const heap = result.jsHeapMb === undefined ? '-' : `${Math.round(result.jsHeapMb)}MB`;

  console.log(
    table([
      ['url', truncate(result.url, 80)],
      ['ttfb', time(result.ttfbMs)],
      ['fcp', time(result.fcpMs)],
      ['lcp', time(result.lcpMs)],
      ['dom ready', time(result.domContentLoadedMs)],
      ['load', time(result.loadMs)],
      ['cls', result.cls.toFixed(3)],
      ['resources', `${result.resources} (${result.transferKb} KB measurable transfer)`],
      ['JS heap', heap],
    ]),
  );
}
