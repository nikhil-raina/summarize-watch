import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EffectiveSummarize } from '../src/config.js';
import { buildArgs, checkSummarizeVersion, classify, compareVersions, contentFromPrompt, parseEnvelope, parseVersion, type RawResult, runSummarize, summarizeErrorLine } from '../src/summarizer.js';
import { FIXTURES, fixture } from './helpers.js';

const FAKE = path.join(FIXTURES, 'fake-summarize');

const base: EffectiveSummarize = {
  bin: 'summarize', model: 'ollama/qwen3:14b', cli: null, language: null, length: null, prompt: null,
  timeout: '15m', timeoutMs: 900_000, noCache: false, extraArgs: [],
};

function raw(over: Partial<RawResult>): RawResult {
  return { exitCode: 0, signal: null, stdout: '', stderrTail: '', timedOut: false, aborted: false, durationMs: 1234, ...over };
}

describe('buildArgs', () => {
  it('builds the documented argv for a model', () => {
    expect(buildArgs('https://a.test/x?y=1&z=2', base)).toEqual([
      'https://a.test/x?y=1&z=2', '--json', '--format', 'md', '--metrics', 'on', '--timeout', '15m', '--model', 'ollama/qwen3:14b',
    ]);
  });
  it('uses --cli instead of --model and appends every optional flag', () => {
    const args = buildArgs('u', { ...base, model: null, cli: 'claude', language: 'de', length: '20k', prompt: 'Be terse', noCache: true, extraArgs: ['--verbose'] });
    expect(args).toEqual(['u', '--json', '--format', 'md', '--metrics', 'on', '--timeout', '15m', '--cli', 'claude', '--language', 'de', '--length', '20k', '--prompt', 'Be terse', '--no-cache', '--verbose']);
  });
  it('omits --model when neither model nor cli is set (summarize applies its own default)', () => {
    expect(buildArgs('u', { ...base, model: null })).not.toContain('--model');
  });
});

describe('parseEnvelope', () => {
  it('accepts the real extract envelope and a success envelope', () => {
    expect(parseEnvelope(fixture('envelope-extract.json')).ok).toBe(true);
    const r = parseEnvelope(fixture('envelope-success.json'));
    expect(r.ok && r.envelope.llm?.model).toBe('qwen3:14b');
  });
  it('tolerates stray text around the JSON but rejects garbage and shape changes', () => {
    expect(parseEnvelope(`Fetching...\n${fixture('envelope-success.json')}\n`).ok).toBe(true);
    const g = parseEnvelope('Fetching...\nnot json');
    expect(g.ok).toBe(false);
    expect(!g.ok && g.error).toMatch(/not JSON/);
    const drift = parseEnvelope(JSON.stringify({ result: { text: 'x' }, llm: null, summary: null }));
    expect(!drift.ok && drift.error).toMatch(/envelope shape changed.*extracted/);
    const noSummaryKey = parseEnvelope(JSON.stringify({ extracted: { content: 'x' }, llm: null }));
    expect(!noSummaryKey.ok && noSummaryKey.error).toMatch(/envelope shape changed.*summary/);
    expect(parseEnvelope('').ok).toBe(false);
  });
});

describe('asset (direct audio) envelopes', () => {
  it('accepts the metadata-only extracted block and recovers the transcript from the prompt', () => {
    const r = parseEnvelope(fixture('envelope-asset.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.extracted.kind).toBe('asset');
    expect(r.envelope.extracted.content.startsWith('Welcome to season 15 episode 1 of Acquired')).toBe(true);
    expect(r.envelope.extracted.content).not.toContain('Transcript:');
    expect(r.envelope.extracted.content).not.toContain('</content>');
    expect(r.envelope.extracted.transcriptSource).toBe('transcription');
    const o = classify(raw({ stdout: fixture('envelope-asset.json') }), { shortContentChars: 1500 });
    expect(o.kind).toBe('summarized');
    expect(o.kind === 'summarized' && o.tokensPrompt).toBe(16382);
  });
  it('contentFromPrompt is strict about the delimiters', () => {
    expect(contentFromPrompt('<instructions>x</instructions>\n\n<content>\nTranscript:\nhello\nworld\n</content>\n')).toBe('hello\nworld');
    expect(contentFromPrompt('<content>\nplain\n</content>')).toBe('plain');
    expect(contentFromPrompt('no markers here')).toBeNull();
    expect(contentFromPrompt(null)).toBeNull();
    expect(contentFromPrompt('<content>\n\n</content>')).toBeNull();
  });
  it('an asset with neither summary nor content is not filed verbatim', () => {
    const env = JSON.parse(fixture('envelope-asset.json')) as { summary: string | null; llm: unknown; prompt: string | null };
    env.summary = null; env.llm = null; env.prompt = null;
    const o = classify(raw({ stdout: JSON.stringify(env) }), { shortContentChars: 1500 });
    expect(o.kind).toBe('not_summarized');
  });
});

describe('classify', () => {
  const shortOpts = { shortContentChars: 1500 };
  it('summarized with token sums', () => {
    const o = classify(raw({ stdout: fixture('envelope-success.json') }), shortOpts);
    expect(o.kind).toBe('summarized');
    expect(o.kind === 'summarized' && o.tokensPrompt).toBe(12345);
    expect(o.kind === 'summarized' && o.tokensCompletion).toBe(890);
  });
  it('llm null on long content → not_summarized; on short content → short_verbatim', () => {
    const long = classify(raw({ stdout: fixture('envelope-llm-null.json') }), shortOpts);
    expect(long.kind).toBe('not_summarized');
    expect(long.kind === 'not_summarized' && long.error).toMatch(/llm: null/);
    const short = classify(raw({ stdout: fixture('envelope-extract.json') }), shortOpts); // 101 chars, summary null
    expect(short.kind).toBe('short_verbatim');
    expect(classify(raw({ stdout: fixture('envelope-extract.json') }), { shortContentChars: 50 }).kind).toBe('not_summarized');
  });
  it('exit codes, timeouts, aborts, spawn errors and garbage stdout', () => {
    const f = classify(raw({ exitCode: 1, stderrTail: 'Fetching...\nError: No transcript available for this video' }), shortOpts);
    expect(f).toMatchObject({ kind: 'failed_exit', exitCode: 1, error: 'Error: No transcript available for this video' });
    expect(classify(raw({ exitCode: null, signal: 'SIGTERM', timedOut: true }), shortOpts).kind).toBe('timeout');
    expect(classify(raw({ exitCode: null, signal: 'SIGTERM', aborted: true }), shortOpts).kind).toBe('aborted');
    const enoent = Object.assign(new Error('spawn summarize ENOENT'), { code: 'ENOENT' });
    const s = classify(raw({ spawnError: enoent, exitCode: null }), shortOpts);
    expect(s.kind).toBe('spawn_error');
    expect(s.kind === 'spawn_error' && s.error).toMatch(/brew install summarize/);
    const g = classify(raw({ stdout: 'Fetching...\nnope' }), shortOpts);
    expect(g.kind).toBe('invalid_envelope');
    expect(g.kind === 'invalid_envelope' && g.rawStdout).toBe('Fetching...\nnope');
  });
});

describe('summarizeErrorLine', () => {
  it('prefers the line that says what went wrong over the trailing option list', () => {
    const stderr = [
      'No transcription provider is configured for this media.',
      'Options:',
      '1. Groq: Set GROQ_API_KEY=...',
      '8. Local whisper.cpp:',
      '   brew install whisper-cpp',
      '   Ensure whisper-cli is on your PATH',
      'See: summarize transcriber help',
    ].join('\n');
    expect(summarizeErrorLine(stderr)).toBe('No transcription provider is configured for this media. (See: summarize transcriber help)');
    expect(summarizeErrorLine('Fetching...\nError: No transcript available for this video')).toBe('Error: No transcript available for this video');
    expect(summarizeErrorLine('just one line')).toBe('just one line');
    expect(summarizeErrorLine('')).toBe('');
  });
});

describe('runSummarize (with the fake binary)', () => {
  afterEach(() => {
    delete process.env.FAKE_SUMMARIZE_MODE;
    delete process.env.FAKE_SUMMARIZE_VERSION;
  });

  it('captures stdout, exit code and an ANSI-stripped stderr tail', async () => {
    const ok = await runSummarize({ bin: FAKE, args: ['https://x.test'], timeoutMs: 10_000, env: { FAKE_SUMMARIZE_MODE: 'success' } });
    expect(ok.exitCode).toBe(0);
    expect(parseEnvelope(ok.stdout).ok).toBe(true);
    const fail = await runSummarize({ bin: FAKE, args: ['u'], timeoutMs: 10_000, env: { FAKE_SUMMARIZE_MODE: 'fail' } });
    expect(fail.exitCode).toBe(1);
    expect(fail.stderrTail).toBe('Error: No transcript available for this video');
  });

  it('kills a hanging child after the timeout', async () => {
    const r = await runSummarize({ bin: FAKE, args: ['u'], timeoutMs: 400, graceMs: 300, env: { FAKE_SUMMARIZE_MODE: 'hang' } });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    expect(r.durationMs).toBeLessThan(5_000);
  });

  it('kills the child when the abort signal fires', async () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 150);
    const r = await runSummarize({ bin: FAKE, args: ['u'], timeoutMs: 10_000, graceMs: 300, signal: c.signal, env: { FAKE_SUMMARIZE_MODE: 'hang' } });
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it('reports a missing binary as a spawn error', async () => {
    const r = await runSummarize({ bin: '/definitely/not/here/summarize', args: ['u'], timeoutMs: 1_000 });
    expect(r.spawnError?.code).toBe('ENOENT');
  });

  it('checkSummarizeVersion accepts >= 0.23.0 and rejects older or missing binaries', async () => {
    expect(await checkSummarizeVersion(FAKE)).toMatchObject({ ok: true, version: '0.23.1' });
    process.env.FAKE_SUMMARIZE_VERSION = '0.22.9 (abcdef12)';
    const old = await checkSummarizeVersion(FAKE);
    expect(old).toMatchObject({ ok: false, version: '0.22.9' });
    expect(!old.ok && old.error).toMatch(/too old/);
    const missing = await checkSummarizeVersion('/nope/summarize');
    expect(!missing.ok && missing.error).toMatch(/not found on PATH/);
  });
});

describe('versions', () => {
  it('parses and compares', () => {
    expect(parseVersion('0.23.1 (abcdef12)')).toBe('0.23.1');
    expect(parseVersion('summarize 1.2.3')).toBe('1.2.3');
    expect(parseVersion('nope')).toBeNull();
    expect(compareVersions('0.23.1', '0.23.0')).toBe(1);
    expect(compareVersions('0.9.9', '0.23.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});
