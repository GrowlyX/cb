import type { Cdp } from './cdp.ts';
import { owningPage, resolveTarget } from './targets.ts';
import type { Context, EvaluateResult, Session, StopReason, Values } from './types.ts';

/** A string option's value, if it was given. */
export function str(values: Values, key: string): string | undefined {
  const value = values[key];

  return typeof value === 'string' ? value : undefined;
}

/** A numeric option's value, or `fallback` when it was not given. */
export function num(values: Values, key: string, fallback: number): number {
  const raw = str(values, key);

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    throw new Error(`--${key} must be a number, got "${raw}"`);
  }

  return parsed;
}

/** Whether a boolean option was passed. */
export function flag(values: Values, key: string): boolean {
  return values[key] === true;
}

/** A required positional argument. */
export function need(args: string[], index: number, name: string): string {
  const value = args[index];

  if (value === undefined) {
    throw new Error(`missing <${name}>`);
  }

  return value;
}

/** Resolves `-t` and connects to it. With `page`, an iframe selector is widened to its tab. */
export async function connect(ctx: Context, options: { page?: boolean } = {}): Promise<Session> {
  const all = await ctx.cb.targets();
  let target = resolveTarget(all, ctx.selector);

  if (options.page) {
    target = owningPage(target, all);
  }

  return { target, cdp: await ctx.cb.attach(target) };
}

/** Connects to `-t`, runs `fn`, and always closes the session. */
export async function withSession<T>(
  ctx: Context,
  options: { page?: boolean },
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await connect(ctx, options);

  try {
    return await fn(session);
  } finally {
    session.cdp.close();
  }
}

/**
 * Resolves after `seconds` (0 means never) or on Ctrl+C, whichever comes first. A second
 * Ctrl+C while the command finishes up exits immediately.
 */
export function untilStopped(seconds: number): Promise<StopReason> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onSignal = () => {
      clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.once('SIGINT', () => process.exit(130));
      resolve('interrupt');
    };

    if (seconds > 0) {
      timer = setTimeout(() => {
        process.off('SIGINT', onSignal);
        resolve('timeout');
      }, seconds * 1000);
    }

    process.on('SIGINT', onSignal);
  });
}

/**
 * Runs JavaScript in a session's page and returns its value. Promises are awaited, and a
 * thrown exception becomes an error with the page's message.
 */
export async function evaluate<T>(cdp: Cdp, expression: string, timeoutMs = 30_000): Promise<T> {
  const { result, exceptionDetails } = await cdp.send<EvaluateResult<T>>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    timeoutMs,
  );

  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }

  if ('value' in result) {
    return result.value as T;
  }

  return result.description as T;
}

/** Writes a progress line to stderr so stdout stays clean for piping. */
export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}
