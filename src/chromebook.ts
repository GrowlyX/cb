import { Cdp } from './cdp.ts';
import type { Config } from './config.ts';
import { Remote } from './ssh.ts';
import { resolveTarget, type Target } from './targets.ts';

export interface BrowserVersion {
  Browser: string;
  'Protocol-Version': string;
  'User-Agent': string;
  'V8-Version': string;
  webSocketDebuggerUrl: string;
}

/** The Chromebook: its SSH connection plus Chrome's DevTools endpoint through the tunnel. */
export class Chromebook {
  readonly remote: Remote;

  constructor(readonly config: Config) {
    this.remote = new Remote(config);
  }

  private get http(): string {
    return `http://127.0.0.1:${this.config.localPort}`;
  }

  /** Points a DevTools WebSocket URL (which names the Chromebook's own port) at the tunnel. */
  tunnelUrl(wsUrl: string): string {
    const url = new URL(wsUrl);
    url.hostname = '127.0.0.1';
    url.port = String(this.config.localPort);
    return url.toString();
  }

  private async getJson<T>(path: string): Promise<T> {
    await this.remote.up();
    let lastError: unknown;
    // The forward can take a moment to accept connections right after the master starts.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${this.http}${path}`, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
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

  version(): Promise<BrowserVersion> {
    return this.getJson<BrowserVersion>('/json/version');
  }

  targets(): Promise<Target[]> {
    return this.getJson<Target[]>('/json/list');
  }

  async target(selector?: string): Promise<Target> {
    return resolveTarget(await this.targets(), selector);
  }

  async browser(): Promise<Cdp> {
    const { webSocketDebuggerUrl } = await this.version();
    return Cdp.connect(this.tunnelUrl(webSocketDebuggerUrl));
  }

  /** Opens a DevTools session to a tab or iframe. */
  async attach(target: Target): Promise<Cdp> {
    const ws = target.webSocketDebuggerUrl ?? `ws://127.0.0.1/devtools/page/${target.id}`;
    return Cdp.connect(this.tunnelUrl(ws));
  }

  /** The Chrome DevTools UI for a target, served by the Chromebook's Chrome, for a local browser. */
  inspectorUrl(target: Target): string {
    const host = `127.0.0.1:${this.config.localPort}`;
    return `${this.http}/devtools/inspector.html?ws=${host}/devtools/page/${target.id}`;
  }
}
