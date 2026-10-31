import type { ParseArgsConfig } from 'node:util';
import type { Cdp } from './cdp.ts';
import type { Chromebook } from './chromebook.ts';
import { resolveTarget, type Target } from './targets.ts';

export type Options = NonNullable<ParseArgsConfig['options']>;
export type Values = Record<string, string | boolean | string[] | boolean[] | undefined>;

export interface Context {
  cb: Chromebook;
  /** The `-t` selector, if one was given. */
  selector?: string;
  json: boolean;
}

export interface Command {
  name: string;
  summary: string;
  /** Usage after `cb <name>`, e.g. `<url>` or `[-o file.png]`. */
  usage: string;
  /** Extra help lines shown by `cb help <name>`. */
  details?: string[];
  options?: Options;
  run(ctx: Context, args: string[], values: Values): Promise<number | void>;
}

export function str(values: Values, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

export function num(values: Values, key: string, fallback: number): number {
  const raw = str(values, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${raw}"`);
  return n;
}

export function flag(values: Values, key: string): boolean {
  return values[key] === true;
}

export function need(args: string[], index: number, name: string): string {
  const v = args[index];
  if (v === undefined) throw new Error(`missing <${name}>`);
  return v;
}

/** The tab that hosts a target: screenshots, video and input only work on tabs, not iframes. */
export function owningPage(target: Target, all: Target[]): Target {
  let current = target;
  const seen = new Set<string>();
  while (current.type !== 'page' && current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = all.find((t) => t.id === current.parentId);
    if (!parent) break;
    current = parent;
  }
  if (current.type !== 'page') throw new Error(`"${target.title || target.url}" is not inside a tab`);
  return current;
}

/** Resolves `-t` and connects. With `page`, an iframe selector is widened to its tab. */
export async function connect(ctx: Context, opts: { page?: boolean } = {}): Promise<{ target: Target; cdp: Cdp }> {
  const all = await ctx.cb.targets();
  let target = resolveTarget(all, ctx.selector);
  if (opts.page) target = owningPage(target, all);
  return { target, cdp: await ctx.cb.attach(target) };
}

/** Resolves after `seconds` (0 means never) or on Ctrl+C, whichever comes first. */
export function untilStopped(seconds: number): Promise<'timeout' | 'interrupt'> {
  return new Promise((resolve) => {
    const onSignal = () => {
      clearTimeout(timer);
      process.off('SIGINT', onSignal);
      // A second Ctrl+C while we finish up exits immediately.
      process.once('SIGINT', () => process.exit(130));
      resolve('interrupt');
    };
    const timer = seconds > 0 ? setTimeout(() => {
      process.off('SIGINT', onSignal);
      resolve('timeout');
    }, seconds * 1000) : undefined;
    process.on('SIGINT', onSignal);
  });
}
