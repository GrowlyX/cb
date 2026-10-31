import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame } from './types.ts';

/** Quotes a path for an ffconcat `file` line. */
function quote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * An ffmpeg concat list that holds each frame for as long as it was on screen. Screencast
 * frames only arrive when something changes, so a fixed frame rate would distort time. The
 * last file is listed twice because the concat demuxer ignores the final duration otherwise.
 */
export function concatList(frames: Frame[], endTimestamp: number): string {
  const lines = ['ffconcat version 1.0'];

  frames.forEach((frame, i) => {
    const next = frames[i + 1]?.timestamp ?? endTimestamp;
    const duration = Math.max(0.001, next - frame.timestamp);

    lines.push(`file ${quote(frame.file)}`);
    lines.push(`duration ${duration.toFixed(4)}`);
  });

  const last = frames.at(-1);

  if (last) {
    lines.push(`file ${quote(last.file)}`);
  }

  return `${lines.join('\n')}\n`;
}

/** Whether ffmpeg is installed on this machine. */
export async function hasFfmpeg(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-version'], { stdout: 'ignore', stderr: 'ignore' });

    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Encodes saved frames into an H.264 MP4 with their real timing. */
export async function encode(dir: string, frames: Frame[], endTimestamp: number, output: string): Promise<void> {
  const list = join(dir, 'frames.ffconcat');
  writeFileSync(list, concatList(frames, endTimestamp));

  const args = [
    ['-hide_banner'],
    ['-loglevel', 'error'],
    ['-y'],
    ['-f', 'concat'],
    ['-safe', '0'],
    ['-i', list],
    ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'],
    ['-fps_mode', 'vfr'],
    ['-c:v', 'libx264'],
    ['-preset', 'veryfast'],
    ['-crf', '23'],
    ['-pix_fmt', 'yuv420p'],
    ['-movflags', '+faststart'],
  ].flat();

  const proc = Bun.spawn(['ffmpeg', ...args, output], { stdout: 'ignore', stderr: 'pipe' });

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  if (code !== 0) {
    throw new Error(`ffmpeg failed: ${stderr.trim().split('\n').at(-1)}`);
  }
}
