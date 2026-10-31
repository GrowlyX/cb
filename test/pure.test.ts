import { describe, expect, test } from 'bun:test';
import { mean, orDash, percentile, table } from '../src/format.ts';
import { fpsReport } from '../src/frames.ts';
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
    const frames = [
      { file: 'a.jpg', timestamp: 10 },
      { file: 'b.jpg', timestamp: 10.5 },
    ];

    expect(concatList(frames, 12)).toBe(
      "ffconcat version 1.0\nfile 'a.jpg'\nduration 0.5000\nfile 'b.jpg'\nduration 1.5000\nfile 'b.jpg'\n",
    );
  });
});

describe('fpsReport', () => {
  test('frame rate and slow frames from rAF intervals', () => {
    const report = fpsReport([16.7, 16.7, 16.6, 50.1, 16.7]);

    expect(report.frames).toBe(5);
    expect(report.fps).toBeCloseTo(5000 / 116.8, 5);
    expect(report.over33).toBe(1);
    expect(report.over50).toBe(1);
    expect(report.max).toBe(50.1);
  });

  test('no frames is zero, not NaN', () => {
    expect(fpsReport([]).fps).toBe(0);
  });
});

describe('format', () => {
  test('percentile is nearest-rank', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 100)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });

  test('mean of nothing is zero', () => {
    expect(mean([2, 4])).toBe(3);
    expect(mean([])).toBe(0);
  });

  test('table pads every column but the last', () => {
    expect(
      table([
        ['a', 'bb', 'c'],
        ['ccc', 'd', 'eeee'],
      ]),
    ).toBe('a    bb  c\nccc  d   eeee');
  });

  test('orDash renders missing values as a dash', () => {
    expect(orDash(undefined, String)).toBe('-');
    expect(orDash(3, (v) => `${v}x`)).toBe('3x');
  });
});
