import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Command, connect, flag, num, str, untilStopped } from '../command.ts';
import { mb, ms, percentile, table, timestamp, truncate } from '../format.ts';
import { summarizeTrace, type TraceSummary, traceEvents } from '../trace-summary.ts';

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

export function printTraceSummary(summary: TraceSummary, limit = 8): void {
  const head = [`${(summary.durationMs / 1000).toFixed(1)}s recorded`];
  if (summary.displayFps !== undefined) head.push(`screen drew ${summary.displayFps.toFixed(1)} frames/s`);
  console.log(head.join(', '));
  const rows = summary.processes.filter((p) => p.mainBusy > 0.005 || p.rafPerSecond > 0).slice(0, limit);
  if (rows.length === 0) return;
  console.log(
    `\n${table([
      ['process', 'main busy', 'long tasks', 'max task', 'GC', 'rAF/s', 'rAF p95', 'JS heap'],
      ...rows.map((p) => [
        truncate(p.label, 48),
        `${Math.round(p.mainBusy * 100)}%`,
        String(p.longTasks),
        ms(p.maxTaskMs),
        ms(p.gcMs),
        p.rafPerSecond ? p.rafPerSecond.toFixed(1) : '-',
        p.rafPerSecond ? ms(p.rafP95Ms) : '-',
        p.heapMb === undefined ? '-' : `${Math.round(p.heapMb)}MB`,
      ]),
    ])}`,
  );
  console.log('\nlong task: over 50ms on the main thread. rAF p95: 95th percentile animation frame callback time.');
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
    if (flag(values, 'screenshots')) categories.push('disabled-by-default-devtools.screenshot');

    const browser = await cb.browser();
    try {
      await browser.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: categories },
      });
      process.stderr.write(`tracing${seconds > 0 ? ` for ${seconds}s` : ''}, Ctrl+C to stop\n`);
      await untilStopped(seconds);
      const complete = browser.once<{ stream: string }>('Tracing.tracingComplete', 120_000);
      await browser.send('Tracing.end');
      const { stream } = await complete;
      process.stderr.write('downloading trace…\n');
      writeFileSync(out, '');
      for (;;) {
        const chunk = await browser.send<{ data: string; eof: boolean; base64Encoded?: boolean }>(
          'IO.read',
          { handle: stream, size: 4 * 1024 * 1024 },
          60_000,
        );
        appendFileSync(out, chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
        if (chunk.eof) break;
      }
      await browser.send('IO.close', { handle: stream }).catch(() => {});
    } finally {
      browser.close();
    }
    console.log(out);
    if (!flag(values, 'no-summary')) {
      console.log('');
      printTraceSummary(summarizeTrace(traceEvents(JSON.parse(readFileSync(out, 'utf8')))));
    }
  },
};

/** Collects requestAnimationFrame intervals in the page for `ms` milliseconds. */
export function fpsProbe(durationMs: number): string {
  return `new Promise((resolve) => {
    const intervals = [];
    const end = performance.now() + ${durationMs};
    let last;
    const tick = (t) => {
      if (last !== undefined) intervals.push(t - last);
      last = t;
      if (t < end) requestAnimationFrame(tick);
      else resolve({ intervals, visibility: document.visibilityState });
    };
    requestAnimationFrame(tick);
    setTimeout(() => resolve({ intervals, visibility: document.visibilityState }), ${durationMs + 2000});
  })`;
}

export interface FpsReport {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Frames that took over 33ms (below 30fps) and over 50ms. */
  over33: number;
  over50: number;
}

export function fpsReport(intervals: number[]): FpsReport {
  const total = intervals.reduce((s, v) => s + v, 0);
  return {
    frames: intervals.length,
    fps: total > 0 ? (intervals.length / total) * 1000 : 0,
    p50: percentile(intervals, 50),
    p95: percentile(intervals, 95),
    p99: percentile(intervals, 99),
    max: intervals.length ? Math.max(...intervals) : 0,
    over33: intervals.filter((v) => v > 33.4).length,
    over50: intervals.filter((v) => v > 50).length,
  };
}

export const fps: Command = {
  name: 'fps',
  summary: 'Measure frame rate and frame-time percentiles in a tab or iframe',
  usage: '[-t target] [-d seconds]',
  details: [
    'Times requestAnimationFrame in the target, so point -t at the frame the game draws in.',
    'Light enough to run while playing, unlike `cb record`.',
  ],
  options: { duration: { type: 'string', short: 'd' } },
  async run(ctx, _args, values) {
    const seconds = num(values, 'duration', 10);
    const { target, cdp } = await connect(ctx);
    try {
      process.stderr.write(`measuring "${truncate(target.title || target.url, 60)}" for ${seconds}s\n`);
      const { result, exceptionDetails } = await cdp.send<{
        result: { value: { intervals: number[]; visibility: string } };
        exceptionDetails?: { text: string };
      }>(
        'Runtime.evaluate',
        { expression: fpsProbe(seconds * 1000), awaitPromise: true, returnByValue: true },
        (seconds + 10) * 1000,
      );
      if (exceptionDetails) throw new Error(exceptionDetails.text);
      const { intervals, visibility } = result.value;
      if (intervals.length === 0) {
        throw new Error(`no animation frames ran (page is ${visibility}). Is the screen on and the tab in front?`);
      }
      const r = fpsReport(intervals);
      if (ctx.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(
        table([
          ['fps', r.fps.toFixed(1)],
          ['frame time', `p50 ${ms(r.p50)}  p95 ${ms(r.p95)}  p99 ${ms(r.p99)}  max ${ms(r.max)}`],
          ['slow frames', `${r.over33} over 33ms, ${r.over50} over 50ms (of ${r.frames})`],
        ]),
      );
    } finally {
      cdp.close();
    }
  },
};

const METRIC_KEYS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'] as const;

export const metrics: Command = {
  name: 'metrics',
  summary: 'Live main-thread load and memory for a tab or iframe, once a second',
  usage: '[-t target] [-d seconds] [--once]',
  details: ['busy and script are the share of each second the target main thread spent on tasks and JS.'],
  options: { duration: { type: 'string', short: 'd' }, once: { type: 'boolean' } },
  async run(ctx, _args, values) {
    const { target, cdp } = await connect(ctx);
    const read = async () => {
      const { metrics: list } = await cdp.send<{ metrics: Array<{ name: string; value: number }> }>(
        'Performance.getMetrics',
      );
      return Object.fromEntries(list.map((m) => [m.name, m.value])) as Record<string, number>;
    };
    try {
      await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
      if (flag(values, 'once')) {
        const m = await read();
        if (ctx.json) console.log(JSON.stringify(m, null, 2));
        else console.log(table(Object.entries(m).map(([k, v]) => [k, Number.isInteger(v) ? String(v) : v.toFixed(3)])));
        return;
      }
      process.stderr.write(`watching "${truncate(target.title || target.url, 60)}", Ctrl+C to stop\n`);
      const stop = untilStopped(num(values, 'duration', 0));
      let stopped = false;
      void stop.then(() => (stopped = true));
      let prev = await read();
      const widths = [10, 6, 7, 13, 8, 9];
      const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join(' ').trimEnd();
      if (!ctx.json) console.log(line(['time', 'busy', 'script', 'layout+style', 'JS heap', 'DOM nodes']));
      while (!stopped) {
        await Promise.race([Bun.sleep(1000), stop]);
        if (stopped) break;
        const cur = await read();
        const wall = (cur.Timestamp ?? 0) - (prev.Timestamp ?? 0) || 1;
        const share = (key: (typeof METRIC_KEYS)[number]) => ((cur[key] ?? 0) - (prev[key] ?? 0)) / wall;
        const row = [
          new Date().toTimeString().slice(0, 8),
          `${Math.round(share('TaskDuration') * 100)}%`,
          `${Math.round(share('ScriptDuration') * 100)}%`,
          `${Math.round((share('LayoutDuration') + share('RecalcStyleDuration')) * 100)}%`,
          mb(cur.JSHeapUsedSize ?? 0),
          String(cur.Nodes ?? 0),
        ];
        console.log(ctx.json ? JSON.stringify(cur) : line(row));
        prev = cur;
      }
    } finally {
      cdp.close();
    }
  },
};
