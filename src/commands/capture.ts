import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { type Command, connect, flag, num, str, untilStopped } from '../command.ts';
import { CACHE_DIR } from '../config.ts';
import { timestamp } from '../format.ts';
import { encode, type Frame, hasFfmpeg } from '../video.ts';

const NO_PAINT_HINT =
  'Chrome is not painting this tab. Is the lid open and the screen on, and is the tab in front (`cb focus`)?';

export const shot: Command = {
  name: 'shot',
  summary: 'Screenshot a tab',
  usage: '[-t tab] [-o file.png] [--full] [--jpeg [--quality 80]]',
  details: [
    'An iframe selector (e.g. `-t game`) captures the tab it is in.',
    '--full captures the whole page, not just the visible part.',
  ],
  options: {
    out: { type: 'string', short: 'o' },
    full: { type: 'boolean' },
    jpeg: { type: 'boolean' },
    quality: { type: 'string' },
  },
  async run(ctx, _args, values) {
    const jpeg = flag(values, 'jpeg') || /\.jpe?g$/i.test(str(values, 'out') ?? '');
    const out = resolve(str(values, 'out') ?? `cb-shot-${timestamp()}.${jpeg ? 'jpg' : 'png'}`);
    const { cdp } = await connect(ctx, { page: true });
    try {
      const { data } = await cdp
        .send<{ data: string }>(
          'Page.captureScreenshot',
          {
            format: jpeg ? 'jpeg' : 'png',
            quality: jpeg ? num(values, 'quality', 80) : undefined,
            captureBeyondViewport: flag(values, 'full'),
          },
          20_000,
        )
        .catch((error: Error) => {
          throw new Error(error.message.includes('no reply') ? NO_PAINT_HINT : error.message);
        });
      writeFileSync(out, Buffer.from(data, 'base64'));
      console.log(out);
    } finally {
      cdp.close();
    }
  },
};

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
    const frames: Frame[] = [];
    let firstWall = 0;
    let firstTs = 0;

    const { target, cdp } = await connect(ctx, { page: true });
    try {
      cdp.on('Page.screencastFrame', (p: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
        const file = join(dir, `frame-${String(frames.length).padStart(6, '0')}.jpg`);
        writeFileSync(file, Buffer.from(p.data, 'base64'));
        if (frames.length === 0) {
          firstWall = performance.now();
          firstTs = p.metadata.timestamp;
        }
        frames.push({ file: basename(file), timestamp: p.metadata.timestamp });
        // Chrome sends the next frame only after this one is acknowledged.
        void cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: num(values, 'quality', 70),
        maxWidth: num(values, 'max-width', 1280),
        maxHeight: num(values, 'max-height', 800),
      });
      process.stderr.write(
        `recording "${target.title || target.url}"${seconds > 0 ? ` for ${seconds}s` : ''}, Ctrl+C to stop\n`,
      );
      await untilStopped(seconds);
      await cdp.send('Page.stopScreencast').catch(() => {});
    } finally {
      cdp.close();
    }

    if (frames.length === 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`no frames arrived. ${NO_PAINT_HINT}`);
    }
    const elapsed = (performance.now() - firstWall) / 1000;
    const end = firstTs + elapsed;
    const rate = elapsed > 0 ? frames.length / elapsed : 0;
    process.stderr.write(`${frames.length} frames over ${elapsed.toFixed(1)}s (${rate.toFixed(1)} captured/s)\n`);

    if (!ffmpeg) {
      console.log(dir);
      process.stderr.write('ffmpeg is not installed, so the frames were kept as JPEGs (brew install ffmpeg)\n');
      return;
    }
    await encode(dir, frames, end, out);
    if (flag(values, 'keep-frames')) process.stderr.write(`frames kept in ${dir}\n`);
    else rmSync(dir, { recursive: true, force: true });
    console.log(out);
  },
};
