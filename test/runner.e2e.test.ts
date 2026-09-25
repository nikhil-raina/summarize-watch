import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runOnce, renderReport } from '../src/runner.js';
import { State } from '../src/state.js';
import { setLogLevel } from '../src/util.js';
import { FIXTURES, type FixtureServer, serveFixtures, tmpDir } from './helpers.js';

const FAKE = path.join(FIXTURES, 'fake-summarize');
let server: FixtureServer;

beforeAll(async () => {
  setLogLevel('quiet');
  server = await serveFixtures();
});
afterAll(() => server.close());
afterEach(() => {
  delete process.env.FAKE_SUMMARIZE_MODE;
});

/** Routes YouTube URLs to fixtures and answers the Shorts probe; everything else goes to the real fetch (our local server). */
function fakeFetch(opts: { shortIds?: string[] } = {}): typeof fetch {
  const shortIds = new Set(opts.shortIds ?? ['VKlulHwMxgU']);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://www.youtube.com/feeds/videos.xml')) return fetch(`${server.baseUrl}/youtube.atom.xml`, init);
    const short = /^https:\/\/www\.youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/.exec(url);
    if (short) {
      return shortIds.has(short[1] as string)
        ? new Response('<html>short</html>', { status: 200 })
        : new Response('', { status: 303, headers: { location: `https://www.youtube.com/watch?v=${short[1]}` } });
    }
    return fetch(input as string, init);
  }) as typeof fetch;
}

interface Project {
  dir: string;
  configPath: string;
  loaded: ReturnType<typeof loadConfig>;
  state: State;
}

function project(yaml: string): Project {
  const dir = tmpDir('sw-e2e-');
  const configPath = path.join(dir, 'watch.yaml');
  fs.writeFileSync(configPath, yaml);
  const loaded = loadConfig(configPath);
  const state = State.open(loaded.paths.dbPath);
  return { dir, configPath, loaded, state };
}

const baseYaml = (extra = '') => `
output: { dir: ./vault }
summarize: { bin: ${FAKE}, model: ollama/qwen3:14b, timeout: 1s }
run: { since: all, max_per_run: 20, max_per_source: 10, concurrency: 2, feed_timeout: 5s, backoff: [1h, 6h], max_attempts: 3 ${extra} }
sources:
  - { name: veritasium, type: youtube, channel_id: UCHnyfMqiRRG1u-2MsSQLbXA, tags: [science] }
  - { name: pod, type: podcast, url: ${'${BASE}'}/podcast.rss.xml }
  - { name: blog, type: rss, url: ${'${BASE}'}/blog.atom.xml }
`;

const withBase = (yaml: string) => yaml.replaceAll('${BASE}', server.baseUrl);

describe('runOnce end to end (fake summarize)', () => {
  it('first run: discovers, skips shorts, summarizes everything else, writes notes, transcripts and a digest; second run is a no-op', async () => {
    const p = project(withBase(baseYaml()));
    process.env.FAKE_SUMMARIZE_MODE = 'success';
    const report = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true });

    expect(report.polls.every((x) => x.ok)).toBe(true);
    expect(report.discovered).toBe(8); // 3 yt + 3 podcast + 2 blog
    expect(report.initialStatuses).toEqual({ pending: 7, 'skipped:shorts': 1 }); // the /shorts/ link is skipped at upsert
    expect(report.processed).toHaveLength(7);
    expect(report.processed.every((x) => x.outcome.kind === 'summarized')).toBe(true);
    expect(report.tokensPrompt).toBe(7 * 12345);
    expect(p.state.countByStatus()).toEqual({ pending: 0, done: 7, failed: 0, skipped: 1 });

    const vault = p.loaded.paths.outputDir;
    const notes = fs.readdirSync(vault).filter((f) => f.endsWith('.md'));
    expect(notes).toHaveLength(7);
    expect(notes.every((f) => /^\d{4}-\d{2}-\d{2} .+\.md$/.test(f))).toBe(true);
    const transcripts = fs.readdirSync(path.join(vault, 'transcripts'));
    expect(transcripts).toHaveLength(5); // youtube (2) + podcast (3); rss gets none in media mode
    expect(report.digestPath).toBeTruthy();
    const digest = fs.readFileSync(report.digestPath as string, 'utf8');
    expect(digest).toContain('### veritasium (2)');
    expect(digest).toContain('### pod (3)');
    expect(digest).toContain('### blog (2)');
    expect(digest).toContain('**Totals:** 7 processed · 7 done · 0 failed · 0 skipped');
    expect(p.state.getRun(report.runId as number)).toMatchObject({ status: 'completed', itemsProcessed: 7, itemsDone: 7, itemsDiscovered: 8 });

    const text = renderReport(report);
    expect(text).toContain('8 discovered');
    expect(text).toContain('7 processed → 7 done');

    // the exact argv reached the fake
    const log = path.join(p.dir, 'argv.log');
    process.env.FAKE_SUMMARIZE_LOG = log;
    try {
      const second = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true });
      expect(second.discovered).toBe(0);
      expect(second.processed).toHaveLength(0);
      expect(second.digestPath).toBeNull();
      expect(fs.existsSync(log)).toBe(false); // nothing was spawned except --version
    } finally {
      delete process.env.FAKE_SUMMARIZE_LOG;
    }
    p.state.close();
  });

  it('dry run polls and shows the argv but writes nothing', async () => {
    const p = project(withBase(baseYaml()));
    const report = await runOnce(p.loaded, p.state, { dryRun: true, fetchImpl: fakeFetch() });
    expect(report.selected.length).toBe(7);
    expect(report.selected[0]?.args).toEqual(expect.arrayContaining(['--json', '--format', 'md', '--metrics', 'on', '--timeout', '1s', '--model', 'ollama/qwen3:14b']));
    expect(report.runId).toBeNull();
    expect(fs.existsSync(p.loaded.paths.outputDir)).toBe(false);
    const text = renderReport(report);
    expect(text).toContain('7 would be processed');
    expect(text).toContain(`${FAKE} https://www.youtube.com/watch?v=JsBZOcqZerk --json`);
    // items were still recorded so the next real run knows about them
    expect(p.state.countByStatus().pending).toBe(7);
    p.state.close();
  });

  it('since: first_run + backfill keeps the newest N and skips the rest; shorts probe catches shorts with normal links', async () => {
    const p = project(withBase(baseYaml().replace('since: all', 'since: first_run, backfill: 1')));
    // pretend the Enigma video (JsBZOcqZerk) is a Short too: the probe answers 200 for it
    const report = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch({ shortIds: ['VKlulHwMxgU', 'JsBZOcqZerk'] }), killGraceMs: 5_000, skipWarmUp: true, limit: 1 });
    // youtube: /shorts/ link skipped by hint, enigma backfilled, third before_since
    // podcast: ep101 backfilled, ep100 before_since, undated ep99 never since-skipped → pending
    // blog: first backfilled, second before_since
    expect(report.initialStatuses).toEqual({ pending: 4, 'skipped:shorts': 1, 'skipped:before_since': 3 });
    expect(report.skippedAtSelection.shorts).toBe(1); // enigma, caught by the probe
    expect(report.processed).toHaveLength(1); // --limit 1
    expect(p.state.listItems({ status: 'skipped' }).map((i) => i.skipReason).sort()).toEqual(expect.arrayContaining(['before_since', 'shorts', 'shorts']));
    p.state.close();
  });

  it('failures are recorded with backoff, never permanent, and show up in the digest; retry resets them', async () => {
    const p = project(withBase(baseYaml()));
    process.env.FAKE_SUMMARIZE_MODE = 'fail';
    const t0 = new Date('2026-09-25T03:00:00.000Z');
    const report = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, now: () => t0 });
    expect(report.processed.every((x) => x.outcome.kind === 'failed_exit')).toBe(true);
    const failed = p.state.listItems({ status: 'failed' });
    expect(failed).toHaveLength(7);
    expect(failed[0]).toMatchObject({ attempts: 1, nextAttemptAt: '2026-09-25T04:00:00.000Z', lastErrorKind: 'failed_exit', lastError: 'Error: No transcript available for this video' });
    const digest = fs.readFileSync(report.digestPath as string, 'utf8');
    expect(digest).toContain('### Failed (7)');
    expect(digest).toMatch(/retry \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    // not due yet → nothing processed
    const later = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, now: () => new Date('2026-09-25T03:30:00.000Z') });
    expect(later.processed).toHaveLength(0);
    // due → tried again, attempts 2, next delay 6h
    const due = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, now: () => new Date('2026-09-25T04:00:00.000Z') });
    expect(due.processed).toHaveLength(7);
    expect(p.state.listItems({ status: 'failed' })[0]).toMatchObject({ attempts: 2, nextAttemptAt: '2026-09-25T10:00:00.000Z' });
    // third failure hits max_attempts 3 → gave up (null), still status failed
    const gaveUp = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, now: () => new Date('2026-09-25T10:00:00.000Z') });
    expect(gaveUp.processed).toHaveLength(7);
    expect(p.state.listItems({ status: 'failed' })[0]).toMatchObject({ attempts: 3, nextAttemptAt: null });
    expect(p.state.resetItems({ all: true })).toBe(7);
    process.env.FAKE_SUMMARIZE_MODE = 'success';
    const fixed = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true });
    expect(fixed.processed.filter((x) => x.outcome.kind === 'summarized')).toHaveLength(7);
    p.state.close();
  });

  it('llm:null, garbage stdout and timeouts land in the right buckets; garbage dumps last-invalid.json', async () => {
    const p = project(withBase(baseYaml()));
    process.env.FAKE_SUMMARIZE_MODE = 'llm-null';
    let r = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, limit: 1 });
    expect(r.processed[0]?.outcome.kind).toBe('not_summarized');
    p.state.resetItems({ all: true });

    process.env.FAKE_SUMMARIZE_MODE = 'garbage';
    r = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, limit: 1 });
    expect(r.processed[0]?.outcome.kind).toBe('invalid_envelope');
    const dump = JSON.parse(fs.readFileSync(p.loaded.paths.lastInvalidPath, 'utf8')) as { stdout: string; args: string[] };
    expect(dump.stdout).toContain('this is not json');
    expect(dump.args).toContain('--json');
    p.state.resetItems({ all: true });

    process.env.FAKE_SUMMARIZE_MODE = 'hang';
    r = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 300, skipWarmUp: true, limit: 1 }); // timeout 1s + 300ms
    expect(r.processed[0]?.outcome.kind).toBe('timeout');
    expect(p.state.listItems({ status: 'failed' })[0]?.lastErrorKind).toBe('timeout');
    p.state.close();
  });

  it('direct-audio (asset) envelopes produce a note and a transcript recovered from the prompt', async () => {
    const p = project(withBase(baseYaml()));
    process.env.FAKE_SUMMARIZE_MODE = 'asset';
    const r = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, sourceFilter: 'pod', limit: 1 });
    expect(r.processed[0]?.outcome.kind).toBe('summarized');
    const note = fs.readFileSync(path.join(p.loaded.paths.outputDir, r.processed[0]?.notePath as string), 'utf8');
    expect(note).toContain('source_type: podcast');
    expect(note).toContain('transcript_source: transcription');
    expect(note).toContain('Summary of the Home Depot Podcast Episode');
    const transcript = fs.readFileSync(path.join(p.loaded.paths.transcriptsDir, r.processed[0]?.notePath as string), 'utf8');
    expect(transcript).toContain('Welcome to season 15 episode 1 of Acquired');
    p.state.close();
  });

  it('short content is filed verbatim instead of failing', async () => {
    const p = project(withBase(baseYaml()));
    process.env.FAKE_SUMMARIZE_MODE = 'extract'; // summary null, 101 chars
    const r = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, limit: 1 });
    expect(r.processed[0]?.outcome.kind).toBe('short_verbatim');
    const note = fs.readFileSync(path.join(p.loaded.paths.outputDir, r.processed[0]?.notePath as string), 'utf8');
    expect(note).toContain('summarized: false');
    p.state.close();
  });

  it('abort stops after the in-flight item and marks the run aborted; pending items stay pending', async () => {
    const p = project(withBase(baseYaml()));
    process.env.FAKE_SUMMARIZE_MODE = 'hang';
    const c = new AbortController();
    setTimeout(() => c.abort(), 200);
    const r = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 30_000, skipWarmUp: true, signal: c.signal });
    expect(r.aborted).toBe(true);
    expect(r.processed.every((x) => x.outcome.kind === 'aborted')).toBe(true);
    expect(p.state.countByStatus().pending).toBe(7); // nothing was marked failed
    expect(p.state.getRun(r.runId as number)?.status).toBe('aborted');
    expect(renderReport(r)).toContain('ABORTED');
    p.state.close();
  });

  it('a duplicate video under a second source is skipped once the first is done', async () => {
    const p = project(withBase(baseYaml()));
    process.env.FAKE_SUMMARIZE_MODE = 'success';
    await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, sourceFilter: 'veritasium' });
    fs.appendFileSync(p.configPath, `  - { name: veritasium2, type: youtube, channel_id: UCHnyfMqiRRG1u-2MsSQLbX2 }\n`);
    const loaded2 = loadConfig(p.configPath);
    const r = await runOnce(loaded2, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, sourceFilter: 'veritasium2' });
    expect(r.processed).toHaveLength(0);
    expect(r.skippedAtSelection.duplicate).toBe(2);
    const dup = p.state.listItems({ sourceName: 'veritasium2', status: 'skipped' });
    expect(dup.some((i) => i.skipReason?.startsWith('duplicate_of:'))).toBe(true);
    expect(dup.find((i) => i.skipReason?.startsWith('duplicate_of:'))?.notePath).toMatch(/\.md$/);
    p.state.close();
  });

  it('a broken feed does not stop the run; a missing binary does', async () => {
    const p = project(withBase(baseYaml().replace('/blog.atom.xml', '/does-not-exist.xml')));
    process.env.FAKE_SUMMARIZE_MODE = 'success';
    const r = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true });
    expect(r.polls.find((x) => x.source.name === 'blog')).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 404/) });
    expect(r.processed).toHaveLength(5);
    expect(p.state.getSourceByName('blog')?.lastPollOk).toBe(false);
    p.state.close();

    const q = project(withBase(baseYaml().replace(`bin: ${FAKE}`, 'bin: /nope/summarize')));
    await expect(runOnce(q.loaded, q.state, { fetchImpl: fakeFetch() })).rejects.toThrow(/not found on PATH/);
    q.state.close();
  });

  it('refuses to start while another run is alive, and recovers from a crashed one', async () => {
    const p = project(withBase(baseYaml()));
    p.state.startRun(process.pid, false); // "alive": our own pid
    await expect(runOnce(p.loaded, p.state, { fetchImpl: fakeFetch() })).rejects.toThrow(/another run is in progress/);
    p.state.db.exec(`UPDATE runs SET pid = 999999999`); // dead pid
    process.env.FAKE_SUMMARIZE_MODE = 'success';
    const r = await runOnce(p.loaded, p.state, { fetchImpl: fakeFetch(), killGraceMs: 5_000, skipWarmUp: true, limit: 1 });
    expect(r.processed).toHaveLength(1);
    expect(p.state.getRun(1)?.status).toBe('crashed');
    p.state.close();
  });
});
