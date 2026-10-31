import { Cdp } from './cdp.ts';
import { Remote } from './ssh.ts';
import { resolveTarget } from './targets.ts';
import type { BrowserVersion, Config, Target } from './types.ts';

/** How many times to retry the DevTools HTTP endpoint while a fresh tunnel comes up. */
const HTTP_ATTEMPTS = 5;

/** The Chromebook: its SSH connection, plus Chrome's DevTools endpoint through the tunnel. */
export class Chromebook {
  readonly remote: Remote;

  constructor(readonly config: Config) {
    this.remote = new Remote(config);
  }

  /** Chrome's version and browser-level WebSocket URL. */
  version(): Promise<BrowserVersion> {
    return this.getJson<BrowserVersion>('/json/version');
  }

  /** Every tab, iframe, worker and extension page Chrome knows about. */
  targets(): Promise<Target[]> {
    return this.getJson<Target[]>('/json/list');
  }

  /** Resolves a `-t` selector against the current targets. */
  async target(selector?: string): Promise<Target> {
    return resolveTarget(await this.targets(), selector);
  }

  /** Opens a browser-level DevTools session (tabs, tracing, system info). */
  async browser(): Promise<Cdp> {
    const { webSocketDebuggerUrl } = await this.version();

    return Cdp.connect(this.tunnelUrl(webSocketDebuggerUrl));
  }

  /** Opens a DevTools session to one tab or iframe. */
  attach(target: Target): Promise<Cdp> {
    const ws = target.webSocketDebuggerUrl ?? `ws://127.0.0.1/devtools/page/${target.id}`;

    return Cdp.connect(this.tunnelUrl(ws));
  }

  /** The DevTools UI the Chromebook's Chrome serves for a target, to open in a local browser. */
  inspectorUrl(target: Target): string {
    const host = `127.0.0.1:${this.config.localPort}`;

    return `http://${host}/devtools/inspector.html?ws=${host}/devtools/page/${target.id}`;
  }

  /** Points a DevTools WebSocket URL, which names the Chromebook's own port, at the tunnel. */
  tunnelUrl(wsUrl: string): string {
    const url = new URL(wsUrl);
    url.hostname = '127.0.0.1';
    url.port = String(this.config.localPort);

    return url.toString();
  }

  /** Fetches a DevTools HTTP endpoint through the tunnel, retrying while the forward starts. */
  private async getJson<T>(path: string): Promise<T> {
    await this.remote.up();

    let lastError: unknown;

    for (let attempt = 0; attempt < HTTP_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.config.localPort}${path}`, {
          signal: AbortSignal.timeout(8_000),
        });

        if (!res.ok) {
          throw new Error(`${path} returned HTTP ${res.status}`);
        }

        return (await res.json()) as T;
      } catch (error) {
        lastError = error;
        await Bun.sleep(300 * (attempt + 1));
      }
    }

    throw new Error(
      `Chrome's DevTools port is not answering through the tunnel (${(lastError as Error).message}). ` +
        `Check that /etc/chrome_dev.conf has --remote-debugging-port=${this.config.remotePort} ` +
        'and Chrome was restarted (`restart ui`).',
    );
  }
}
