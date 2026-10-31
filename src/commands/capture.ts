import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Cdp } from '../cdp.ts';
import { flag, note, num, str, untilStopped, withSession } from '../command.ts';
import { CACHE_DIR } from '../config.ts';
import { timestamp } from '../format.ts';
import type { Command, Frame, ScreencastCapture, ScreencastFrame, Values } from '../types.ts';
import { encode, hasFfmpeg } from '../video.ts';

/** Shown when Chrome produces no pixels: it stops painting with the screen off or the tab hidden. */
const NO_PAINT_HINT =
  'Chrome is not painting this tab. Is the lid open and the screen on, and is the tab in front (`cb focus`)?';

export const shot: Command = {
  name: 'shot',
  summary: 'Screenshot a tab',
  usage: '[-t tab] [-o file.png] [--full] [--jpeg [--quality 80]]',
  details: [
    'An iframe selector captures the tab it is in.',
    '--full captures the whole page, not just the visible part.',
  ],
  options: {
    out: { type: 'string', short: 'o' },
    full: { type: 'boolean' },
    jpeg: { type: 'boolean' },
    quality: { type: 'string' },
  },

  async run(ctx, _args, values) {
    const requested = str(values, 'out');
    const jpeg = flag(values, 'jpeg') || /\.jpe?g$/i.test(requested ?? '');
    const out = resolve(requested ?? `cb-shot-${timestamp()}.${jpeg ? 'jpg' : 'png'}`);

    await withSession(ctx, { page: true }, async ({ cdp }) => {
      const data = await captureScreenshot(cdp, jpeg, values);

      writeFileSync(out, Buffer.from(data, 'base64'));
      console.log(out);
    });
  },
};

/** Captures the tab, turning a silent timeout into an explanation. */
async function captureScreenshot(cdp: Cdp, jpeg: boolean, values: Values): Promise<string> {
  const params = {
    format: jpeg ? 'jpeg' : 'png',
    quality: jpeg ? num(values, 'quality', 80) : undefined,
    captureBeyondViewport: flag(values, 'full'),
  };

  try {
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', params, 20_000);
    return data;
  } catch (error) {
    const message = (error as Error).message;
    throw new Error(message.includes('no reply') ? NO_PAINT_HINT : message);
  }
}

export const record: Command = {
  name: 'record',
  summary: 'Record a tab to an MP4 (Ctrl+C stops early)',
  usage: '[-t tab] [-d seconds] [-o file.mp4] [--quality 70] [--max-width 1280] [--keep-frames]',
  details: [
    'Uses Chrome screencast frames, encoded here with ffmpeg. -d 0 records until Ctrl+C.',
    'Capturing costs the Chromebook CPU, so record and measure performance separately.',
    'The capture rate it prints is how fast frames arrived, not the page frame rate: use `cb fps`.',
  ],
  options: {
    duration: { type: 'string', short: 'd' },
    out: { type: 'string', short: 'o' },
    quality: { type: 'string' },
    'max-width': { type: 'string' },
    'max-height': { type: 'string' },
    'keep-frames': { type: 'boolean' },
  },

  async run(ctx, _args, values) {
    const seconds = num(values, 'duration', 10);
    const out = resolve(str(values, 'out') ?? `cb-record-${timestamp()}.mp4`);
    const ffmpeg = await hasFfmpeg();

    mkdirSync(CACHE_DIR, { recursive: true });
    const dir = mkdtempSync(join(CACHE_DIR, 'record-'));

    const capture = await withSession(ctx, { page: true }, async ({ target, cdp }) => {
      note(`recording "${target.title || target.url}"${seconds > 0 ? ` for ${seconds}s` : ''}, Ctrl+C to stop`);

      return screencast(cdp, dir, seconds, values);
    });

    if (capture.frames.length === 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`no frames arrived. ${NO_PAINT_HINT}`);
    }

    const rate = capture.elapsed > 0 ? capture.frames.length / capture.elapsed : 0;
    note(`${capture.frames.length} frames over ${capture.elapsed.toFixed(1)}s (${rate.toFixed(1)} captured/s)`);

    if (!ffmpeg) {
      console.log(dir);
      note('ffmpeg is not installed, so the frames were kept as JPEGs (brew install ffmpeg)');
      return;
    }

    await encode(dir, capture.frames, capture.endTimestamp, out);

    if (flag(values, 'keep-frames')) {
      note(`frames kept in ${dir}`);
    } else {
      rmSync(dir, { recursive: true, force: true });
    }

    console.log(out);
  },
};

/**
 * Saves screencast frames to `dir` until the duration passes or Ctrl+C. Chrome sends the next
 * frame only after the previous one is acknowledged, so each frame is acked as it lands.
 */
async function screencast(cdp: Cdp, dir: string, seconds: number, values: Values): Promise<ScreencastCapture> {
  const frames: Frame[] = [];
  let firstWall = 0;
  let firstTimestamp = 0;

  cdp.on('Page.screencastFrame', (frame: ScreencastFrame) => {
    const file = join(dir, `frame-${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(frame.data, 'base64'));

    if (frames.length === 0) {
      firstWall = performance.now();
      firstTimestamp = frame.metadata.timestamp;
    }

    frames.push({ file: basename(file), timestamp: frame.metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: num(values, 'quality', 70),
    maxWidth: num(values, 'max-width', 1280),
    maxHeight: num(values, 'max-height', 800),
  });

  await untilStopped(seconds);
  await cdp.send('Page.stopScreencast').catch(() => {});

  const elapsed = frames.length > 0 ? (performance.now() - firstWall) / 1000 : 0;

  return { frames, elapsed, endTimestamp: firstTimestamp + elapsed };
}
