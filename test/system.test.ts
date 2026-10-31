import { describe, expect, test } from 'bun:test';
import { describeProcess, parseKeyValues, parseSample, parseTop, systemCpu } from '../src/system.ts';

describe('parseKeyValues', () => {
  test('splits on the first = and skips other lines', () => {
    const values = parseKeyValues('load=0.1 0.2 0.3\ntemp.INT3400 Thermal=20000\nbogus\n');

    expect(values.get('load')).toBe('0.1 0.2 0.3');
    expect(values.get('temp.INT3400 Thermal')).toBe('20000');
    expect(values.has('bogus')).toBe(false);
  });
});

describe('describeProcess', () => {
  test('labels Chrome processes by type', () => {
    expect(describeProcess(['/opt/google/chrome/chrome', '--type=renderer', '--extension-process'])).toBe(
      'chrome renderer (extension)',
    );
    expect(describeProcess(['/opt/google/chrome/chrome', '--login-manager'])).toBe('chrome (browser)');
  });

  test('leaves other processes as their command line', () => {
    expect(describeProcess(['/usr/bin/shill', '--log-level=0'])).toBe('/usr/bin/shill --log-level=0');
  });
});

describe('parseTop', () => {
  test('turns tick deltas into CPU percent, busiest first', () => {
    const output = [
      '1 100\n2 50\n',
      '1 103\n2 90\n',
      '  1  2048 /sbin/init\n  2 409600 /opt/google/chrome/chrome --type=gpu-process\n',
    ].join('---\n');

    expect(parseTop(output, 5)).toEqual([
      { pid: '2', cpu: 40, rssMb: 400, name: 'chrome gpu-process' },
      { pid: '1', cpu: 3, rssMb: 2, name: '/sbin/init' },
    ]);
  });
});

describe('sampler', () => {
  test('parses a sample line', () => {
    expect(parseSample('S 1000 4000 860160 3893248 1100 41000')).toEqual({
      cpuBusy: 1000,
      cpuTotal: 4000,
      memAvailableMb: 840,
      memTotalMb: 3802,
      cpuMHz: 1100,
      maxTempC: 41,
    });
  });

  test('ignores anything that is not a sample', () => {
    expect(parseSample('warning: something')).toBeUndefined();
    expect(parseSample('S 1 2')).toBeUndefined();
  });

  test('system CPU is busy jiffies over total jiffies between samples', () => {
    const before = parseSample('S 1000 4000 0 0 0 0')!;
    const after = parseSample('S 1150 4200 0 0 0 0')!;

    expect(systemCpu(before, after)).toBe(75);
    expect(systemCpu(after, after)).toBe(0);
  });
});
