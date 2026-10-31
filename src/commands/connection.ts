import { flag, num } from '../command.ts';
import { table } from '../format.ts';
import { parseKeyValues, parseTop, STATUS_SCRIPT, TOP_SCRIPT } from '../system.ts';
import { visibleTargets } from '../targets.ts';
import type { Command, GpuInfo } from '../types.ts';

/** Uptime as `3h 12m` or `12m`. */
function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

/** Every thermal zone as `name 40°C`, comma separated. */
function formatTemps(values: Map<string, string>): string {
  const temps: string[] = [];

  for (const [key, value] of values) {
    if (key.startsWith('temp.')) {
      temps.push(`${key.slice('temp.'.length)} ${Math.round(Number(value) / 1000)}°C`);
    }
  }

  return temps.length > 0 ? temps.join(', ') : 'unavailable';
}

export const status: Command = {
  name: 'status',
  summary: 'Check the connection and show Chrome, CPU, memory, battery and temperatures',
  usage: '',

  async run({ cb, json }) {
    const [version, system, targets] = await Promise.all([
      cb.version(),
      cb.remote.exec(STATUS_SCRIPT).then((result) => parseKeyValues(result.stdout)),
      cb.targets(),
    ]);

    const tabs = visibleTargets(targets, false).length;

    if (json) {
      console.log(JSON.stringify({ version, system: Object.fromEntries(system), tabs }, null, 2));
      return;
    }

    const megabytes = (key: string) => Math.round(Number(system.get(key) ?? 0) / 1024);
    const board = (system.get('board') ?? '?').replace(/-signed-.*/, '');
    const charging = (system.get('charging') ?? '').toLowerCase();

    console.log(
      table([
        ['host', `${cb.remote.destination} (DevTools on 127.0.0.1:${cb.config.localPort})`],
        ['chrome', `${version.Browser}, ChromeOS ${system.get('release') ?? '?'} (${board})`],
        [
          'cpu',
          `${system.get('model') ?? '?'}, ${system.get('cpus')} cores @ ${system.get('cpuMHz')} MHz, load ${system.get('load')}`,
        ],
        ['memory', `${megabytes('memAvail')} MB available of ${megabytes('memTotal')} MB`],
        ['battery', `${system.get('battery') || '?'}% ${charging}`],
        ['temps', formatTemps(system)],
        ['uptime', formatUptime(Number(system.get('uptime') ?? 0))],
        ['tabs', `${tabs} open`],
      ]),
    );
  },
};

export const tunnel: Command = {
  name: 'tunnel',
  summary: 'Show, start or stop the SSH connection cb keeps open',
  usage: '[up|down]',

  async run({ cb }, args) {
    const action = args[0] ?? 'status';
    const route = `127.0.0.1:${cb.config.localPort} -> ${cb.config.host}:${cb.config.remotePort}`;

    if (action === 'up') {
      await cb.remote.up();
      console.log(`up: ${route}`);
      return;
    }

    if (action === 'down') {
      const wasUp = await cb.remote.down();
      console.log(wasUp ? 'down' : 'was not running');
      return;
    }

    if (action === 'status') {
      const up = await cb.remote.isUp();
      console.log(up ? `up: ${route}` : 'down');
      return up ? 0 : 1;
    }

    throw new Error(`unknown action "${action}" (use up, down or nothing)`);
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

export const top: Command = {
  name: 'top',
  summary: 'Busiest processes on the Chromebook over one second, Chrome processes labeled by type',
  usage: '[-n 15]',
  details: ['cpu% is per core: 200 means two cores fully busy.'],
  options: { n: { type: 'string', short: 'n' } },

  async run({ cb, json }, _args, values) {
    const { stdout } = await cb.remote.exec(TOP_SCRIPT);
    const rows = parseTop(stdout, num(values, 'n', 15));

    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    console.log(
      table([
        ['pid', 'cpu%', 'mem', 'process'],
        ...rows.map((row) => [row.pid, String(row.cpu), `${row.rssMb}MB`, row.name]),
      ]),
    );
  },
};

export const gpu: Command = {
  name: 'gpu',
  summary: 'Show the GPU and which graphics features are hardware accelerated (like chrome://gpu)',
  usage: '[--all]',
  options: { all: { type: 'boolean', short: 'a' } },

  async run({ cb, json }, _args, values) {
    const browser = await cb.browser();

    try {
      const info = await browser.send<GpuInfo>('SystemInfo.getInfo');

      if (json || flag(values, 'all')) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }

      printGpu(info);
    } finally {
      browser.close();
    }
  },
};

/** The GPU, its driver, the GL backend and the feature status table. */
function printGpu({ gpu }: GpuInfo): void {
  for (const device of gpu.devices) {
    console.log(`gpu      ${device.vendorString || '?'} ${device.deviceString || ''}`.trimEnd());

    if (device.driverVendor || device.driverVersion) {
      console.log(`driver   ${device.driverVendor} ${device.driverVersion}`.trimEnd());
    }
  }

  for (const key of ['glRenderer', 'glVersion', 'glImplementationParts']) {
    const value = gpu.auxAttributes[key];

    if (value !== undefined) {
      console.log(`${key.padEnd(8)} ${String(value)}`);
    }
  }

  console.log('');
  console.log(table(Object.entries(gpu.featureStatus)));

  if (gpu.driverBugWorkarounds.length > 0) {
    console.log(`\n${gpu.driverBugWorkarounds.length} driver workarounds active (--all to list)`);
  }
}
