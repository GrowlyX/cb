import { type Command, connect, flag, need, str } from '../command.ts';
import { table, truncate } from '../format.ts';
import { resolveTarget, visibleTargets } from '../targets.ts';

/** Status fields read on the Chromebook in one round trip. */
const SYS_SCRIPT = String.raw`
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

export function parseSys(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export const status: Command = {
  name: 'status',
  summary: 'Check the connection and show Chrome, CPU, memory, battery and temperatures',
  usage: '',
  async run({ cb, json }) {
    const [version, sys, targets] = await Promise.all([
      cb.version(),
      cb.remote.exec(SYS_SCRIPT).then((r) => parseSys(r.stdout)),
      cb.targets(),
    ]);
    const tabs = visibleTargets(targets, false).length;
    if (json) {
      console.log(JSON.stringify({ version, system: Object.fromEntries(sys), tabs }, null, 2));
      return;
    }
    const kb = (key: string) => Math.round(Number(sys.get(key) ?? 0) / 1024);
    const temps = [...sys]
      .filter(([k]) => k.startsWith('temp.'))
      .map(([k, v]) => `${k.slice(5)} ${Math.round(Number(v) / 1000)}°C`)
      .join(', ');
    console.log(
      table([
        ['host', `${cb.remote.destination} (DevTools on 127.0.0.1:${cb.config.localPort})`],
        ['chrome', `${version.Browser}, ChromeOS ${sys.get('release') ?? '?'} (${(sys.get('board') ?? '?').replace(/-signed-.*/, '')})`],
        ['cpu', `${sys.get('model') ?? '?'}, ${sys.get('cpus')} cores @ ${sys.get('cpuMHz')} MHz, load ${sys.get('load')}`],
        ['memory', `${kb('memAvail')} MB available of ${kb('memTotal')} MB`],
        ['battery', `${sys.get('battery') || '?'}% ${(sys.get('charging') ?? '').toLowerCase()}`],
        ['temps', temps || 'unavailable'],
        ['uptime', duration(Number(sys.get('uptime') ?? 0))],
        ['tabs', `${tabs} open`],
      ]),
    );
  },
};

export const tabs: Command = {
  name: 'tabs',
  summary: 'List open tabs (with --all, iframes, workers and extensions too)',
  usage: '[--all]',
  details: ['The number in the first column works as `-t <n>` in every other command.'],
  options: { all: { type: 'boolean', short: 'a' } },
  async run({ cb, json }, _args, values) {
    const rows = visibleTargets(await cb.targets(), flag(values, 'all'));
    if (json) {
      console.log(JSON.stringify(rows.map(({ index, target }) => ({ index, ...target })), null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('no tabs open');
      return;
    }
    console.log(
      table([
        ['#', 'id', 'type', 'title', 'url'],
        ...rows.map(({ index, target: t }) => [
          String(index),
          t.id.slice(0, 8),
          t.type,
          truncate(t.title === t.url ? '' : t.title, 40),
          truncate(t.url, 70),
        ]),
      ]),
    );
  },
};

export const open: Command = {
  name: 'open',
  summary: 'Open a URL in a new tab',
  usage: '<url> [--background]',
  options: { background: { type: 'boolean' } },
  async run({ cb }, args, values) {
    const url = need(args, 0, 'url');
    const browser = await cb.browser();
    try {
      const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', {
        url,
        background: flag(values, 'background'),
      });
      console.log(targetId);
    } finally {
      browser.close();
    }
  },
};

export const nav: Command = {
  name: 'nav',
  summary: 'Navigate a tab to a URL',
  usage: '<url> [-t tab]',
  async run(ctx, args) {
    const url = need(args, 0, 'url');
    const { cdp } = await connect(ctx, { page: true });
    try {
      const result = await cdp.send<{ errorText?: string }>('Page.navigate', { url });
      if (result.errorText) throw new Error(`navigation failed: ${result.errorText}`);
    } finally {
      cdp.close();
    }
  },
};

export const reload: Command = {
  name: 'reload',
  summary: 'Reload a tab',
  usage: '[-t tab] [--hard]',
  options: { hard: { type: 'boolean' } },
  async run(ctx, _args, values) {
    const { cdp } = await connect(ctx, { page: true });
    try {
      await cdp.send('Page.reload', { ignoreCache: flag(values, 'hard') });
    } finally {
      cdp.close();
    }
  },
};

async function browserTargetCall(ctx: Parameters<Command['run']>[0], method: string): Promise<void> {
  const target = resolveTarget(await ctx.cb.targets(), ctx.selector);
  const browser = await ctx.cb.browser();
  try {
    await browser.send(method, { targetId: target.id });
  } finally {
    browser.close();
  }
}

export const close: Command = {
  name: 'close',
  summary: 'Close a tab',
  usage: '-t tab',
  async run(ctx) {
    if (!ctx.selector) throw new Error('pass -t to say which tab to close');
    await browserTargetCall(ctx, 'Target.closeTarget');
  },
};

export const focus: Command = {
  name: 'focus',
  summary: 'Bring a tab to the front',
  usage: '[-t tab]',
  async run(ctx) {
    await browserTargetCall(ctx, 'Target.activateTarget');
  },
};

export const evaluate: Command = {
  name: 'eval',
  summary: 'Run JavaScript in a tab or iframe and print the result',
  usage: '<expression> [-t target]',
  details: ['Promises are awaited. Use `-t` with an iframe to run inside it (e.g. a game frame).'],
  async run(ctx, args) {
    const expression = need(args, 0, 'expression');
    const { cdp } = await connect(ctx);
    try {
      const { result, exceptionDetails } = await cdp.send<{
        result: { type: string; value?: unknown; description?: string };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      const value = 'value' in result ? result.value : result.description;
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    } finally {
      cdp.close();
    }
  },
};

export const devtools: Command = {
  name: 'devtools',
  summary: "Open Chrome's full DevTools for a tab, in a browser on this machine",
  usage: '[-t target] [--print]',
  details: ['Uses the DevTools UI the Chromebook serves, so it always matches its Chrome version.'],
  options: { print: { type: 'boolean' } },
  async run(ctx, _args, values) {
    const target = resolveTarget(await ctx.cb.targets(), ctx.selector);
    const url = ctx.cb.inspectorUrl(target);
    console.log(url);
    if (!flag(values, 'print') && process.platform === 'darwin') {
      await Bun.spawn(['open', url]).exited;
    }
  },
};

export const sh: Command = {
  name: 'sh',
  summary: 'Run a command on the Chromebook, or open a root shell',
  usage: '[command...]',
  async run({ cb }, args) {
    return cb.remote.attach(args);
  },
};

export const tunnel: Command = {
  name: 'tunnel',
  summary: 'Show, start or stop the SSH connection cb keeps open',
  usage: '[up|down]',
  async run({ cb }, args) {
    const action = args[0] ?? 'status';
    if (action === 'up') {
      await cb.remote.up();
      console.log(`up: 127.0.0.1:${cb.config.localPort} -> ${cb.config.host}:${cb.config.remotePort}`);
    } else if (action === 'down') {
      console.log((await cb.remote.down()) ? 'down' : 'was not running');
    } else if (action === 'status') {
      const up = await cb.remote.isUp();
      console.log(up ? `up: 127.0.0.1:${cb.config.localPort} -> ${cb.config.host}:${cb.config.remotePort}` : 'down');
      return up ? 0 : 1;
    } else {
      throw new Error(`unknown action "${action}" (use up, down or nothing)`);
    }
  },
};

/** Two snapshots of per-process CPU ticks a second apart, then RSS and argv for every process. */
const TOP_SCRIPT = String.raw`
snap() { cat /proc/[0-9]*/stat 2>/dev/null | sed 's/^\([0-9]*\) (.*) [A-Za-z] /\1 /' | awk '{print $1, $12+$13}'; }
snap; echo ---; sleep 1; snap; echo ---
ps -eo pid=,rss=,args=
`;

export function parseTop(output: string, limit: number) {
  const [before = '', after = '', ps = ''] = output.split('---\n');
  const ticks = (block: string) =>
    new Map(block.trim().split('\n').filter(Boolean).map((l) => {
      const [pid = '', t = '0'] = l.split(' ');
      return [pid, Number(t)] as const;
    }));
  const t0 = ticks(before);
  const t1 = ticks(after);
  return ps
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid = '', rss = '', ...argv] = line.trim().split(/\s+/);
      // Linux reports CPU time in 1/100s ticks, so ticks over one second is a percentage.
      const cpu = Math.max(0, (t1.get(pid) ?? 0) - (t0.get(pid) ?? 0));
      return { pid, cpu, rssMb: Math.round(Number(rss) / 1024), name: describeProcess(argv) };
    })
    .sort((a, b) => b.cpu - a.cpu || b.rssMb - a.rssMb)
    .slice(0, limit);
}

export const top: Command = {
  name: 'top',
  summary: 'Busiest processes on the Chromebook over one second, Chrome processes labeled by type',
  usage: '[-n 15]',
  options: { n: { type: 'string', short: 'n' } },
  async run({ cb, json }, _args, values) {
    const { stdout } = await cb.remote.exec(TOP_SCRIPT);
    const rows = parseTop(stdout, Number(str(values, 'n') ?? 15));
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.log(
      table([
        ['pid', 'cpu%', 'mem', 'process'],
        ...rows.map((r) => [r.pid, String(r.cpu), `${r.rssMb}MB`, r.name]),
      ]),
    );
  },
};

export function describeProcess(argv: string[]): string {
  const exe = argv[0] ?? '';
  const base = exe.split('/').at(-1) ?? exe;
  if (base !== 'chrome') return truncate(argv.join(' '), 60);
  const type = argv.find((a) => a.startsWith('--type='))?.slice(7);
  if (!type) return 'chrome (browser)';
  const extras = [
    argv.includes('--extension-process') ? 'extension' : '',
    argv.find((a) => a.startsWith('--utility-sub-type='))?.slice(19) ?? '',
  ].filter(Boolean);
  return `chrome ${type}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

export const gpu: Command = {
  name: 'gpu',
  summary: "Show the GPU and which graphics features are hardware accelerated (like chrome://gpu)",
  usage: '[--all]',
  options: { all: { type: 'boolean', short: 'a' } },
  async run({ cb, json }, _args, values) {
    const browser = await cb.browser();
    try {
      const info = await browser.send<{
        gpu: {
          devices: Array<{ vendorString: string; deviceString: string; driverVendor: string; driverVersion: string }>;
          auxAttributes: Record<string, unknown>;
          featureStatus: Record<string, string>;
          driverBugWorkarounds: string[];
        };
        modelName: string;
      }>('SystemInfo.getInfo');
      if (json || flag(values, 'all')) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      const g = info.gpu;
      for (const d of g.devices) {
        console.log(`gpu      ${d.vendorString || '?'} ${d.deviceString || ''}`.trimEnd());
        if (d.driverVendor || d.driverVersion) console.log(`driver   ${d.driverVendor} ${d.driverVersion}`.trimEnd());
      }
      const aux = g.auxAttributes;
      for (const key of ['glRenderer', 'glVersion', 'glImplementationParts']) {
        if (aux[key] !== undefined) console.log(`${key.padEnd(8)} ${String(aux[key])}`);
      }
      console.log('');
      console.log(table(Object.entries(g.featureStatus).map(([k, v]) => [k, v])));
      if (g.driverBugWorkarounds.length) console.log(`\n${g.driverBugWorkarounds.length} driver workarounds active (--all to list)`);
    } finally {
      browser.close();
    }
  },
};
