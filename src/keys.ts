/** The fields `Input.dispatchKeyEvent` needs for one key. */
export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  /** Set for keys that type a character. */
  text?: string;
}

const NAMED: Record<string, KeySpec> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

/** Parses names like `enter`, `w`, `7`, `f3` or `arrowup` (case-insensitive) into a key. */
export function parseKey(name: string): KeySpec {
  const lower = name.toLowerCase();
  const named = NAMED[lower] ?? NAMED[lower.replace(/^arrow/, '')];
  if (named) return { ...named };

  const fn = /^f([1-9]|1[0-2])$/.exec(lower);
  if (fn) {
    const n = Number(fn[1]);
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
  }
  if (/^[a-z]$/.test(lower)) {
    return { key: name, code: `Key${lower.toUpperCase()}`, keyCode: lower.toUpperCase().charCodeAt(0), text: name };
  }
  if (/^[0-9]$/.test(lower)) {
    return { key: lower, code: `Digit${lower}`, keyCode: lower.charCodeAt(0), text: lower };
  }
  throw new Error(`unknown key "${name}" (try a letter, a digit, f1-f12, enter, escape, space, tab, up/down/left/right)`);
}
