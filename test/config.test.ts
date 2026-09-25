import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, configPaths, effectiveSources, parseConfigText, renderStarterConfig } from '../src/config.js';

const MIN = `
output: { dir: ./notes }
sources:
  - { name: vt, type: youtube, channel_id: UCHnyfMqiRRG1u-2MsSQLbXA, tags: [science], model: ollama/gemma3:12b, timeout: 5m }
  - { name: pod, type: podcast, url: https://feeds.example.com/pod.xml, prefer: link, cli: claude }
  - { name: blog, type: rss, url: https://blog.example.org/feed, enabled: false }
`;

describe('config', () => {
  it('applies defaults and merges per-source overrides', () => {
    const cfg = parseConfigText(MIN, '/tmp/x/watch.yaml');
    expect(cfg.summarize.timeout).toBe('15m');
    expect(cfg.run.backoff).toEqual(['1h', '6h', '24h', '72h']);
    expect(cfg.defaults.prefer).toBe('enclosure');
    const [vt, pod, blog] = effectiveSources(cfg);
    expect(vt).toMatchObject({
      feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA',
      tags: ['summarize-watch', 'youtube', 'science'],
      includeShorts: false,
      maxPerSource: 5,
      since: 'first_run',
      backfill: 3,
    });
    expect(vt?.summarize).toMatchObject({ model: 'ollama/gemma3:12b', cli: null, timeout: '5m', timeoutMs: 300_000, bin: 'summarize' });
    expect(pod?.summarize).toMatchObject({ model: null, cli: 'claude', timeoutMs: 900_000 });
    expect(pod?.prefer).toBe('link');
    expect(blog?.enabled).toBe(false);
  });

  it('resolves paths relative to the yaml and expands ~', () => {
    const cfg = parseConfigText(MIN, '/tmp/x/watch.yaml');
    const p = configPaths(cfg, '/tmp/x/watch.yaml');
    expect(p.outputDir).toBe(path.resolve('/tmp/x/notes'));
    expect(p.digestsDir).toBe(path.resolve('/tmp/x/notes/digests'));
    expect(p.transcriptsDir).toBe(path.resolve('/tmp/x/notes/transcripts'));
    expect(p.dbPath).toBe(path.resolve('/tmp/x/state/watch.sqlite'));
    const home = parseConfigText('output: { dir: ~/Vault/Sum }', '/tmp/x/watch.yaml');
    expect(configPaths(home, '/tmp/x/watch.yaml').outputDir.startsWith('/')).toBe(true);
    expect(configPaths(home, '/tmp/x/watch.yaml').outputDir.endsWith('/Vault/Sum')).toBe(true);
  });

  it('rejects the mistakes people actually make, with paths in the message', () => {
    const cases: Array<[string, RegExp]> = [
      ['sources: [{ name: a, type: youtube }]', /sources\.0\.channel_id.*channel_id/s],
      ['sources: [{ name: a, type: podcast }]', /sources\.0\.url/],
      ['summarize: { model: x, cli: claude }', /summarize\.cli.*not both/s],
      ['sources: [{ name: a, type: rss, url: https://a }, { name: A, type: rss, url: https://b }]', /duplicate source name/],
      ['sources: [{ name: a, type: rss, url: https://a }, { name: b, type: rss, url: https://a }]', /duplicate feed/],
      ['run: { timeout: 5m }', /run.*Unrecognized|run\.timeout/s],
      ['summarize: { timeout: 5 minutes }', /summarize\.timeout.*duration/s],
      ['run: { since: yesterday }', /run\.since/],
    ];
    for (const [snippet, re] of cases) {
      expect(() => parseConfigText(`output: { dir: ./n }\n${snippet}\n`, 'w.yaml'), snippet).toThrow(re);
    }
    expect(() => parseConfigText('output: [', 'w.yaml')).toThrow(ConfigError);
    expect(() => parseConfigText('', 'w.yaml')).toThrow(/output/);
  });

  it('accepts every since form', () => {
    for (const since of ['first_run', 'all', '2026-09-01', '2026-09-01T10:00:00Z', '14d']) {
      expect(parseConfigText(`output: { dir: ./n }\nrun: { since: ${since} }`, 'w.yaml').run.since).toBe(since);
    }
  });

  it('the starter template parses and keeps the Ollama defaults', () => {
    const text = renderStarterConfig({ outputDir: '~/Vault/Summaries' });
    const cfg = parseConfigText(text, '/tmp/watch.yaml');
    expect(cfg.summarize.model).toBe('ollama/qwen3:14b');
    expect(cfg.run.concurrency).toBe(1);
    expect(cfg.sources).toEqual([]);
    const quoted = renderStarterConfig({ outputDir: '/Users/me/My Vault/Notes' });
    expect(parseConfigText(quoted, '/tmp/watch.yaml').output.dir).toBe('/Users/me/My Vault/Notes');
  });
});
