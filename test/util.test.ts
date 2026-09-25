import { describe, expect, it } from 'vitest';
import { canonicalYouTubeUrl, extractYouTubeId, isYouTubeShortsUrl, stripAnsi, tail, trustSystemCertificates } from '../src/util.js';

describe('youtube url helpers', () => {
  it('extracts ids from every url shape and canonicalises', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=JsBZOcqZerk&t=10s',
      'https://youtu.be/JsBZOcqZerk',
      'https://m.youtube.com/watch?v=JsBZOcqZerk',
      'https://www.youtube.com/shorts/JsBZOcqZerk',
      'https://www.youtube.com/live/JsBZOcqZerk?feature=share',
      'https://www.youtube.com/embed/JsBZOcqZerk',
    ]) {
      expect(extractYouTubeId(u), u).toBe('JsBZOcqZerk');
      expect(canonicalYouTubeUrl(u)).toBe('https://www.youtube.com/watch?v=JsBZOcqZerk');
    }
    expect(extractYouTubeId('https://www.youtube.com/@veritasium')).toBeNull();
    expect(extractYouTubeId('https://vimeo.com/123')).toBeNull();
    expect(extractYouTubeId('not a url')).toBeNull();
    expect(isYouTubeShortsUrl('https://www.youtube.com/shorts/abc')).toBe(true);
    expect(isYouTubeShortsUrl('https://www.youtube.com/watch?v=abc')).toBe(false);
  });
});

describe('strings', () => {
  it('strips ansi and tails', () => {
    expect(stripAnsi('\u001b[31mError:\u001b[0m boom')).toBe('Error: boom');
    expect(tail('a\r\n\n\nb\nc', 100)).toBe('a\nb\nc');
    expect(tail('x'.repeat(50), 10)).toBe(`…${'x'.repeat(10)}`);
  });
});

describe('trustSystemCertificates', () => {
  it('is idempotent, reports support, and honours the opt-out', () => {
    expect(trustSystemCertificates({ SUMMARIZE_WATCH_NO_SYSTEM_CA: '1' })).toEqual({ supported: true, added: 0, skipped: true });
    const first = trustSystemCertificates({});
    const second = trustSystemCertificates({});
    expect(first.skipped).toBe(false);
    expect(second).toEqual(first);
    expect(first.added).toBeGreaterThanOrEqual(0);
  });
});
