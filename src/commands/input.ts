import { flag, need, num, withSession } from '../command.ts';
import { parseKey } from '../keys.ts';
import type { Command } from '../types.ts';

/** Reads `<x> <y>` CSS pixel coordinates from the arguments. */
function coords(args: string[]): { x: number; y: number } {
  const x = Number(need(args, 0, 'x'));
  const y = Number(need(args, 1, 'y'));

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('x and y must be numbers (CSS pixels)');
  }

  return { x, y };
}

export const click: Command = {
  name: 'click',
  summary: 'Click at a point in a tab (CSS pixels from the top left)',
  usage: '<x> <y> [-t tab] [--right] [--double]',
  details: ['Input always goes to the tab; Chrome routes it to the frame under the pointer.'],
  options: { right: { type: 'boolean' }, double: { type: 'boolean' } },

  async run(ctx, args, values) {
    const { x, y } = coords(args);
    const button = flag(values, 'right') ? 'right' : 'left';
    const clicks = flag(values, 'double') ? 2 : 1;

    await withSession(ctx, { page: true }, async ({ cdp }) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });

      for (let clickCount = 1; clickCount <= clicks; clickCount++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
      }
    });
  },
};

export const move: Command = {
  name: 'move',
  summary: 'Move the mouse to a point in a tab',
  usage: '<x> <y> [-t tab]',

  async run(ctx, args) {
    const { x, y } = coords(args);

    await withSession(ctx, { page: true }, async ({ cdp }) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    });
  },
};

export const scroll: Command = {
  name: 'scroll',
  summary: 'Scroll the mouse wheel at a point',
  usage: '<x> <y> <dy> [dx] [-t tab]',

  async run(ctx, args) {
    const { x, y } = coords(args);
    const deltaY = Number(need(args, 2, 'dy'));
    const deltaX = Number(args[3] ?? 0);

    await withSession(ctx, { page: true }, async ({ cdp }) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    });
  },
};

export const type: Command = {
  name: 'type',
  summary: 'Type text into whatever has focus',
  usage: '<text> [-t tab]',

  async run(ctx, args) {
    const text = need(args, 0, 'text');

    await withSession(ctx, { page: true }, async ({ cdp }) => {
      await cdp.send('Input.insertText', { text });
    });
  },
};

export const key: Command = {
  name: 'key',
  summary: 'Press a key, optionally holding it (e.g. to move in a game)',
  usage: '<key> [-t tab] [--hold ms] [--repeat n]',
  details: ['Keys: a-z, 0-9, f1-f12, enter, escape, space, tab, backspace, shift, ctrl, alt, up/down/left/right.'],
  options: { hold: { type: 'string' }, repeat: { type: 'string' } },

  async run(ctx, args, values) {
    const spec = parseKey(need(args, 0, 'key'));
    const hold = num(values, 'hold', 0);
    const repeat = Math.max(1, num(values, 'repeat', 1));

    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    };

    const down = {
      ...base,
      type: spec.text ? 'keyDown' : 'rawKeyDown',
      text: spec.text,
      unmodifiedText: spec.text,
    };

    await withSession(ctx, { page: true }, async ({ cdp }) => {
      for (let i = 0; i < repeat; i++) {
        await cdp.send('Input.dispatchKeyEvent', down);

        if (hold > 0) {
          await Bun.sleep(hold);
        }

        await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      }
    });
  },
};
