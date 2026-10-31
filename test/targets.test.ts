import { describe, expect, test } from 'bun:test';
import { owningPage, resolveTarget, visibleTargets } from '../src/targets.ts';
import type { Target } from '../src/types.ts';

/** Builds a target row; the title defaults to the URL, as Chrome does for iframes. */
function t(id: string, type: string, url: string, title = url, parentId?: string): Target {
  return { id, type, url, title, parentId };
}

const TARGETS: Target[] = [
  t('EXT00001', 'page', 'chrome-extension://abc/offscreen.html'),
  t('IFRAME01', 'iframe', 'https://game.example/host', 'game', 'PAGE0001'),
  t('PAGE0001', 'page', 'https://example.com/play', 'Play'),
  t('PAGE0002', 'page', 'https://news.example/', 'News'),
];

describe('visibleTargets', () => {
  test('tabs keep their index with and without --all', () => {
    const tabs = visibleTargets(TARGETS, false);
    const all = visibleTargets(TARGETS, true);
    expect(tabs.map((r) => [r.index, r.target.id])).toEqual([
      [0, 'PAGE0001'],
      [1, 'PAGE0002'],
    ]);
    expect(all.slice(0, 2)).toEqual(tabs);
    expect(all).toHaveLength(4);
  });
});

describe('resolveTarget', () => {
  test('defaults to the first real tab, skipping extensions', () => {
    expect(resolveTarget(TARGETS).id).toBe('PAGE0001');
  });

  test('accepts an index from `cb tabs`', () => {
    expect(resolveTarget(TARGETS, '1').id).toBe('PAGE0002');
  });

  test('accepts an id prefix', () => {
    expect(resolveTarget(TARGETS, 'iframe').id).toBe('IFRAME01');
  });

  test('matches URL or title text, tabs first', () => {
    expect(resolveTarget(TARGETS, 'news').id).toBe('PAGE0002');
    expect(resolveTarget(TARGETS, 'game.example').id).toBe('IFRAME01');
  });

  test('explains a miss', () => {
    expect(() => resolveTarget(TARGETS, 'nope')).toThrow('nothing matches "nope"');
    expect(() => resolveTarget(TARGETS, '9')).toThrow('no target at index 9');
    expect(() => resolveTarget([TARGETS[0]!])).toThrow('no tabs are open');
  });
});

describe('owningPage', () => {
  test('walks an iframe up to its tab', () => {
    expect(owningPage(TARGETS[1]!, TARGETS).id).toBe('PAGE0001');
  });

  test('leaves a tab alone', () => {
    expect(owningPage(TARGETS[3]!, TARGETS).id).toBe('PAGE0002');
  });
});
