import type { CdpHandler, CdpMessage, PendingCall } from './types.ts';

/** A DevTools protocol error reply, tagged with the method that failed. */
export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

/** A minimal Chrome DevTools Protocol client over one WebSocket. */
export class Cdp {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Map<string, Set<CdpHandler>>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => this.receive(String(event.data));
    ws.onclose = () => this.failPending();
  }

  /** Opens a session to a DevTools WebSocket URL. */
  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out connecting to ${url}`));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      };

      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${url}`));
      };
    });
  }

  /** Calls a protocol method and resolves with its result. */
  send<T = any>(method: string, params: object = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`${method}: connection closed`));
    }

    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribes to a protocol event. Returns a function that unsubscribes. */
  on(event: string, handler: CdpHandler): () => void {
    let set = this.handlers.get(event);

    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }

    set.add(handler);

    return () => set.delete(handler);
  }

  /** Resolves with the next occurrence of an event. */
  once<T = any>(event: string, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`no ${event} after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      const off = this.on(event, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close(): void {
    if (!this.closed) {
      this.ws.close();
    }
  }

  /** Routes a message to the call waiting for it, or to event subscribers. */
  private receive(raw: string): void {
    const message = JSON.parse(raw) as CdpMessage;

    if (message.id !== undefined) {
      this.settle(message);
      return;
    }

    if (message.method) {
      for (const handler of this.handlers.get(message.method) ?? []) {
        handler(message.params);
      }
    }
  }

  /** Resolves or rejects the call a reply belongs to. */
  private settle(message: CdpMessage): void {
    const call = this.pending.get(message.id!);

    if (!call) {
      return;
    }

    this.pending.delete(message.id!);
    clearTimeout(call.timer);

    if (message.error) {
      call.reject(new CdpError(call.method, message.error.code, message.error.message));
    } else {
      call.resolve(message.result);
    }
  }

  /** Rejects every outstanding call once the socket closes. */
  private failPending(): void {
    this.closed = true;

    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(`${call.method}: connection closed`));
    }

    this.pending.clear();
  }
}
