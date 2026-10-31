import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** SSH host for the Chromebook, usually its Tailscale name. */
  host: string;
  /** SSH user. Root, so `cb sh` can read power and thermal state. */
  user: string;
  /** Port Chrome's DevTools listens on, on the Chromebook (`--remote-debugging-port`). */
  remotePort: number;
  /** Port the tunnel listens on, on this machine. Not 9222, so it never collides with a local Chrome. */
  localPort: number;
}

export const DEFAULTS: Config = {
  host: 'chromebook',
  user: 'root',
  remotePort: 9222,
  localPort: 9333,
};

export const CONFIG_DIR = join(homedir(), '.config', 'cb');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const CACHE_DIR = join(homedir(), '.cache', 'cb');

/** Defaults, then `~/.config/cb/config.json`, then command-line flags. */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  let fromFile: Partial<Config> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    } catch (error) {
      throw new Error(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
    }
  }
  const merged = { ...DEFAULTS, ...fromFile, ...stripUndefined(overrides) };
  for (const key of ['remotePort', 'localPort'] as const) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1 || merged[key] > 65535) {
      throw new Error(`${key} must be a port number, got ${merged[key]}`);
    }
  }
  return merged;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
