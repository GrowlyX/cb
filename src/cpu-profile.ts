import type { CpuProfile, FunctionCost, ProfileNode, ProfileSummary } from './types.ts';

/** V8's pseudo-functions for time it can't attribute to a JS function. */
const IDLE = '(idle)';
const GC = '(garbage collector)';
const PROGRAM = '(program)';
const ROOT = '(root)';

/**
 * Self time per function across a V8 CPU profile, busiest first. Each sample is charged the
 * time until the next sample, as DevTools does. Duration is the sampled time: V8 takes a moment
 * to start sampling, and that gap belongs to nobody. Shares are of active (non-idle) time.
 */
export function summarizeProfile(profile: CpuProfile, limit = 15): ProfileSummary {
  const selfUs = selfTimeByNode(profile);
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const byFunction = new Map<string, FunctionCost>();
  let idleUs = 0;
  let gcUs = 0;
  let programUs = 0;

  for (const [id, us] of selfUs) {
    const node = nodes.get(id);

    if (!node) {
      continue;
    }

    const name = node.callFrame.functionName;

    if (name === IDLE) {
      idleUs += us;
    } else if (name === GC) {
      gcUs += us;
    } else if (name === PROGRAM) {
      programUs += us;
    } else if (name !== ROOT) {
      addCost(byFunction, node, us);
    }
  }

  const sampledUs = [...selfUs.values()].reduce((sum, us) => sum + us, 0);
  const durationMs = sampledUs / 1000;
  const activeMs = Math.max(0, durationMs - idleUs / 1000);
  const functions = [...byFunction.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, limit);

  for (const fn of functions) {
    fn.share = activeMs > 0 ? fn.selfMs / activeMs : 0;
  }

  return {
    durationMs,
    idleMs: idleUs / 1000,
    gcMs: gcUs / 1000,
    programMs: programUs / 1000,
    functions,
  };
}

/** Microseconds of self time per node id, from samples when present, else from hit counts. */
function selfTimeByNode(profile: CpuProfile): Map<number, number> {
  const self = new Map<number, number>();
  const { samples, timeDeltas } = profile;

  if (samples && timeDeltas && samples.length === timeDeltas.length && samples.length > 0) {
    const times: number[] = [];
    let time = profile.startTime;

    for (const delta of timeDeltas) {
      time += delta;
      times.push(time);
    }

    for (let i = 0; i < samples.length; i++) {
      const next = times[i + 1] ?? profile.endTime;
      const duration = Math.max(0, next - times[i]!);
      self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + duration);
    }

    return self;
  }

  const hits = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
  const perHit = hits > 0 ? (profile.endTime - profile.startTime) / hits : 0;

  for (const node of profile.nodes) {
    self.set(node.id, (node.hitCount ?? 0) * perHit);
  }

  return self;
}

/** Adds a node's self time to the function it belongs to; a function appears once per call site. */
function addCost(byFunction: Map<string, FunctionCost>, node: ProfileNode, us: number): void {
  const { functionName, url, lineNumber } = node.callFrame;
  const key = `${functionName}|${url}|${lineNumber}`;
  const existing = byFunction.get(key);

  if (existing) {
    existing.selfMs += us / 1000;
    return;
  }

  byFunction.set(key, {
    name: functionName || '(anonymous)',
    location: describeLocation(url, lineNumber),
    selfMs: us / 1000,
    share: 0,
  });
}

/** `file.js:line` for scripts, `native` for code without a URL. */
function describeLocation(url: string, lineNumber: number): string {
  if (!url) {
    return 'native';
  }

  const path = url.split('?')[0]!;
  const file = path.split('/').filter(Boolean).at(-1) ?? path;

  return `${file}:${lineNumber + 1}`;
}
