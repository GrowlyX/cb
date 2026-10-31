import { truncate } from './format.ts';
import type { ProcessRow, SystemSample } from './types.ts';

/** Prints `key=value` lines describing the Chromebook, for `cb status`. */
export const STATUS_SCRIPT = `
echo "uptime=$(cut -d' ' -f1 /proc/uptime)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
awk '/^MemTotal/{print "memTotal="$2} /^MemAvailable/{print "memAvail="$2}' /proc/meminfo
echo "battery=$(cat /sys/class/power_supply/BAT*/capacity 2>/dev/null | head -1)"
echo "charging=$(cat /sys/class/power_supply/BAT*/status 2>/dev/null | head -1)"
echo "cpus=$(nproc)"
echo "cpuMHz=$(awk '/MHz/{s+=$4;n++} END{if(n) printf "%d", s/n}' /proc/cpuinfo)"
echo "model=$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo)"
echo "board=$(awk -F= '/CHROMEOS_RELEASE_BOARD/{print $2}' /etc/lsb-release)"
echo "release=$(awk -F= '/CHROMEOS_RELEASE_VERSION/{print $2}' /etc/lsb-release)"
for z in /sys/class/thermal/thermal_zone*; do echo "temp.$(cat $z/type)=$(cat $z/temp)"; done 2>/dev/null
`;

/**
 * Two snapshots of per-process CPU ticks a second apart, then RSS and argv for every process.
 * After stripping `pid (comm) state`, utime and stime are fields 12 and 13.
 */
export const TOP_SCRIPT = String.raw`
snap() { cat /proc/[0-9]*/stat 2>/dev/null | sed 's/^\([0-9]*\) (.*) [A-Za-z] /\1 /' | awk '{print $1, $12+$13}'; }
snap; echo ---; sleep 1; snap; echo ---
ps -eo pid=,rss=,args=
`;

/**
 * Prints one `S busy total memAvailKb memTotalKb mhz tempMilliC` line every `interval`
 * seconds until killed. CPU jiffies come from the aggregate line of /proc/stat.
 */
export function samplerScript(interval: number): string {
  return `
while :; do
  cpu=$(awk '/^cpu /{busy=$2+$3+$4+$7+$8+$9; print busy, busy+$5+$6}' /proc/stat)
  mem=$(awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END{print a, t}' /proc/meminfo)
  mhz=$(awk '/MHz/{s+=$4;n++} END{if(n) printf "%d", s/n; else print 0}' /proc/cpuinfo)
  temp=$(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | sort -n | tail -1)
  echo "S $cpu $mem $mhz \${temp:-0}"
  sleep ${interval}
done
`;
}

/** Parses `key=value` lines, splitting on the first `=`. */
export function parseKeyValues(output: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const line of output.split('\n')) {
    const eq = line.indexOf('=');

    if (eq > 0) {
      map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }

  return map;
}

/** Parses one sampler line, or returns undefined for anything else. */
export function parseSample(line: string): SystemSample | undefined {
  const parts = line.trim().split(/\s+/);

  if (parts[0] !== 'S' || parts.length < 7) {
    return undefined;
  }

  const [busy, total, availKb, totalKb, mhz, milliC] = parts.slice(1).map(Number);

  return {
    cpuBusy: busy!,
    cpuTotal: total!,
    memAvailableMb: Math.round(availKb! / 1024),
    memTotalMb: Math.round(totalKb! / 1024),
    cpuMHz: mhz!,
    maxTempC: milliC! / 1000,
  };
}

/** Whole-system CPU use between two samples, 0-100. */
export function systemCpu(previous: SystemSample, current: SystemSample): number {
  const total = current.cpuTotal - previous.cpuTotal;

  if (total <= 0) {
    return 0;
  }

  return ((current.cpuBusy - previous.cpuBusy) / total) * 100;
}

/** Turns TOP_SCRIPT output into the busiest processes, CPU as a percentage of one core. */
export function parseTop(output: string, limit: number): ProcessRow[] {
  const [before = '', after = '', ps = ''] = output.split('---\n');
  const ticksBefore = parseTicks(before);
  const ticksAfter = parseTicks(after);

  const rows = ps
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid = '', rss = '', ...argv] = line.trim().split(/\s+/);
      const delta = (ticksAfter.get(pid) ?? 0) - (ticksBefore.get(pid) ?? 0);

      return {
        pid,
        cpu: Math.max(0, delta),
        rssMb: Math.round(Number(rss) / 1024),
        name: describeProcess(argv),
      };
    });

  rows.sort((a, b) => b.cpu - a.cpu || b.rssMb - a.rssMb);

  return rows.slice(0, limit);
}

/** `pid ticks` lines as a map. Linux counts 100 ticks a second, so a delta over 1s is a percentage. */
function parseTicks(block: string): Map<string, number> {
  const ticks = new Map<string, number>();

  for (const line of block.trim().split('\n')) {
    const [pid, count] = line.split(' ');

    if (pid) {
      ticks.set(pid, Number(count ?? 0));
    }
  }

  return ticks;
}

/** A short name for a process; Chrome processes are labeled by their `--type`. */
export function describeProcess(argv: string[]): string {
  const exe = argv[0] ?? '';
  const base = exe.split('/').at(-1) ?? exe;

  if (base !== 'chrome') {
    return truncate(argv.join(' '), 60);
  }

  const type = argv.find((arg) => arg.startsWith('--type='))?.slice('--type='.length);

  if (!type) {
    return 'chrome (browser)';
  }

  const extras: string[] = [];

  if (argv.includes('--extension-process')) {
    extras.push('extension');
  }

  const subType = argv.find((arg) => arg.startsWith('--utility-sub-type='));

  if (subType) {
    extras.push(subType.slice('--utility-sub-type='.length));
  }

  if (extras.length === 0) {
    return `chrome ${type}`;
  }

  return `chrome ${type} (${extras.join(', ')})`;
}
