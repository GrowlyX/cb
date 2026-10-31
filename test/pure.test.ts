import { describe, expect, test } from 'bun:test';
import { describeProcess, parseSys, parseTop } from '../src/commands/browse.ts';
import { fpsReport } from '../src/commands/perf.ts';
import { percentile, table } from '../src/format.ts';
import { parseKey } from '../src/keys.ts';
import { concatList } from '../src/video.ts';

describe('parseKey', () => {
  test('letters type text and carry a key code', () => {
    expect(parseKey('w')).toEqual({ key: 'w', code: 'KeyW', keyCode: 87, text: 'w' });
  });
  test('named and function keys', () => {
    expect(parseKey('Enter').code).toBe('Enter');
    expect(parseKey('ArrowUp').key).toBe('ArrowUp');
    expect(parseKey('f3')).toEqual({ key: 'F3', code: 'F3', keyCode: 114 });
    expect(parseKey('space').text).toBe(' ');
  });
  test('rejects unknown names', () => {
    expect(() => parseKey('hyper')).toThrow('unknown key');
  });
});

describe('concatList', () => {
  test('holds each frame until the next and repeats the last', () => {
    const list = concatList(
      [
        { file: 'a.jpg', timestamp: 10 },
        { file: 'b.jpg', timestamp: 10.5 },
      ],
      12,
    );
    expect(list).toBe(
      "ffconcat version 1.0\nfile 'a.jpg'\nduration 0.5000\nfile 'b.jpg'\nduration 1.5000\nfile 'b.jpg'\n",
    );
  });
});

describe('fpsReport', () => {
  test('frame rate and slow frames from rAF intervals', () => {
    const r = fpsReport([16.7, 16.7, 16.6, 50.1, 16.7]);
    expect(r.frames).toBe(5);
    expect(r.fps).toBeCloseTo(5000 / 116.8, 5);
    expect(r.over33).toBe(1);
    expect(r.over50).toBe(1);
    expect(r.max).toBe(50.1);
  });
});

describe('format', () => {
  test('percentile is nearest-rank', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 100)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });
  test('table pads every column but the last', () => {
    expect(table([['a', 'bb', 'c'], ['ccc', 'd', 'eeee']])).toBe('a    bb  c\nccc  d   eeee');
  });
});

describe('system parsing', () => {
  test('parseSys splits on the first =', () => {
    const m = parseSys('load=0.1 0.2 0.3\ntemp.INT3400 Thermal=20000\nbogus\n');
    expect(m.get('load')).toBe('0.1 0.2 0.3');
    expect(m.get('temp.INT3400 Thermal')).toBe('20000');
    expect(m.has('bogus')).toBe(false);
  });
  test('describeProcess labels Chrome processes', () => {
    expect(describeProcess(['/opt/google/chrome/chrome', '--type=renderer', '--extension-process'])).toBe(
      'chrome renderer (extension)',
    );
    expect(describeProcess(['/opt/google/chrome/chrome', '--login-manager'])).toBe('chrome (browser)');
    expect(describeProcess(['/usr/bin/shill', '--log-level=0'])).toBe('/usr/bin/shill --log-level=0');
  });
  test('parseTop turns tick deltas into CPU percent, busiest first', () => {
    const out = [
      '1 100\n2 50\n',
      '1 103\n2 90\n',
      '  1  2048 /sbin/init\n  2 409600 /opt/google/chrome/chrome --type=gpu-process\n',
    ].join('---\n');
    expect(parseTop(out, 5)).toEqual([
      { pid: '2', cpu: 40, rssMb: 400, name: 'chrome gpu-process' },
      { pid: '1', cpu: 3, rssMb: 2, name: '/sbin/init' },
    ]);
  });
});
