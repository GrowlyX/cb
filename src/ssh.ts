import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from './config.ts';
import type { Config, ExecResult } from './types.ts';

/** `-o` settings for every ssh call: never prompt, and notice a dead connection within about 45 seconds. */
const SSH_OPTIONS = [
  'BatchMode=yes',
  'ConnectTimeout=15',
  'ServerAliveInterval=15',
  'ServerAliveCountMax=3',
  'StrictHostKeyChecking=accept-new',
];

/** `-o` settings for the master: keep running in the background, and fail if the port forward can't bind. */
const MASTER_OPTIONS = ['ControlPersist=yes', 'ExitOnForwardFailure=yes'];

/**
 * One long-lived SSH master connection per Chromebook. It carries the DevTools port forward
 * and every remote command, so only the first `cb` call pays for the handshake (and any
 * Tailscale SSH "check" prompt). It stays up until `cb tunnel down` or the Chromebook drops off.
 */
export class Remote {
  readonly socket: string;

  private starting?: Promise<void>;

  constructor(private readonly config: Config) {
    this.socket = join(CACHE_DIR, `${config.host}.sock`);
  }

  /** `user@host` for ssh. */
  get destination(): string {
    return `${this.config.user}@${this.config.host}`;
  }

  /** Whether the master connection is running. */
  async isUp(): Promise<boolean> {
    const proc = Bun.spawn(['ssh', ...this.baseArgs(), '-O', 'check', this.destination], {
      stdout: 'ignore',
      stderr: 'ignore',
    });

    return (await proc.exited) === 0;
  }

  /**
   * Starts the master and the port forward unless they are already running. Concurrent
   * callers share one start, so parallel requests never race to bind the port.
   */
  up(): Promise<void> {
    this.starting ??= this.start().catch((error) => {
      this.starting = undefined;
      throw error;
    });

    return this.starting;
  }

  /** Closes the master connection. Returns false when it was not running. */
  async down(): Promise<boolean> {
    this.starting = undefined;

    if (!(await this.isUp())) {
      return false;
    }

    const proc = Bun.spawn(['ssh', ...this.baseArgs(), '-O', 'exit', this.destination], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await proc.exited;

    return true;
  }

  /** Runs a shell command on the Chromebook and collects its output. */
  async exec(command: string): Promise<ExecResult> {
    await this.up();

    const proc = Bun.spawn(['ssh', ...this.baseArgs(), this.destination, command], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, code };
  }

  /**
   * Runs a long-lived command on the Chromebook and calls `onLine` for each line it prints.
   * Returns a function that stops it.
   */
  async stream(command: string, onLine: (line: string) => void): Promise<() => void> {
    await this.up();

    const proc = Bun.spawn(['ssh', ...this.baseArgs(), this.destination, command], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    });

    void this.readLines(proc.stdout, onLine);

    return () => proc.kill();
  }

  /** Hands the terminal to SSH: an interactive shell, or a command with live output. */
  async attach(command: string[]): Promise<number> {
    await this.up();

    const tty = command.length === 0 ? ['-t'] : [];
    const proc = Bun.spawn(['ssh', ...this.baseArgs(), ...tty, this.destination, ...command], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });

    return proc.exited;
  }

  /** Options shared by every ssh invocation, including the control socket. */
  private baseArgs(): string[] {
    const options = SSH_OPTIONS.flatMap((option) => ['-o', option]);

    return [...options, '-S', this.socket];
  }

  /**
   * Starts the master in the background with the DevTools forward. stderr stays attached so
   * a Tailscale SSH "visit this URL" check is visible to the user.
   */
  private async start(): Promise<void> {
    if (await this.isUp()) {
      return;
    }

    mkdirSync(CACHE_DIR, { recursive: true });

    const { localPort, remotePort } = this.config;
    const forward = `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`;
    const master = MASTER_OPTIONS.flatMap((option) => ['-o', option]);

    const proc = Bun.spawn(['ssh', ...this.baseArgs(), '-M', '-f', '-N', ...master, '-L', forward, this.destination], {
      stdout: 'ignore',
      stderr: 'inherit',
      stdin: 'ignore',
    });

    const code = await proc.exited;

    if (code !== 0) {
      throw new Error(
        `could not reach ${this.destination} over SSH (exit ${code}). ` +
          `Is the Chromebook online in \`tailscale status\`, and is port ${localPort} free here?`,
      );
    }
  }

  /** Splits a byte stream into lines. */
  private async readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = '';

    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });

      let newline = buffered.indexOf('\n');

      while (newline >= 0) {
        onLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    }
  }
}
