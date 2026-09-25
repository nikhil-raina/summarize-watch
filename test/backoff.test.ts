import { describe, expect, it } from 'vitest';
import { formatDuration, nextAttemptAt, parseDuration } from '../src/util.js';

const BACKOFF = ['1h', '6h', '24h', '72h'].map(parseDuration);
const T0 = new Date('2026-09-25T03:00:00.000Z');

describe('nextAttemptAt', () => {
  it('walks the backoff table then gives up at max_attempts', () => {
    expect(nextAttemptAt(1, BACKOFF, 5, T0)).toBe('2026-09-25T04:00:00.000Z');
    expect(nextAttemptAt(2, BACKOFF, 5, T0)).toBe('2026-09-25T09:00:00.000Z');
    expect(nextAttemptAt(3, BACKOFF, 5, T0)).toBe('2026-09-26T03:00:00.000Z');
    expect(nextAttemptAt(4, BACKOFF, 5, T0)).toBe('2026-09-28T03:00:00.000Z');
    expect(nextAttemptAt(5, BACKOFF, 5, T0)).toBeNull();
  });

  it('repeats the last delay when there are more attempts than entries', () => {
    expect(nextAttemptAt(4, [parseDuration('1h')], 10, T0)).toBe('2026-09-25T04:00:00.000Z');
  });
});

describe('durations', () => {
  it('parses and rejects', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('3d')).toBe(259_200_000);
    expect(() => parseDuration('10')).toThrow(/Invalid duration/);
    expect(() => parseDuration('1 h')).toThrow(/Invalid duration/);
  });

  it('formats for humans', () => {
    expect(formatDuration(900)).toBe('900ms');
    expect(formatDuration(41_000)).toBe('41s');
    expect(formatDuration(842_000)).toBe('14m 02s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
  });
});
