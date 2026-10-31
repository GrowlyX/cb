#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { Chromebook } from './chromebook.ts';
import * as capture from './commands/capture.ts';
import * as connection from './commands/connection.ts';
import * as input from './commands/input.ts';
import { monitor } from './commands/monitor.ts';
import * as perf from './commands/perf.ts';
import * as tabs from './commands/tabs.ts';
import { CONFIG_FILE, loadConfig } from './config.ts';
import type { Command, Context, Options, Values } from './types.ts';

/** Commands in the order and groups `cb help` lists them. */
const GROUPS: Array<[string, Command[]]> = [
  ['Connection', [connection.status, connection.tunnel, connection.sh, connection.top, connection.gpu]],
  ['Tabs', [tabs.tabs, tabs.open, tabs.nav, tabs.reload, tabs.focus, tabs.close, tabs.evalCommand, tabs.devtools]],
  ['Capture', [capture.shot, capture.record]],
  ['Performance', [monitor, perf.fps, perf.metrics, perf.profile, perf.trace, perf.vitals]],
  ['Input', [input.click, input.move, input.scroll, input.type, input.key]],
];

const COMMANDS = new Map(GROUPS.flatMap(([, list]) => list.map((command) => [command.name, command] as const)));

/** Options every command accepts. */
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

/** The full command list. */
function usage(): string {
  const width = Math.max(...[...COMMANDS.keys()].map((name) => name.length)) + 2;
  const lines = [
    `cb ${pkg.version}: drive a developer-mode Chromebook's Chrome over Tailscale`,
    '',
    'Usage: cb <command> [options]',
    '',
  ];

  for (const [title, list] of GROUPS) {
    lines.push(`${title}:`);

    for (const command of list) {
      lines.push(`  ${command.name.padEnd(width)}${command.summary}`);
    }

    lines.push('');
  }

  lines.push('Options for every command:', ...GLOBAL_HELP, '');
  lines.push(`Config: ${CONFIG_FILE} ({ "host", "user", "remotePort", "localPort" })`);
  lines.push('Run `cb help <command>` for details.');

  return lines.join('\n');
}

/** Usage, summary and details for one command. */
function commandHelp(command: Command): string {
  const lines = [`cb ${command.name} ${command.usage}`.trimEnd(), '', command.summary];

  if (command.details && command.details.length > 0) {
    lines.push('', ...command.details);
  }

  lines.push('', 'Options for every command:', ...GLOBAL_HELP);

  return lines.join('\n');
}

/** Prints general help, or one command's help for `cb help <name>`. */
function printHelp(topic?: string): void {
  if (!topic) {
    console.log(usage());
    return;
  }

  const command = COMMANDS.get(topic);

  if (!command) {
    throw new Error(`unknown command "${topic}"`);
  }

  console.log(commandHelp(command));
}

/**
 * Parses a command's arguments. `cb sh` is passed through untouched, flags included,
 * so they reach the command on the Chromebook.
 */
function parseCommandArgs(command: Command, args: string[]): { values: Values; positionals: string[] } {
  if (command === connection.sh) {
    return { values: {}, positionals: args };
  }

  const parsed = parseArgs({
    args,
    options: { ...GLOBAL_OPTIONS, ...command.options },
    allowPositionals: true,
    strict: true,
  });

  return { values: parsed.values as Values, positionals: parsed.positionals };
}

/** Builds the shared context from global options and the config file. */
function createContext(values: Values): Context {
  const port = values.port;

  const config = loadConfig({
    host: typeof values.host === 'string' ? values.host : undefined,
    user: typeof values.user === 'string' ? values.user : undefined,
    localPort: typeof port === 'string' ? Number(port) : undefined,
  });

  return {
    cb: new Chromebook(config),
    selector: typeof values.target === 'string' ? values.target : undefined,
    json: values.json === true,
  };
}

/** Runs one invocation and returns its exit code. */
async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (!name || name === '-h' || name === '--help') {
    printHelp();
    return 0;
  }

  if (name === 'help') {
    printHelp(rest[0]);
    return 0;
  }

  if (name === '-v' || name === '--version' || name === 'version') {
    console.log(pkg.version);
    return 0;
  }

  const command = COMMANDS.get(name);

  if (!command) {
    throw new Error(`unknown command "${name}" (run \`cb help\`)`);
  }

  const { values, positionals } = parseCommandArgs(command, rest);

  if (values.help === true) {
    console.log(commandHelp(command));
    return 0;
  }

  const code = await command.run(createContext(values), positionals, values);

  return typeof code === 'number' ? code : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`cb: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
