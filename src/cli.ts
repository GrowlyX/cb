#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { Chromebook } from './chromebook.ts';
import type { Command, Options, Values } from './command.ts';
import * as browse from './commands/browse.ts';
import * as capture from './commands/capture.ts';
import * as input from './commands/input.ts';
import * as perf from './commands/perf.ts';
import { CONFIG_FILE, loadConfig } from './config.ts';

const GROUPS: Array<[string, Command[]]> = [
  ['Connection', [browse.status, browse.tunnel, browse.sh, browse.top, browse.gpu]],
  ['Tabs', [browse.tabs, browse.open, browse.nav, browse.reload, browse.focus, browse.close, browse.evaluate, browse.devtools]],
  ['Capture', [capture.shot, capture.record]],
  ['Performance', [perf.fps, perf.metrics, perf.trace]],
  ['Input', [input.click, input.move, input.scroll, input.type, input.key]],
];
const COMMANDS = new Map(GROUPS.flatMap(([, list]) => list.map((c) => [c.name, c] as const)));

const GLOBAL_OPTIONS: Options = {
  target: { type: 'string', short: 't' },
  host: { type: 'string' },
  user: { type: 'string' },
  port: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const GLOBAL_HELP = [
  '  -t, --target <sel>  tab index from `cb tabs`, id prefix, or URL/title text (default: first tab)',
  '      --host <name>   Chromebook SSH host (default: chromebook)',
  '      --user <name>   SSH user (default: root)',
  '      --port <n>      local tunnel port (default: 9333)',
  '      --json          machine-readable output where supported',
];

function usage(): string {
  const width = Math.max(...[...COMMANDS.keys()].map((n) => n.length)) + 2;
  const sections = GROUPS.map(
    ([title, list]) => `${title}:\n${list.map((c) => `  ${c.name.padEnd(width)}${c.summary}`).join('\n')}`,
  );
  return [
    `cb ${pkg.version}: drive a developer-mode Chromebook's Chrome over Tailscale`,
    '',
    'Usage: cb <command> [options]',
    '',
    ...sections.flatMap((s) => [s, '']),
    'Options for every command:',
    ...GLOBAL_HELP,
    '',
    `Config: ${CONFIG_FILE} ({ "host", "user", "remotePort", "localPort" })`,
    'Run `cb help <command>` for details.',
  ].join('\n');
}

function commandHelp(c: Command): string {
  const lines = [`cb ${c.name} ${c.usage}`.trimEnd(), '', c.summary];
  if (c.details?.length) lines.push('', ...c.details);
  lines.push('', 'Options for every command:', ...GLOBAL_HELP);
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === '-h' || name === '--help' || name === 'help') {
    const topic = name === 'help' ? rest[0] : undefined;
    const c = topic ? COMMANDS.get(topic) : undefined;
    if (topic && !c) throw new Error(`unknown command "${topic}"`);
    console.log(c ? commandHelp(c) : usage());
    return 0;
  }
  if (name === '-v' || name === '--version' || name === 'version') {
    console.log(pkg.version);
    return 0;
  }
  const command = COMMANDS.get(name);
  if (!command) throw new Error(`unknown command "${name}" (run \`cb help\`)`);

  // `cb sh` passes everything after it to the Chromebook untouched, flags included.
  const passthrough = command === browse.sh;
  const { values, positionals } = passthrough
    ? { values: {} as Record<string, unknown>, positionals: rest }
    : parseArgs({
        args: rest,
        options: { ...GLOBAL_OPTIONS, ...command.options },
        allowPositionals: true,
        strict: true,
      });
  if (values.help) {
    console.log(commandHelp(command));
    return 0;
  }
  const config = loadConfig({
    host: values.host as string | undefined,
    user: values.user as string | undefined,
    localPort: values.port === undefined ? undefined : Number(values.port),
  });
  const ctx = {
    cb: new Chromebook(config),
    selector: values.target as string | undefined,
    json: values.json === true,
  };
  const code = await command.run(ctx, positionals, values as Values);
  return typeof code === 'number' ? code : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`cb: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
