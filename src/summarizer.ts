import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { EffectiveSummarize } from './config.js';
import { stripAnsi, tail } from './util.js';

export const MIN_SUMMARIZE_VERSION = '0.23.0';

// ---------- envelope ----------

// Only the fields we read; everything else passes through so upstream additions never break us.
export const EnvelopeSchema = z
  .object({
    input: z.object({ url: z.string().optional() }).passthrough().optional(),
    extracted: z
      .object({
        // URL flow: url/title/content/...; asset flow (direct audio, local files): kind/source/filename/mediaType
        kind: z.string().optional(),
        source: z.string().optional(),
        filename: z.string().optional(),
        mediaType: z.string().optional(),
        url: z.string().optional(),
        title: z.string().nullable().optional(),
        content: z.string().optional(),
        wordCount: z.number().optional(),
        transcriptSource: z.string().nullable().optional(),
        transcriptionProvider: z.string().nullable().optional(),
        mediaDurationSeconds: z.number().nullable().optional(),
        video: z.object({ kind: z.string(), url: z.string().optional() }).passthrough().nullable().optional(),
      })
      .passthrough(),
    llm: z.object({ provider: z.string(), model: z.string() }).passthrough().nullable(),
    metrics: z
      .object({
        llm: z
          .array(
            z
              .object({
                provider: z.string().optional(),
                model: z.string().optional(),
                promptTokens: z.number().optional(),
                completionTokens: z.number().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    prompt: z.string().nullable().optional(),
    summary: z.string().nullable(),
  })
  .passthrough();

type RawEnvelope = z.infer<typeof EnvelopeSchema>;

/** Parsed envelope with `extracted.content` guaranteed (possibly empty). */
export type Envelope = RawEnvelope & { extracted: RawEnvelope['extracted'] & { content: string } };

/**
 * The direct-media ("asset") flow omits the text from `extracted` in summary mode; the transcript
 * is only present inside the prompt as `<content>\n…\n</content>` (upstream prompts/format.ts).
 * A leading "Transcript:" label is dropped.
 */
export function contentFromPrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const start = prompt.indexOf('<content>\n');
  const end = prompt.lastIndexOf('</content>');
  if (start < 0 || end < 0 || end <= start) return null;
  let body = prompt.slice(start + '<content>\n'.length, end).replace(/\n$/, '');
  body = body.replace(/^Transcript:\n/, '');
  return body.trim() ? body : null;
}

export function normalizeEnvelope(raw: RawEnvelope): Envelope {
  const extracted = { ...raw.extracted };
  if (typeof extracted.content !== 'string') {
    extracted.content = contentFromPrompt(raw.prompt) ?? '';
    if (!extracted.transcriptSource && extracted.kind === 'asset' && /\(transcript\)$/.test(extracted.source ?? '')) {
      extracted.transcriptSource = 'transcription';
    }
  }
  return { ...raw, extracted: extracted as Envelope['extracted'] };
}

export function sumTokens(env: Envelope): { prompt: number; completion: number } {
  let prompt = 0;
  let completion = 0;
  for (const m of env.metrics?.llm ?? []) {
    prompt += m.promptTokens ?? 0;
    completion += m.completionTokens ?? 0;
  }
  return { prompt, completion };
}

export type ParsedEnvelope = { ok: true; envelope: Envelope } | { ok: false; error: string };

export function parseEnvelope(stdout: string): ParsedEnvelope {
  const attempts: string[] = [stdout];
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < stdout.length - 1)) {
    if (first >= 0 && last > first) attempts.push(stdout.slice(first, last + 1));
  }
  let lastError = 'stdout is empty';
  for (const text of attempts) {
    if (!text.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      lastError = `stdout is not JSON: ${(e as Error).message}`;
      continue;
    }
    const parsed = EnvelopeSchema.safeParse(raw);
    if (parsed.success) return { ok: true, envelope: normalizeEnvelope(parsed.data) };
    lastError = `envelope shape changed: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`;
  }
  return { ok: false, error: lastError };
}

// ---------- argv ----------

export function buildArgs(url: string, s: EffectiveSummarize): string[] {
  const args = [url, '--json', '--format', 'md', '--metrics', 'on', '--timeout', s.timeout];
  if (s.cli) args.push('--cli', s.cli);
  else if (s.model) args.push('--model', s.model);
  if (s.language) args.push('--language', s.language);
  if (s.length) args.push('--length', s.length);
  if (s.prompt) args.push('--prompt', s.prompt);
  if (s.noCache) args.push('--no-cache');
  args.push(...s.extraArgs);
  return args;
}

// ---------- spawning ----------

export interface RawResult {
  spawnError?: NodeJS.ErrnoException;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface RunSummarizeOptions {
  bin: string;
  args: string[];
  /** Hard kill after this many ms (summarize's own --timeout should be shorter). */
  timeoutMs: number;
  /** SIGKILL this long after SIGTERM. */
  graceMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Abort (Ctrl-C) support: kills the child the same way a timeout does. */
  signal?: AbortSignal;
  stderrTailChars?: number;
}

export function runSummarize(opts: RunSummarizeOptions): Promise<RawResult> {
  const started = Date.now();
  const graceMs = opts.graceMs ?? 5_000;
  return new Promise<RawResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let forceTimer: NodeJS.Timeout | null = null;

    const child = spawn(opts.bin, opts.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', SUMMARIZE_LOCALE: 'en', ...(opts.env ?? {}) },
      shell: false,
    });

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, graceMs);
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    killTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);

    const finish = (result: Omit<RawResult, 'stdout' | 'stderrTail' | 'timedOut' | 'aborted' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        ...result,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderrTail: tail(stripAnsi(Buffer.concat(stderr).toString('utf8')), opts.stderrTailChars ?? 2_000),
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      });
    };

    child.stdout?.on('data', (b: Buffer) => stdout.push(b));
    child.stderr?.on('data', (b: Buffer) => stderr.push(b));
    child.on('error', (err: NodeJS.ErrnoException) => finish({ spawnError: err, exitCode: null, signal: null }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
  });
}

// ---------- classification ----------

export type Outcome =
  | { kind: 'summarized'; envelope: Envelope; tokensPrompt: number; tokensCompletion: number }
  | { kind: 'short_verbatim'; envelope: Envelope }
  | { kind: 'not_summarized'; envelope: Envelope; error: string }
  | { kind: 'failed_exit'; exitCode: number | null; error: string }
  | { kind: 'timeout'; error: string }
  | { kind: 'aborted'; error: string }
  | { kind: 'invalid_envelope'; error: string; rawStdout: string }
  | { kind: 'spawn_error'; error: string };

export type OutcomeKind = Outcome['kind'];

export function classify(raw: RawResult, opts: { shortContentChars: number }): Outcome {
  if (raw.spawnError) {
    const code = raw.spawnError.code;
    const hint = code === 'ENOENT' ? ' (is summarize installed and on PATH? try `brew install summarize`)' : '';
    return { kind: 'spawn_error', error: `cannot start summarize: ${raw.spawnError.message}${hint}` };
  }
  if (raw.aborted) return { kind: 'aborted', error: 'run interrupted' };
  if (raw.timedOut) return { kind: 'timeout', error: `killed after ${Math.round(raw.durationMs / 1000)}s (summarize did not finish in time)` };
  if (raw.exitCode !== 0) {
    const detail = raw.stderrTail || (raw.signal ? `terminated by ${raw.signal}` : `exit ${raw.exitCode}`);
    return { kind: 'failed_exit', exitCode: raw.exitCode, error: lastLine(detail) };
  }
  const parsed = parseEnvelope(raw.stdout);
  if (!parsed.ok) return { kind: 'invalid_envelope', error: parsed.error, rawStdout: raw.stdout };
  const env = parsed.envelope;
  const summary = env.summary;
  const content = env.extracted.content;
  const noSummary = env.llm === null || summary === null || summary.trim() === '' || summary === content;
  if (noSummary) {
    if (!content.trim()) return { kind: 'not_summarized', envelope: env, error: 'summarize returned neither a summary nor extracted content' };
    if (content.length < opts.shortContentChars) return { kind: 'short_verbatim', envelope: env };
    const why =
      env.llm === null
        ? 'summarize returned no LLM summary (llm: null): every configured model failed or none is configured'
        : 'summarize returned an empty summary';
    return { kind: 'not_summarized', envelope: env, error: why };
  }
  const tokens = sumTokens(env);
  return { kind: 'summarized', envelope: env, tokensPrompt: tokens.prompt, tokensCompletion: tokens.completion };
}

/**
 * The most informative line of a stderr tail. summarize often ends with a numbered list of options
 * and a "See: summarize transcriber help" pointer; the line that says what went wrong comes first.
 */
export function summarizeErrorLine(stderrTail: string): string {
  const lines = stderrTail.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const isHint = (l: string) => /^(\d+[.)]\s|See:|Set [A-Z_]+=|brew |npm |Ensure |Install |Configure |Or |Options?:?$)/i.test(l);
  const candidates = lines.filter((l) => !isHint(l));
  const informative = candidates.find((l) => /error|fail|no (transcription|transcript|model|provider|caption)|not (found|available|supported|configured)|unable|cannot|could not|missing|unsupported|timed out|blocked|denied|forbidden|429|403/i.test(l));
  let picked = informative ?? candidates[candidates.length - 1] ?? lines[lines.length - 1] ?? '';
  const see = lines.find((l) => /^See:/i.test(l));
  if (see && picked !== see && !picked.includes(see)) picked = `${picked} (${see})`;
  return picked.length > 300 ? `${picked.slice(0, 299)}…` : picked;
}

const lastLine = summarizeErrorLine;

// ---------- version ----------

export function parseVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type VersionCheck = { ok: true; version: string; bin: string } | { ok: false; error: string; version?: string; bin: string };

export async function checkSummarizeVersion(bin: string, minimum: string = MIN_SUMMARIZE_VERSION): Promise<VersionCheck> {
  const raw = await runSummarize({ bin, args: ['--version'], timeoutMs: 15_000 });
  if (raw.spawnError) {
    const hint = raw.spawnError.code === 'ENOENT' ? `"${bin}" not found on PATH. Install with \`brew install summarize\` or \`npm i -g @steipete/summarize\`, or set summarize.bin.` : raw.spawnError.message;
    return { ok: false, error: hint, bin };
  }
  if (raw.exitCode !== 0) return { ok: false, error: `${bin} --version exited ${raw.exitCode}: ${raw.stderrTail}`, bin };
  const version = parseVersion(raw.stdout) ?? parseVersion(raw.stderrTail);
  if (!version) return { ok: false, error: `could not parse version from "${raw.stdout.trim()}"`, bin };
  if (compareVersions(version, minimum) < 0) {
    return { ok: false, version, error: `summarize ${version} is too old; need >= ${minimum} (brew upgrade summarize)`, bin };
  }
  return { ok: true, version, bin };
}
