import type { IndexedTarget, Target } from './types.ts';

/** URL schemes for Chrome's own pages, which are never what the user means by "a tab". */
const HIDDEN_PREFIXES = ['chrome-extension://', 'devtools://', 'chrome-untrusted://'];

/** A tab the user opened, as opposed to an extension page or Chrome internals. */
export function isUserPage(target: Target): boolean {
  if (target.type !== 'page') {
    return false;
  }

  return !HIDDEN_PREFIXES.some((prefix) => target.url.startsWith(prefix));
}

/**
 * Tabs first, then everything else, so a tab keeps the same index whether or not `--all`
 * is passed. Iframes matter: a game or embedded app often renders in a cross-site iframe
 * with its own renderer process, and that is the target to measure.
 */
export function orderTargets(targets: Target[]): Target[] {
  const pages = targets.filter(isUserPage);
  const rest = targets.filter((target) => !isUserPage(target));

  return [...pages, ...rest];
}

/** Targets with their `cb tabs` index; only tabs unless `all` is set. */
export function visibleTargets(targets: Target[], all: boolean): IndexedTarget[] {
  const indexed = orderTargets(targets).map((target, index) => ({ index, target }));

  if (all) {
    return indexed;
  }

  return indexed.filter(({ target }) => isUserPage(target));
}

/**
 * Resolves `-t`: nothing picks the first tab, a number is an index from `cb tabs`, anything
 * else matches an id prefix, then URL or title text (tabs before iframes).
 */
export function resolveTarget(targets: Target[], selector?: string): Target {
  const ordered = orderTargets(targets);

  if (selector === undefined || selector === '') {
    const first = ordered.find(isUserPage);

    if (!first) {
      throw new Error('no tabs are open on the Chromebook (try `cb open <url>`)');
    }

    return first;
  }

  if (/^\d+$/.test(selector)) {
    const byIndex = ordered[Number(selector)];

    if (!byIndex) {
      throw new Error(`no target at index ${selector} (see \`cb tabs --all\`)`);
    }

    return byIndex;
  }

  const needle = selector.toLowerCase();
  const byId = ordered.find((target) => target.id.toLowerCase().startsWith(needle));

  if (byId && needle.length >= 4) {
    return byId;
  }

  const byText = ordered.find((target) => {
    return target.url.toLowerCase().includes(needle) || target.title.toLowerCase().includes(needle);
  });

  if (byText) {
    return byText;
  }

  throw new Error(`nothing matches "${selector}" (see \`cb tabs --all\`)`);
}

/** The tab that hosts a target. Screenshots, video and input only work on tabs. */
export function owningPage(target: Target, all: Target[]): Target {
  const seen = new Set<string>();
  let current = target;

  while (current.type !== 'page' && current.parentId && !seen.has(current.id)) {
    seen.add(current.id);

    const parent = all.find((candidate) => candidate.id === current.parentId);

    if (!parent) {
      break;
    }

    current = parent;
  }

  if (current.type !== 'page') {
    throw new Error(`"${target.title || target.url}" is not inside a tab`);
  }

  return current;
}
