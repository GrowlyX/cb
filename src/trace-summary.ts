import { percentile } from './format.ts';
import type { ProcessAccumulator, ProcessSummary, TraceEvent, TraceIndex, TraceSummary } from './types.ts';

/** Main thread names for renderer, GPU and browser processes. */
const MAIN_THREADS = new Set(['CrRendererMain', 'CrGpuMain', 'CrBrowserMain']);

/** Top-level task event names, newest first. Newer Chrome nests RunTask inside the first. */
const TASK_NAMES = ['ThreadControllerImpl::RunTask', 'RunTask'];

const GC_NAMES = new Set(['MajorGC', 'MinorGC']);
const DISPLAY_FRAME_NAMES = new Set(['Display::DrawAndSwap', 'DisplayScheduler::DrawAndSwap']);

/** Phases that mark real activity inside the recording window (complete, instant, begin/end). */
const SPAN_PHASES = new Set(['X', 'I', 'i', 'B', 'E']);

const LONG_TASK_MS = 50;

/** Accepts either trace file shape Chrome writes: a bare array or `{ traceEvents: [...] }`. */
export function traceEvents(trace: unknown): TraceEvent[] {
  if (Array.isArray(trace)) {
    return trace as TraceEvent[];
  }

  const events = (trace as { traceEvents?: unknown }).traceEvents;

  if (Array.isArray(events)) {
    return events as TraceEvent[];
  }

  throw new Error('not a Chrome trace: expected an array or { traceEvents }');
}

/** Per-process main-thread load, long tasks, GC and animation frame rate from a timeline trace. */
export function summarizeTrace(events: TraceEvent[]): TraceSummary {
  const index = indexTrace(events);
  const durationMs = index.end > index.start ? (index.end - index.start) / 1000 : 0;
  const accumulators = new Map<number, ProcessAccumulator>();
  let displayFrames = 0;

  for (const event of events) {
    if (event.ts !== undefined && event.ts < index.start) {
      continue;
    }

    if (DISPLAY_FRAME_NAMES.has(event.name) && event.ph !== 'E') {
      displayFrames++;
    }

    if (index.mainThread.get(event.pid) !== event.tid) {
      continue;
    }

    accumulate(accumulatorFor(accumulators, event.pid), event);
  }

  const processes: ProcessSummary[] = [];

  for (const [pid, acc] of accumulators) {
    processes.push(summarizeProcess(pid, acc, index, durationMs));
  }

  processes.sort((a, b) => b.mainBusy - a.mainBusy);

  let displayFps: number | undefined;

  if (displayFrames > 0 && durationMs > 0) {
    displayFps = displayFrames / (durationMs / 1000);
  }

  return { durationMs, displayFps, processes };
}

/**
 * Reads metadata and finds the recording window. Async begin/end pairs can start long before
 * recording did, so the window opens at Chrome's own "tracing started" marker when present.
 */
function indexTrace(events: TraceEvent[]): TraceIndex {
  const marker = events.find((event) => event.name === 'TracingStartedInBrowser')?.ts;

  const index: TraceIndex = {
    processName: new Map(),
    processLabel: new Map(),
    mainThread: new Map(),
    hosts: new Map(),
    start: marker ?? Number.POSITIVE_INFINITY,
    end: Number.NEGATIVE_INFINITY,
  };

  for (const event of events) {
    if (event.ph === 'M') {
      readMetadata(index, event);
      continue;
    }

    countHost(index, event);

    if (!event.ts || !SPAN_PHASES.has(event.ph)) {
      continue;
    }

    if (marker === undefined) {
      index.start = Math.min(index.start, event.ts);
    } else if (event.ts < marker) {
      continue;
    }

    index.end = Math.max(index.end, event.ts + (event.dur ?? 0));
  }

  return index;
}

/** Records process names, labels and main thread ids. */
function readMetadata(index: TraceIndex, event: TraceEvent): void {
  if (event.name === 'process_name') {
    index.processName.set(event.pid, String(event.args?.name ?? ''));
  }

  if (event.name === 'process_labels') {
    index.processLabel.set(event.pid, String(event.args?.labels ?? ''));
  }

  if (event.name === 'thread_name' && MAIN_THREADS.has(String(event.args?.name))) {
    index.mainThread.set(event.pid, event.tid);
  }
}

/** Counts the URL hosts a process's events mention, to name renderers by site. */
function countHost(index: TraceIndex, event: TraceEvent): void {
  const host = urlHost(event.args?.data?.url ?? event.args?.beginData?.url);

  if (!host) {
    return;
  }

  const counts = index.hosts.get(event.pid) ?? new Map<string, number>();
  counts.set(host, (counts.get(host) ?? 0) + 1);
  index.hosts.set(event.pid, counts);
}

/** The accumulator for a process, created on first use. */
function accumulatorFor(accumulators: Map<number, ProcessAccumulator>, pid: number): ProcessAccumulator {
  let acc = accumulators.get(pid);

  if (!acc) {
    acc = { tasksByName: new Map(), gcMs: 0, raf: [] };
    accumulators.set(pid, acc);
  }

  return acc;
}

/** Adds one main-thread event to its process's totals. */
function accumulate(acc: ProcessAccumulator, event: TraceEvent): void {
  if (event.name === 'UpdateCounters') {
    const used = event.args?.data?.jsHeapSizeUsed;

    if (typeof used === 'number') {
      acc.heap = Math.max(acc.heap ?? 0, used);
    }

    return;
  }

  if (event.ph !== 'X' || event.dur === undefined) {
    return;
  }

  const durMs = event.dur / 1000;

  if (TASK_NAMES.includes(event.name)) {
    const list = acc.tasksByName.get(event.name) ?? [];
    list.push(durMs);
    acc.tasksByName.set(event.name, list);
  } else if (GC_NAMES.has(event.name)) {
    acc.gcMs += durMs;
  } else if (event.name === 'FireAnimationFrame') {
    acc.raf.push(durMs);
  }
}

/** Turns a process's totals into its summary row. Only one level of task nesting is counted. */
function summarizeProcess(pid: number, acc: ProcessAccumulator, index: TraceIndex, durationMs: number): ProcessSummary {
  const tasks = topLevelTasks(acc);
  const busy = tasks.reduce((sum, value) => sum + value, 0);
  const name = index.processName.get(pid) ?? `pid ${pid}`;
  const label = index.processLabel.get(pid) || topKey(index.hosts.get(pid));
  const seconds = durationMs / 1000;

  return {
    pid,
    label: label ? `${name} (${label})` : name,
    mainBusy: durationMs > 0 ? Math.min(1, busy / durationMs) : 0,
    longTasks: tasks.filter((value) => value > LONG_TASK_MS).length,
    maxTaskMs: tasks.length > 0 ? Math.max(...tasks) : 0,
    gcMs: acc.gcMs,
    rafPerSecond: seconds > 0 ? acc.raf.length / seconds : 0,
    rafP95Ms: percentile(acc.raf, 95),
    heapMb: acc.heap === undefined ? undefined : acc.heap / 1024 / 1024,
  };
}

/** Task durations under the outermost task name this Chrome version emits. */
function topLevelTasks(acc: ProcessAccumulator): number[] {
  for (const name of TASK_NAMES) {
    const list = acc.tasksByName.get(name);

    if (list && list.length > 0) {
      return list;
    }
  }

  return [];
}

/** The hostname of an http(s) URL, or undefined. */
function urlHost(url: unknown): string | undefined {
  if (typeof url !== 'string' || !/^https?:/.test(url)) {
    return undefined;
  }

  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** The key with the highest count. */
function topKey(counts?: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = 0;

  for (const [key, count] of counts ?? []) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }

  return best;
}
