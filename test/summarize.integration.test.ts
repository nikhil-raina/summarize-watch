import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSummarizeVersion, classify, runSummarize } from '../src/summarizer.js';
import { type FixtureServer, serveFixtures } from './helpers.js';

function summarizeOnPath(): boolean {
  try {
    execFileSync('summarize', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The drift alarm: runs the real binary (extraction only, no model) against a local page and
// validates the envelope with the same schema the runner uses. Skipped when summarize is absent.
describe.skipIf(!summarizeOnPath())('real summarize --extract --json', () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await serveFixtures();
  });
  afterAll(() => server.close());

  it('reports a supported version', async () => {
    const v = await checkSummarizeVersion('summarize');
    expect(v.ok, !v.ok ? v.error : '').toBe(true);
  });

  it('produces an envelope our schema accepts, classified as short_verbatim for a tiny page', async () => {
    const raw = await runSummarize({
      bin: 'summarize',
      args: [`${server.baseUrl}/article.html`, '--extract', '--json', '--format', 'md', '--timeout', '30s'],
      timeoutMs: 60_000,
    });
    expect(raw.exitCode, raw.stderrTail).toBe(0);
    const outcome = classify(raw, { shortContentChars: 1500 });
    expect(outcome.kind, JSON.stringify(outcome).slice(0, 300)).toBe('short_verbatim');
    if (outcome.kind === 'short_verbatim') {
      expect(outcome.envelope.extracted.title).toBe('Example Domain');
      expect(outcome.envelope.extracted.content).toContain('illustrative examples');
    }
  });
});
