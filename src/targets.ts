/** A row from Chrome's `/json/list`. */
export interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  parentId?: string;
  webSocketDebuggerUrl?: string;
}

const HIDDEN_PREFIXES = ['chrome-extension://', 'devtools://', 'chrome-untrusted://'];

function isUserPage(t: Target): boolean {
  return t.type === 'page' && !HIDDEN_PREFIXES.some((p) => t.url.startsWith(p));
}

/**
 * Tabs first, then everything else, so a tab keeps the same index whether or not `--all`
 * is passed. Iframes matter here: a game often renders in a cross-site iframe with its own
 * renderer process, and that is the target to measure.
 */
export function orderTargets(targets: Target[]): Target[] {
  const pages = targets.filter(isUserPage);
  const rest = targets.filter((t) => !isUserPage(t));
  return [...pages, ...rest];
}

export function visibleTargets(targets: Target[], all: boolean): Array<{ index: number; target: Target }> {
  return orderTargets(targets)
    .map((target, index) => ({ index, target }))
    .filter(({ target }) => all || isUserPage(target));
}

/**
 * Resolves `-t`: nothing picks the first tab, a number is an index from `cb tabs`,
 * anything else matches an id prefix, then a URL or title substring (tabs before iframes).
 */
export function resolveTarget(targets: Target[], selector?: string): Target {
  const ordered = orderTargets(targets);
  if (selector === undefined || selector === '') {
    const first = ordered.find(isUserPage);
    if (!first) throw new Error('no tabs are open on the Chromebook (try `cb open <url>`)');
    return first;
  }
  if (/^\d+$/.test(selector)) {
    const byIndex = ordered[Number(selector)];
    if (!byIndex) throw new Error(`no target at index ${selector} (see \`cb tabs --all\`)`);
    return byIndex;
  }
  const needle = selector.toLowerCase();
  const byId = ordered.find((t) => t.id.toLowerCase().startsWith(needle));
  if (byId && needle.length >= 4) return byId;
  const bySubstring = ordered.find(
    (t) => t.url.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle),
  );
  if (bySubstring) return bySubstring;
  throw new Error(`nothing matches "${selector}" (see \`cb tabs --all\`)`);
}
