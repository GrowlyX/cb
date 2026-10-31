import { evaluate, flag, need, withSession } from '../command.ts';
import { table, truncate } from '../format.ts';
import { resolveTarget, visibleTargets } from '../targets.ts';
import type { Command, Context, Target } from '../types.ts';

/** Runs a browser-level `Target.*` method on the `-t` target. */
async function onTarget(ctx: Context, method: string): Promise<void> {
  const target = resolveTarget(await ctx.cb.targets(), ctx.selector);
  const browser = await ctx.cb.browser();

  try {
    await browser.send(method, { targetId: target.id });
  } finally {
    browser.close();
  }
}

/** A target's title, unless it only repeats the URL (as iframe titles do). */
function displayTitle(target: Target): string {
  if (target.title === target.url) {
    return '';
  }

  return target.title;
}

export const tabs: Command = {
  name: 'tabs',
  summary: 'List open tabs (with --all, iframes, workers and extensions too)',
  usage: '[--all]',
  details: ['The number in the first column works as `-t <n>` in every other command.'],
  options: { all: { type: 'boolean', short: 'a' } },

  async run({ cb, json }, _args, values) {
    const rows = visibleTargets(await cb.targets(), flag(values, 'all'));

    if (json) {
      const flat = rows.map(({ index, target }) => ({ index, ...target }));
      console.log(JSON.stringify(flat, null, 2));
      return;
    }

    if (rows.length === 0) {
      console.log('no tabs open');
      return;
    }

    const lines = rows.map(({ index, target }) => [
      String(index),
      target.id.slice(0, 8),
      target.type,
      truncate(displayTitle(target), 40),
      truncate(target.url, 70),
    ]);

    console.log(table([['#', 'id', 'type', 'title', 'url'], ...lines]));
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

    await withSession(ctx, { page: true }, async ({ cdp }) => {
      const result = await cdp.send<{ errorText?: string }>('Page.navigate', { url });

      if (result.errorText) {
        throw new Error(`navigation failed: ${result.errorText}`);
      }
    });
  },
};

export const reload: Command = {
  name: 'reload',
  summary: 'Reload a tab',
  usage: '[-t tab] [--hard]',
  options: { hard: { type: 'boolean' } },

  async run(ctx, _args, values) {
    await withSession(ctx, { page: true }, async ({ cdp }) => {
      await cdp.send('Page.reload', { ignoreCache: flag(values, 'hard') });
    });
  },
};

export const focus: Command = {
  name: 'focus',
  summary: 'Bring a tab to the front',
  usage: '[-t tab]',

  async run(ctx) {
    await onTarget(ctx, 'Target.activateTarget');
  },
};

export const close: Command = {
  name: 'close',
  summary: 'Close a tab',
  usage: '-t tab',

  async run(ctx) {
    if (!ctx.selector) {
      throw new Error('pass -t to say which tab to close');
    }

    await onTarget(ctx, 'Target.closeTarget');
  },
};

export const evalCommand: Command = {
  name: 'eval',
  summary: 'Run JavaScript in a tab or iframe and print the result',
  usage: '<expression> [-t target]',
  details: ['Promises are awaited. Use -t with an iframe to run inside it.'],

  async run(ctx, args) {
    const expression = need(args, 0, 'expression');

    await withSession(ctx, {}, async ({ cdp }) => {
      const value = await evaluate<unknown>(cdp, expression);

      if (typeof value === 'string') {
        console.log(value);
      } else {
        console.log(JSON.stringify(value, null, 2));
      }
    });
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
