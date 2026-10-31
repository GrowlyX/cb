import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, type Config } from './config.ts';

/**
 * One long-lived SSH master connection per Chromebook. It carries the DevTools port forward
 * and every `cb sh` / system query, so only the first command pays for the handshake (and any
 * Tailscale SSH "check" prompt). It stays up until `cb tunnel down` or the Chromebook drops off.
 */
export class Remote {
  readonly socket: string;

  constructor(private readonly config: Config) {
    this.socket = join(CACHE_DIR, `${config.host}.sock`);
  }

  get destination(): string {
    return `${this.config.user}@${this.config.host}`;
  }

  private base(): string[] {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-S', this.socket,
    ];
  }

  async isUp(): Promise<boolean> {
    const proc = Bun.spawn(['ssh', ...this.base(), '-O', 'check', this.destination], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return (await proc.exited) === 0;
  }

  private starting?: Promise<void>;

  /** Starts the master and the port forward if they are not already running. */
  up(): Promise<void> {
    // Commands fire several requests at once; they must share one start, not race to bind the port.
    this.starting ??= this.start().catch((error) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (await this.isUp()) return;
    mkdirSync(CACHE_DIR, { recursive: true });
    const { localPort, remotePort } = this.config;
    // stderr stays attached so a Tailscale SSH "visit this URL" check is visible to the user.
    const proc = Bun.spawn(
      [
        'ssh', ...this.base(),
        '-M', '-f', '-N',
        '-o', 'ControlPersist=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        this.destination,
      ],
      { stdout: 'ignore', stderr: 'inherit', stdin: 'ignore' },
    );
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(
        `could not reach ${this.destination} over SSH (exit ${code}). ` +
          `Is the Chromebook online in \`tailscale status\`, and is port ${localPort} free here?`,
      );
    }
  }

  async down(): Promise<boolean> {
    this.starting = undefined;
    if (!(await this.isUp())) return false;
    const proc = Bun.spawn(['ssh', ...this.base(), '-O', 'exit', this.destination], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await proc.exited;
    return true;
  }

  /** Runs a shell command on the Chromebook as the configured user and returns its output. */
  async exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    await this.up();
    const proc = Bun.spawn(['ssh', ...this.base(), this.destination, command], {
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

  /** Hands the terminal to SSH: an interactive shell, or a command with live output. */
  async attach(command: string[]): Promise<number> {
    await this.up();
    const tty = command.length === 0 ? ['-t'] : [];
    const proc = Bun.spawn(['ssh', ...this.base(), ...tty, this.destination, ...command], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    return proc.exited;
  }
}
