import { percentile } from './format.ts';

export interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  ts?: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, any>;
}

export interface ProcessSummary {
  pid: number;
  label: string;
  /** Share of the recording the main thread spent running tasks, 0-1. */
  mainBusy: number;
  longTasks: number;
  maxTaskMs: number;
  gcMs: number;
  /** requestAnimationFrame callbacks per second; 0 when the page is not animating. */
  rafPerSecond: number;
  rafP95Ms: number;
  heapMb?: number;
}

export interface TraceSummary {
  durationMs: number;
  /** Frames the display compositor drew per second, across the whole screen. */
  displayFps?: number;
  processes: ProcessSummary[];
}

const MAIN_THREADS = new Set(['CrRendererMain', 'CrGpuMain', 'CrBrowserMain']);
const TASK_NAMES = ['ThreadControllerImpl::RunTask', 'RunTask'];
const GC_NAMES = new Set(['MajorGC', 'MinorGC']);
const LONG_TASK_MS = 50;
const SPAN_PHASES = new Set(['X', 'I', 'i', 'B', 'E']);
const DISPLAY_FRAME_NAMES = new Set(['Display::DrawAndSwap', 'DisplayScheduler::DrawAndSwap']);

function urlHost(url: unknown): string | undefined {
  if (typeof url !== 'string' || !/^https?:/.test(url)) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** The site whose scripts and documents a renderer touched most, as a stand-in for its name. */
function topKey(counts?: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;
  for (const [key, count] of counts ?? []) {
    if (count > bestCount) [best, bestCount] = [key, count];
  }
  return best;
}

/** Accepts either trace file shape Chrome writes: a bare array or `{ traceEvents: [...] }`. */
export function traceEvents(trace: unknown): TraceEvent[] {
  if (Array.isArray(trace)) return trace as TraceEvent[];
  const events = (trace as { traceEvents?: unknown }).traceEvents;
  if (Array.isArray(events)) return events as TraceEvent[];
  throw new Error('not a Chrome trace: expected an array or { traceEvents }');
}

/** Per-process main-thread load, long tasks, GC and animation frame rate from a timeline trace. */
export function summarizeTrace(events: TraceEvent[]): TraceSummary {
  const processName = new Map<number, string>();
  const processLabel = new Map<number, string>();
  const mainThread = new Map<number, number>();
  const hosts = new Map<number, Map<string, number>>();

  // Async begin/end pairs can start long before recording did, so the window opens at
  // Chrome's own "tracing started" marker and only spans complete and instant events.
  const marker = events.find((e) => e.name === 'TracingStartedInBrowser')?.ts;
  let start = marker ?? Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;

  for (const e of events) {
    if (e.ph === 'M') {
      if (e.name === 'process_name') processName.set(e.pid, String(e.args?.name ?? ''));
      if (e.name === 'process_labels') processLabel.set(e.pid, String(e.args?.labels ?? ''));
      if (e.name === 'thread_name' && MAIN_THREADS.has(String(e.args?.name))) mainThread.set(e.pid, e.tid);
      continue;
    }
    const host = urlHost(e.args?.data?.url ?? e.args?.beginData?.url);
    if (host) {
      const counts = hosts.get(e.pid) ?? new Map<string, number>();
      counts.set(host, (counts.get(host) ?? 0) + 1);
      hosts.set(e.pid, counts);
    }
    if (!e.ts || !SPAN_PHASES.has(e.ph)) continue;
    if (marker === undefined) start = Math.min(start, e.ts);
    else if (e.ts < marker) continue;
    end = Math.max(end, e.ts + (e.dur ?? 0));
  }
  const durationMs = Number.isFinite(start) && end > start ? (end - start) / 1000 : 0;

  interface Acc {
    tasksByName: Map<string, number[]>;
    gcMs: number;
    raf: number[];
    heap?: number;
  }
  const acc = new Map<number, Acc>();
  const get = (pid: number): Acc => {
    let a = acc.get(pid);
    if (!a) acc.set(pid, (a = { tasksByName: new Map(), gcMs: 0, raf: [] }));
    return a;
  };
  let displayFrames = 0;

  for (const e of events) {
    if (e.ts !== undefined && e.ts < start) continue;
    if (DISPLAY_FRAME_NAMES.has(e.name) && e.ph !== 'E') displayFrames++;
    if (mainThread.get(e.pid) !== e.tid) continue;
    if (e.name === 'UpdateCounters') {
      const used = e.args?.data?.jsHeapSizeUsed;
      if (typeof used === 'number') get(e.pid).heap = Math.max(get(e.pid).heap ?? 0, used);
      continue;
    }
    if (e.ph !== 'X' || e.dur === undefined) continue;
    const durMs = e.dur / 1000;
    if (TASK_NAMES.includes(e.name)) {
      const a = get(e.pid);
      const list = a.tasksByName.get(e.name) ?? [];
      list.push(durMs);
      a.tasksByName.set(e.name, list);
    } else if (GC_NAMES.has(e.name)) {
      get(e.pid).gcMs += durMs;
    } else if (e.name === 'FireAnimationFrame') {
      get(e.pid).raf.push(durMs);
    }
  }

  const processes: ProcessSummary[] = [];
  for (const [pid, a] of acc) {
    // Newer Chrome nests RunTask inside ThreadControllerImpl::RunTask; count one level only.
    const tasks = TASK_NAMES.map((n) => a.tasksByName.get(n)).find((l) => l && l.length > 0) ?? [];
    const busy = tasks.reduce((sum, d) => sum + d, 0);
    const name = processName.get(pid) ?? `pid ${pid}`;
    const label = processLabel.get(pid) || topKey(hosts.get(pid));
    processes.push({
      pid,
      label: label ? `${name} (${label})` : name,
      mainBusy: durationMs > 0 ? Math.min(1, busy / durationMs) : 0,
      longTasks: tasks.filter((d) => d > LONG_TASK_MS).length,
      maxTaskMs: tasks.length ? Math.max(...tasks) : 0,
      gcMs: a.gcMs,
      rafPerSecond: durationMs > 0 ? a.raf.length / (durationMs / 1000) : 0,
      rafP95Ms: percentile(a.raf, 95),
      heapMb: a.heap === undefined ? undefined : a.heap / 1024 / 1024,
    });
  }
  processes.sort((x, y) => y.mainBusy - x.mainBusy);

  return {
    durationMs,
    displayFps: displayFrames > 0 && durationMs > 0 ? displayFrames / (durationMs / 1000) : undefined,
    processes,
  };
}
