import { describe, expect, test } from 'bun:test';
import { summarizeTrace, type TraceEvent, traceEvents } from '../src/trace-summary.ts';

const meta = (pid: number, tid: number, name: string, args: object): TraceEvent => ({ ph: 'M', name, pid, tid, args });
const task = (pid: number, tid: number, ts: number, durMs: number, name = 'ThreadControllerImpl::RunTask'): TraceEvent => ({
  ph: 'X',
  name,
  pid,
  tid,
  ts,
  dur: durMs * 1000,
});

describe('traceEvents', () => {
  test('accepts both trace shapes', () => {
    expect(traceEvents([])).toEqual([]);
    expect(traceEvents({ traceEvents: [] })).toEqual([]);
    expect(() => traceEvents({})).toThrow('not a Chrome trace');
  });
});

describe('summarizeTrace', () => {
  const start = 1_000_000;
  const events: TraceEvent[] = [
    meta(1, 10, 'process_name', { name: 'Renderer' }),
    meta(1, 10, 'thread_name', { name: 'CrRendererMain' }),
    meta(1, 11, 'thread_name', { name: 'Compositor' }),
    meta(2, 20, 'process_name', { name: 'GPU Process' }),
    meta(2, 20, 'thread_name', { name: 'CrGpuMain' }),
    // An async event from before recording started must not stretch the window.
    { ph: 'b', name: 'PipelineReporter', pid: 1, tid: 11, ts: start - 9_000_000 },
    { ph: 'I', name: 'TracingStartedInBrowser', pid: 3, tid: 30, ts: start },
    { ph: 'X', name: 'EvaluateScript', pid: 1, tid: 10, ts: start + 1, dur: 1, args: { data: { url: 'https://game.example/a.js' } } },
    task(1, 10, start + 0, 100),
    task(1, 10, start + 200_000, 20),
    task(1, 10, start + 200_000, 19, 'RunTask'), // nested inside the one above
    task(1, 11, start + 0, 900), // compositor thread, not main
    { ph: 'X', name: 'MajorGC', pid: 1, tid: 10, ts: start + 10, dur: 30_000 },
    { ph: 'X', name: 'FireAnimationFrame', pid: 1, tid: 10, ts: start + 300_000, dur: 4_000 },
    { ph: 'X', name: 'FireAnimationFrame', pid: 1, tid: 10, ts: start + 316_000, dur: 6_000 },
    { ph: 'I', name: 'UpdateCounters', pid: 1, tid: 10, ts: start + 5, args: { data: { jsHeapSizeUsed: 64 * 1024 * 1024 } } },
    task(2, 20, start + 0, 250),
    { ph: 'X', name: 'Display::DrawAndSwap', pid: 2, tid: 21, ts: start + 10, dur: 1 },
    { ph: 'X', name: 'Display::DrawAndSwap', pid: 2, tid: 21, ts: start + 20, dur: 1 },
    { ph: 'I', name: 'end', pid: 3, tid: 30, ts: start + 1_000_000 },
  ];
  const s = summarizeTrace(events);

  test('the window opens at TracingStartedInBrowser', () => {
    expect(s.durationMs).toBe(1000);
  });
  test('per-process main thread load, long tasks and GC', () => {
    const renderer = s.processes.find((p) => p.pid === 1)!;
    expect(renderer.label).toBe('Renderer (game.example)');
    expect(renderer.mainBusy).toBeCloseTo(0.12, 5);
    expect(renderer.longTasks).toBe(1);
    expect(renderer.maxTaskMs).toBe(100);
    expect(renderer.gcMs).toBe(30);
    expect(renderer.rafPerSecond).toBe(2);
    expect(renderer.rafP95Ms).toBe(6);
    expect(renderer.heapMb).toBe(64);
  });
  test('busiest process first, display frames counted', () => {
    expect(s.processes[0]!.label).toBe('GPU Process');
    expect(s.displayFps).toBe(2);
  });
});
