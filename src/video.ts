import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Frame {
  file: string;
  /** Seconds, from the screencast frame's metadata. */
  timestamp: number;
}

/**
 * An ffmpeg concat list that holds each frame for as long as it was on screen. Screencast
 * frames only arrive when something changes, so a fixed frame rate would speed up or slow
 * down the video.
 */
export function concatList(frames: Frame[], endTimestamp: number): string {
  const lines = ['ffconcat version 1.0'];
  frames.forEach((frame, i) => {
    const next = frames[i + 1]?.timestamp ?? endTimestamp;
    const duration = Math.max(0.001, next - frame.timestamp);
    lines.push(`file '${frame.file.replace(/'/g, "'\\''")}'`, `duration ${duration.toFixed(4)}`);
  });
  // The concat demuxer ignores the last duration unless the last file is listed again.
  const last = frames.at(-1);
  if (last) lines.push(`file '${last.file.replace(/'/g, "'\\''")}'`);
  return `${lines.join('\n')}\n`;
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-version'], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function encode(dir: string, frames: Frame[], endTimestamp: number, output: string): Promise<void> {
  const list = join(dir, 'frames.ffconcat');
  writeFileSync(list, concatList(frames, endTimestamp));
  const proc = Bun.spawn(
    [
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-fps_mode', 'vfr',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      output,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`ffmpeg failed: ${stderr.trim().split('\n').at(-1)}`);
}
