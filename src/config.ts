import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './types.ts';

/** Used for anything neither the config file nor a flag sets. Local port 9333 never collides with a local Chrome. */
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
  const merged: Config = {
    ...DEFAULTS,
    ...readConfigFile(),
    ...withoutUndefined(overrides),
  };

  for (const key of ['remotePort', 'localPort'] as const) {
    const port = merged[key];

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${key} must be a port number, got ${port}`);
    }
  }

  return merged;
}

/** The config file's contents, or nothing when there is no file. */
function readConfigFile(): Partial<Config> {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Drops unset keys so they don't override earlier layers. */
function withoutUndefined<T extends object>(value: T): Partial<T> {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);

  return Object.fromEntries(entries) as Partial<T>;
}
