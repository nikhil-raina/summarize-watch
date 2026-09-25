import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { appendDigest, excerpt, localDateStamp, noteFilename, renderDigestSection, slugify, writeNote } from '../src/notes.js';
import type { Envelope } from '../src/summarizer.js';
import { fixture, tmpDir } from './helpers.js';

const env = JSON.parse(fixture('envelope-success.json')) as Envelope;

describe('slugify', () => {
  it('handles the usual title mess', () => {
    expect(slugify('How Lasers Work', 'x')).toBe('how lasers work');
    expect(slugify('  Café: "Crème" brûlée / #1 <best> [ever] | ok?  ', 'x')).toBe('cafe creme brulee 1 best ever ok');
    expect(slugify('Ends with dots...', 'x')).toBe('ends with dots');
    expect(slugify('Emoji 🚀 stays', 'x')).toBe('emoji 🚀 stays');
    expect(slugify('', 'VKlulHwMxgU')).toBe('vklulhwmxgu');
    expect(slugify(null, 'https://a/b')).toBe('https-a-b');
    const long = slugify('word '.repeat(40).trim(), 'x');
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('word')).toBe(true);
  });
  it('date stamps use the published date and fall back to discovery', () => {
    expect(localDateStamp('2026-09-24T14:00:00.000Z', '2026-09-25T00:00:00.000Z')).toMatch(/^2026-09-2[45]$/);
    expect(localDateStamp(null, '2026-09-25T12:00:00.000Z')).toMatch(/^2026-09-25$/);
    expect(localDateStamp('garbage', '2026-09-25T12:00:00.000Z')).toMatch(/^2026-09-25$/);
  });
});

describe('noteFilename', () => {
  it('suffixes on collision with a different item, reuses its own file', () => {
    const dir = tmpDir();
    expect(noteFilename(dir, '2026-09-24 a', 1, () => null)).toBe('2026-09-24 a.md');
    fs.writeFileSync(path.join(dir, '2026-09-24 a.md'), 'x');
    expect(noteFilename(dir, '2026-09-24 a', 1, (p) => (p === '2026-09-24 a.md' ? 1 : null))).toBe('2026-09-24 a.md');
    expect(noteFilename(dir, '2026-09-24 a', 2, (p) => (p === '2026-09-24 a.md' ? 1 : null))).toBe('2026-09-24 a (2).md');
    fs.writeFileSync(path.join(dir, '2026-09-24 a (2).md'), 'x');
    expect(noteFilename(dir, '2026-09-24 a', 3, () => null)).toBe('2026-09-24 a (3).md');
  });
});

describe('writeNote', () => {
  const item = {
    id: 42, title: 'feed title', url: 'https://www.youtube.com/watch?v=JsBZOcqZerk', publishedAt: '2026-09-21T17:49:57.000Z',
    discoveredAt: '2026-09-25T03:00:00.000Z', sourceName: 'veritasium', sourceType: 'youtube' as const, externalId: 'JsBZOcqZerk',
  };

  it('writes frontmatter Obsidian can parse, the summary, and a transcript sibling for media', () => {
    const out = tmpDir();
    const paths = { outputDir: out, transcriptsDir: path.join(out, 'transcripts') };
    const w = writeNote(paths, { item, tags: ['summarize-watch', 'youtube', 'science'], envelope: env, summarized: true, model: 'qwen3:14b', provider: 'ollama', tokensPrompt: 12345, tokensCompletion: 890, transcriptMode: 'media' }, '2026-09-21 enigma.md');
    expect(w.title).toBe('The Insane Real Engineering of the Nazi Enigma Machine');
    const text = fs.readFileSync(w.absNotePath, 'utf8');
    const fm = parseYaml(text.split('---\n')[1] as string) as Record<string, unknown>;
    expect(fm).toMatchObject({
      title: 'The Insane Real Engineering of the Nazi Enigma Machine', source: 'veritasium', source_type: 'youtube', url: item.url,
      summarized: true, model: 'qwen3:14b', provider: 'ollama', tokens_prompt: 12345, tokens_completion: 890, duration_seconds: 1834,
      transcript_source: 'youtube-captions', transcript: 'transcripts/2026-09-21 enigma.md', tags: ['summarize-watch', 'youtube', 'science'], summarize_watch_id: 42,
    });
    expect(text).toContain('# The Insane Real Engineering of the Nazi Enigma Machine');
    expect(text).toContain('[veritasium](https://www.youtube.com/watch?v=JsBZOcqZerk) · published 2026-09-21 · 30m 34s');
    expect(text).toContain('The Enigma machine scrambled letters');
    expect(text).not.toContain('## Transcript');
    const transcript = fs.readFileSync(path.join(out, 'transcripts', '2026-09-21 enigma.md'), 'utf8');
    expect(transcript).toContain('note: "[[2026-09-21 enigma]]"');
    expect(transcript).toContain('Enigma transcript line.');
  });

  it('inline mode appends the transcript; rss sources get no sibling in media mode; verbatim notes say so', () => {
    const out = tmpDir();
    const paths = { outputDir: out, transcriptsDir: path.join(out, 'transcripts') };
    const inline = writeNote(paths, { item, tags: [], envelope: env, summarized: true, model: null, provider: null, tokensPrompt: null, tokensCompletion: null, transcriptMode: 'inline' }, 'a.md');
    expect(fs.readFileSync(inline.absNotePath, 'utf8')).toContain('## Transcript');
    expect(inline.transcriptPath).toBeNull();
    const rssEnv: Envelope = { ...env, extracted: { ...env.extracted, video: null, transcriptSource: null, mediaDurationSeconds: null } };
    const rss = writeNote(paths, { item: { ...item, sourceType: 'rss' }, tags: [], envelope: rssEnv, summarized: false, model: null, provider: null, tokensPrompt: null, tokensCompletion: null, transcriptMode: 'media' }, 'b.md');
    expect(rss.transcriptPath).toBeNull();
    const text = fs.readFileSync(rss.absNotePath, 'utf8');
    expect(text).toContain('summarized: false');
    expect(text).toContain('filed verbatim');
    expect(text).toContain('Enigma transcript line.'); // body is the content, not the summary
    expect(fs.existsSync(path.join(out, 'transcripts', 'b.md'))).toBe(false);
  });
});

describe('excerpt', () => {
  it('drops headings and list markers and takes the first sentence', () => {
    expect(excerpt(env.summary as string)).toBe('The Enigma machine scrambled letters with rotors and a plugboard, giving 150 quintillion settings.');
    expect(excerpt('- **Bold** point one. Point two.')).toBe('Bold point one.');
    expect(excerpt('x'.repeat(300))).toHaveLength(200);
    expect(excerpt('')).toBe('');
  });
});

describe('digest', () => {
  const section = (runId: number, startedAt: string) => ({
    runId, startedAt, finishedAt: startedAt, model: 'ollama/qwen3:14b',
    bySource: new Map([['veritasium', [{ title: 'Enigma | machine', noteRel: '2026-09-21 enigma.md', url: 'u', excerpt: 'First sentence.', verbatim: false }]]]),
    failed: [{ source: 'acquired', title: 'Ep [1]', url: 'u2', kind: 'failed_exit', error: 'No transcript', attempts: 1, nextAttemptAt: '2026-09-25T04:00:00.000Z' }],
    skipped: { shorts: 2 },
    totals: { processed: 2, done: 1, verbatim: 0, failed: 1, skipped: 2, tokensPrompt: 12345, tokensCompletion: 890 },
  });

  it('renders a run section with sources, failures, skips and totals', () => {
    const md = renderDigestSection(section(7, '2026-09-25T10:00:00.000Z'));
    expect(md).toContain('(#7)');
    expect(md).toContain('### veritasium (1)');
    expect(md).toContain('[[2026-09-21 enigma|Enigma   machine]] — First sentence.');
    expect(md).toContain('### Failed (1)');
    expect(md).toContain('acquired · [Ep 1](u2) — failed_exit: No transcript (attempt 1, retry 2026-09-25 04:00)');
    expect(md).toContain('- 2 shorts');
    expect(md).toContain('**Totals:** 2 processed · 1 done · 1 failed · 2 skipped · 12,345 / 890 tokens · ollama/qwen3:14b');
  });

  it('appends a second run to the same day file and keeps one frontmatter', () => {
    const dir = tmpDir();
    // two runs on the same *local* day (noon and 8pm local), regardless of the machine's timezone
    const day = new Date(); day.setHours(12, 0, 0, 0);
    const evening = new Date(day); evening.setHours(20);
    const a = appendDigest(dir, section(1, day.toISOString()));
    const b = appendDigest(dir, section(2, evening.toISOString()));
    expect(a).toBe(b);
    const text = fs.readFileSync(a, 'utf8');
    expect(text.match(/^---$/gm)).toHaveLength(2);
    expect(text.match(/^## Run /gm)).toHaveLength(2);
    expect(text).toContain('summarize_watch: digest');
  });
});
