import type { ParseArgsConfig } from 'node:util';
import type { Cdp } from './cdp.ts';
import type { Chromebook } from './chromebook.ts';

/** Where the Chromebook is and which ports the DevTools tunnel uses. */
export interface Config {
  /** SSH host for the Chromebook, usually its Tailscale name. */
  host: string;

  /** SSH user. Root, so system stats and `cb sh` can read everything. */
  user: string;

  /** Port Chrome's DevTools listens on, on the Chromebook (`--remote-debugging-port`). */
  remotePort: number;

  /** Port the tunnel listens on, on this machine. */
  localPort: number;
}

/** The reply from Chrome's `/json/version` endpoint. */
export interface BrowserVersion {
  Browser: string;
  'Protocol-Version': string;
  'User-Agent': string;
  'V8-Version': string;
  webSocketDebuggerUrl: string;
}

/** A row from Chrome's `/json/list` endpoint: a tab, iframe, worker or extension page. */
export interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  parentId?: string;
  webSocketDebuggerUrl?: string;
}

/** A target with the index `cb tabs` shows for it. */
export interface IndexedTarget {
  index: number;
  target: Target;
}

/** Output of a command run on the Chromebook over SSH. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Listener for a DevTools protocol event. */
export type CdpHandler = (params: any) => void;

/** A DevTools protocol request waiting for its reply. */
export interface PendingCall {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/** A DevTools protocol message: either a reply (with `id`) or an event (with `method`). */
export interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The result of `Runtime.evaluate` with `returnByValue`. */
export interface EvaluateResult<T = unknown> {
  result: { type: string; value?: T; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

/** Option definitions in the shape `util.parseArgs` takes. */
export type Options = NonNullable<ParseArgsConfig['options']>;

/** Parsed option values. */
export type Values = Record<string, string | boolean | string[] | boolean[] | undefined>;

/** What every command receives besides its own arguments. */
export interface Context {
  cb: Chromebook;

  /** The `-t` selector, if one was given. */
  selector?: string;

  json: boolean;
}

/** A `cb` subcommand. */
export interface Command {
  name: string;
  summary: string;

  /** Usage after `cb <name>`, e.g. `<url>` or `[-o file.png]`. */
  usage: string;

  /** Extra lines shown by `cb help <name>`. */
  details?: string[];

  options?: Options;

  run(ctx: Context, args: string[], values: Values): Promise<number | void>;
}

/** A connected DevTools session and the target it belongs to. */
export interface Session {
  target: Target;
  cdp: Cdp;
}

/** How a wait ended: its time ran out, or the user pressed Ctrl+C. */
export type StopReason = 'timeout' | 'interrupt';

/** The fields `Input.dispatchKeyEvent` needs for one key. */
export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;

  /** Set for keys that type a character. */
  text?: string;
}

/** One screencast frame saved to disk. */
export interface Frame {
  file: string;

  /** Seconds, from the screencast frame's metadata. */
  timestamp: number;
}

/** Frame rate and frame-time statistics from requestAnimationFrame intervals. */
export interface FpsReport {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;

  /** Frames that took over 33ms (below 30fps). */
  over33: number;

  /** Frames that took over 50ms (below 20fps). */
  over50: number;
}

/** GPU info as `SystemInfo.getInfo` reports it. */
export interface GpuInfo {
  gpu: {
    devices: Array<{ vendorString: string; deviceString: string; driverVendor: string; driverVersion: string }>;
    auxAttributes: Record<string, unknown>;
    featureStatus: Record<string, string>;
    driverBugWorkarounds: string[];
  };
}

/** A process from `cb top`. */
export interface ProcessRow {
  pid: string;

  /** CPU use over the sampled second, where 100 is one full core. */
  cpu: number;

  rssMb: number;
  name: string;
}

/** One reading of the Chromebook's CPU, memory, clock and temperature. */
export interface SystemSample {
  /** Busy and total jiffies across all cores, from /proc/stat. */
  cpuBusy: number;
  cpuTotal: number;

  memAvailableMb: number;
  memTotalMb: number;

  /** Average current clock across cores. */
  cpuMHz: number;

  /** Hottest thermal zone, in °C. */
  maxTempC: number;
}

/** One row of `cb monitor` output. System fields are missing until the sampler reports. */
export interface MonitorRow {
  time: string;
  frames: number;
  fps: number;
  frameP95Ms: number;
  slowFrames: number;

  /** Share of the interval the target's main thread spent running tasks, 0-1. */
  mainBusy: number;

  heapMb: number;

  /** Whole-system CPU use, 0-100, across all cores. */
  systemCpu?: number;

  memAvailableMb?: number;
  cpuMHz?: number;
  maxTempC?: number;
}

/** The latest system reading, and CPU use between the last two. */
export interface SystemState {
  latest?: SystemSample;
  cpu?: number;
}

/** How a `cb monitor` session runs and where its rows go. */
export interface MonitorOptions {
  seconds: number;
  interval: number;
  json: boolean;
  csv?: string;
  system: SystemState;
}

/** Everything a `cb monitor` session collected. */
export interface MonitorCapture {
  rows: MonitorRow[];
  intervals: number[];
  elapsed: number;
}

/** Totals and warnings for a whole `cb monitor` session. */
export interface MonitorSummary {
  seconds: number;
  frames: number;
  fps: number;

  /** Frame rate implied by the 99th percentile frame time ("1% low"). */
  lowFps: number;

  /** The lowest frame rate of any interval that drew frames. */
  worstIntervalFps: number;

  frameP95Ms: number;
  frameP99Ms: number;
  over33: number;
  over50: number;
  mainBusyAvg: number;
  mainBusyMax: number;
  heapStartMb: number;
  heapEndMb: number;
  heapMaxMb: number;
  systemCpuAvg?: number;
  systemCpuMax?: number;
  memAvailableMinMb?: number;
  cpuMHzMin?: number;
  cpuMHzMax?: number;
  maxTempC?: number;

  /** Plain-language observations, e.g. a growing heap or a dropping clock. */
  warnings: string[];
}

/** What the one-shot frame probe resolves with. */
export interface FpsProbeResult {
  intervals: number[];
  visibility: string;
}

/** A chunk of a trace stream from `IO.read`. */
export interface TraceChunk {
  data: string;
  eof: boolean;
  base64Encoded?: boolean;
}

/** A screencast frame as `Page.screencastFrame` delivers it. */
export interface ScreencastFrame {
  data: string;
  sessionId: number;
  metadata: { timestamp: number };
}

/** The frames a screencast saved and how long it ran. */
export interface ScreencastCapture {
  frames: Frame[];

  /** Seconds from the first frame to the end of recording. */
  elapsed: number;

  /** Screencast timestamp at which the recording ended, for the last frame's duration. */
  endTimestamp: number;
}

/** `Performance.getMetrics` as a name to value map. */
export type Metrics = Record<string, number>;

/** A Chrome trace event. */
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

/** Main-thread health for one process in a trace. */
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

/** Per-process totals gathered in one pass over a trace. */
export interface ProcessAccumulator {
  tasksByName: Map<string, number[]>;
  gcMs: number;
  raf: number[];
  heap?: number;
}

/** Process names, labels, main threads, URL hosts and the recording window of a trace. */
export interface TraceIndex {
  processName: Map<number, string>;
  processLabel: Map<number, string>;
  mainThread: Map<number, number>;
  hosts: Map<number, Map<string, number>>;
  start: number;
  end: number;
}

/** What `cb trace` prints after recording. */
export interface TraceSummary {
  durationMs: number;

  /** Frames the display compositor drew per second, across the whole screen. */
  displayFps?: number;

  processes: ProcessSummary[];
}

/** A node in a V8 CPU profile. */
export interface ProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount?: number;
  children?: number[];
}

/** A V8 CPU profile, as `Profiler.stop` returns it and DevTools loads it. */
export interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** Self time for one function across a CPU profile. */
export interface FunctionCost {
  name: string;
  location: string;
  selfMs: number;
  share: number;
}

/** What `cb profile` prints after recording. */
export interface ProfileSummary {
  durationMs: number;

  /** Time V8 spent idle, in garbage collection, or in native code it could not attribute. */
  idleMs: number;
  gcMs: number;
  programMs: number;

  functions: FunctionCost[];
}

/** Page load and layout stability numbers from the Performance API. */
export interface Vitals {
  url: string;
  ttfbMs?: number;
  fcpMs?: number;
  lcpMs?: number;
  domContentLoadedMs?: number;
  loadMs?: number;
  cls: number;
  resources: number;
  transferKb: number;
  jsHeapMb?: number;
}
