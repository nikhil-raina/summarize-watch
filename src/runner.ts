import fs from 'node:fs';
import type { EffectiveSource, LoadedConfig } from './config.js';
import { fetchText } from './feeds/fetch.js';
import { type FeedItem, parseFeed } from './feeds/parse.js';
import { appendDigest, type DigestEntry, type DigestFailure, type DigestSection, excerpt, localDateStamp, noteFilename, slugify, writeNote } from './notes.js';
import type { ItemRow, ItemStatus, State } from './state.js';
import { isOllamaModel, ollamaWarmUp } from './ollama.js';
import { buildArgs, checkSummarizeVersion, classify, type Outcome, runSummarize } from './summarizer.js';
import { formatDuration, log, nextAttemptAt, parseDuration } from './util.js';

export interface RunOptions {
  dryRun?: boolean;
  sourceFilter?: string;
  limit?: number;
  /** Ctrl-C support. */
  signal?: AbortSignal;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Extra time after summarize's own --timeout before we SIGTERM it (default 30s). */
  killGraceMs?: number;
  /** Skip the Ollama warm-up request (tests). */
  skipWarmUp?: boolean;
}

export interface PollResult {
  source: EffectiveSource;
  ok: boolean;
  error: string | null;
  items: FeedItem[];
  isFirstPoll: boolean;
}

export interface ProcessedItem {
  item: ItemRow;
  outcome: Outcome;
  notePath: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  durationMs: number;
}

export interface RunReport {
  runId: number | null;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  aborted: boolean;
  polls: PollResult[];
  discovered: number;
  initialStatuses: Record<string, number>;
  selected: Array<{ item: ItemRow; args: string[]; bin: string }>;
  processed: ProcessedItem[];
  skippedAtSelection: Record<string, number>;
  digestPath: string | null;
  tokensPrompt: number;
  tokensCompletion: number;
  fatal: string | null;
}

export class RunAbortedError extends Error {
  constructor() {
    super('run aborted');
    this.name = 'RunAbortedError';
  }
}

export class RunFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunFatalError';
  }
}

export async function runOnce(loaded: LoadedConfig, state: State, opts: RunOptions = {}): Promise<RunReport> {
  const { config, paths } = loaded;
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const dryRun = Boolean(opts.dryRun);
  const report: RunReport = {
    runId: null, startedAt, finishedAt: startedAt, dryRun, aborted: false, polls: [], discovered: 0, initialStatuses: {},
    selected: [], processed: [], skippedAtSelection: {}, digestPath: null, tokensPrompt: 0, tokensCompletion: 0, fatal: null,
  };

  // ---- 1. preflight ----
  const sources = loaded.sources.filter((s) => s.enabled && (!opts.sourceFilter || s.name === opts.sourceFilter));
  if (opts.sourceFilter && !sources.length) throw new RunFatalError(`no enabled source named "${opts.sourceFilter}"`);
  if (!sources.length) throw new RunFatalError('no enabled sources in watch.yaml (add one with `summarize-watch add <url>`)');

  const bins = new Set(sources.map((s) => s.summarize.bin));
  for (const bin of bins) {
    const check = await checkSummarizeVersion(bin);
    if (!check.ok) throw new RunFatalError(check.error);
    log.debug(`summarize ${check.version} at ${bin}`);
  }

  const running = state.findRunningRun();
  if (running) {
    if (isPidAlive(running.pid)) {
      throw new RunFatalError(`another run is in progress (run #${running.id}, pid ${running.pid}, started ${running.startedAt}); wait for it or kill that process`);
    }
    state.markRunCrashed(running.id);
    log.warn(`previous run #${running.id} (pid ${running.pid}) never finished; marked crashed`);
  }

  if (!dryRun) {
    for (const dir of [paths.outputDir, paths.digestsDir, paths.transcriptsDir, paths.stateDir]) fs.mkdirSync(dir, { recursive: true });
    report.runId = state.startRun(process.pid, false, startedAt);
  }

  const backoffMs = config.run.backoff.map(parseDuration);
  const finishCounts = (status: 'completed' | 'aborted') => {
    if (report.runId === null) return;
    report.finishedAt = now().toISOString();
    state.finishRun(report.runId, status, {
      sourcesPolled: report.polls.length,
      sourcesFailed: report.polls.filter((p) => !p.ok).length,
      itemsDiscovered: report.discovered,
      itemsProcessed: report.processed.length,
      itemsDone: report.processed.filter((p) => p.outcome.kind === 'summarized' || p.outcome.kind === 'short_verbatim').length,
      itemsFailed: report.processed.filter((p) => isFailure(p.outcome)).length,
      itemsSkipped: Object.values(report.skippedAtSelection).reduce((a, b) => a + b, 0),
      tokensPrompt: report.tokensPrompt,
      tokensCompletion: report.tokensCompletion,
      digestPath: report.digestPath,
    }, report.finishedAt);
  };

  try {
    // ---- 2. poll ----
    const feedTimeoutMs = parseDuration(config.run.feed_timeout);
    const polls = await Promise.all(
      sources.map(async (source): Promise<PollResult> => {
        const row = state.upsertSource({ name: source.name, type: source.type, feedUrl: source.feedUrl }, startedAt);
        const isFirstPoll = row.lastPolledAt === null;
        try {
          const res = await fetchText(source.feedUrl, { timeoutMs: feedTimeoutMs, fetchImpl: opts.fetchImpl });
          const parsed = parseFeed(res.text, { type: source.type, prefer: source.prefer });
          if (!dryRun) state.recordPoll(row.id, true, null, parsed.items.length, now().toISOString());
          return { source, ok: true, error: null, items: parsed.items, isFirstPoll };
        } catch (e) {
          const msg = (e as Error).message;
          if (!dryRun) state.recordPoll(row.id, false, msg, null, now().toISOString());
          log.warn(`[poll ] ${source.name}: ${msg}`);
          return { source, ok: false, error: msg, items: [], isFirstPoll };
        }
      }),
    );
    report.polls = polls;
    throwIfAborted(opts.signal);

    // ---- 3. upsert ----
    for (const poll of polls) {
      if (!poll.ok) continue;
      const src = state.getSourceByName(poll.source.name);
      if (!src) continue;
      const since = resolveSince(poll.source.since, src.firstSeenAt, now());
      const sorted = [...poll.items].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
      let backfilled = 0;
      for (const fi of sorted) {
        const initial = initialStatus(fi, poll, since, backfilled);
        if (initial.viaBackfill) backfilled++;
        const res = state.upsertItem(src.id, { externalId: fi.externalId, url: fi.url, title: fi.title, publishedAt: fi.publishedAt }, initial, now().toISOString());
        if (res.inserted) {
          report.discovered++;
          const key = initial.status === 'skipped' ? `skipped:${initial.skipReason}` : initial.status;
          report.initialStatuses[key] = (report.initialStatuses[key] ?? 0) + 1;
        }
      }
    }

    // ---- 4. select ----
    const polledNames = new Set(polls.filter((p) => p.ok).map((p) => p.source.name));
    const bySource = new Map<string, EffectiveSource>(sources.map((s) => [s.name, s]));
    const due = state.selectDue(now().toISOString()).filter((i) => polledNames.has(i.sourceName));
    const perSourceCount = new Map<string, number>();
    const selected: ItemRow[] = [];
    for (const item of due) {
      const source = bySource.get(item.sourceName);
      if (!source) continue;
      const count = perSourceCount.get(item.sourceName) ?? 0;
      if (count >= source.maxPerSource) continue;
      const dup = state.findDoneByUrl(item.url);
      if (dup && dup.id !== item.id) {
        if (!dryRun) state.markSkipped(item.id, `duplicate_of:${dup.id}`, dup.notePath);
        bump(report.skippedAtSelection, 'duplicate');
        continue;
      }
      if (source.type === 'youtube' && !source.includeShorts && config.run.shorts_probe) {
        const isShort = await probeIsShort(item.externalId, opts.fetchImpl);
        if (isShort) {
          if (!dryRun) state.markSkipped(item.id, 'shorts');
          bump(report.skippedAtSelection, 'shorts');
          continue;
        }
      }
      perSourceCount.set(item.sourceName, count + 1);
      selected.push(item);
      throwIfAborted(opts.signal);
    }
    const cap = opts.limit ?? config.run.max_per_run;
    report.selected = selected.slice(0, cap).map((item) => {
      const source = bySource.get(item.sourceName) as EffectiveSource;
      return { item, args: buildArgs(item.url, source.summarize), bin: source.summarize.bin };
    });

    // ---- 5. dry run stops here ----
    if (dryRun) {
      report.finishedAt = now().toISOString();
      return report;
    }

    // ---- 6. warm up local models, then process ----
    if (!opts.skipWarmUp) {
      const ollamaModels = new Set(report.selected.map((s) => (bySource.get(s.item.sourceName) as EffectiveSource).summarize.model).filter(isOllamaModel));
      for (const model of ollamaModels) {
        log.info(`[warm ] loading ${model} into Ollama…`);
        const w = await ollamaWarmUp(model, { fetchImpl: opts.fetchImpl });
        if (w.ok) log.info(`[warm ] ${model} ready in ${formatDuration(w.ms)}`);
        else log.warn(`[warm ] ${model}: ${w.error} (continuing; the first item may fail and be retried)`);
        throwIfAborted(opts.signal);
      }
    }

    const failures: DigestFailure[] = [];
    const entries = new Map<string, DigestEntry[]>();
    let verbatim = 0;
    let done = 0;
    let index = 0;

    const processItem = async (item: ItemRow, source: EffectiveSource, args: string[]): Promise<ProcessedItem> => {
      const label = `${item.sourceName} · ${truncate(item.title ?? item.url, 60)}`;
      log.info(`[start] ${label}`);
      const raw = await runSummarize({ bin: source.summarize.bin, args, timeoutMs: source.summarize.timeoutMs + (opts.killGraceMs ?? 30_000), signal: opts.signal });
      const outcome = classify(raw, { shortContentChars: config.run.short_content_chars });
      const result: ProcessedItem = { item, outcome, notePath: null, attempts: item.attempts, nextAttemptAt: null, durationMs: raw.durationMs };

      if (outcome.kind === 'summarized' || outcome.kind === 'short_verbatim') {
        const env = outcome.envelope;
        const title = env.extracted.title ?? item.title;
        const base = `${localDateStamp(item.publishedAt, item.discoveredAt)} ${slugify(title, item.externalId)}`;
        const rel = noteFilename(paths.outputDir, base, item.id, (p) => state.findItemByNotePath(p)?.id ?? null);
        const tokensPrompt = outcome.kind === 'summarized' ? outcome.tokensPrompt : null;
        const tokensCompletion = outcome.kind === 'summarized' ? outcome.tokensCompletion : null;
        const written = writeNote(
          { outputDir: paths.outputDir, transcriptsDir: paths.transcriptsDir },
          {
            item: { id: item.id, title: item.title, url: item.url, publishedAt: item.publishedAt, discoveredAt: item.discoveredAt, sourceName: item.sourceName, sourceType: item.sourceType, externalId: item.externalId },
            tags: source.tags,
            envelope: env,
            summarized: outcome.kind === 'summarized',
            model: env.llm?.model ?? null,
            provider: env.llm?.provider ?? null,
            tokensPrompt,
            tokensCompletion,
            transcriptMode: config.output.transcripts.mode,
          },
          rel,
        );
        state.markDone(item.id, {
          notePath: written.notePath, transcriptPath: written.transcriptPath, model: env.llm?.model ?? null, provider: env.llm?.provider ?? null,
          tokensPrompt, tokensCompletion, durationSeconds: env.extracted.mediaDurationSeconds ?? null, processingMs: raw.durationMs,
          transcriptSource: env.extracted.transcriptSource ?? null, runId: report.runId,
        }, now().toISOString());
        result.notePath = written.notePath;
        report.tokensPrompt += tokensPrompt ?? 0;
        report.tokensCompletion += tokensCompletion ?? 0;
        if (outcome.kind === 'summarized') done++;
        else verbatim++;
        const list = entries.get(item.sourceName) ?? [];
        list.push({ title: written.title, noteRel: written.notePath, url: item.url, excerpt: outcome.kind === 'summarized' ? excerpt(env.summary ?? '') : '', verbatim: outcome.kind !== 'summarized' });
        entries.set(item.sourceName, list);
        const tok = tokensPrompt === null ? '' : tokensPrompt === 0 && !tokensCompletion ? ' · cached' : ` · ${(tokensPrompt / 1000).toFixed(1)}k tok`;
        log.info(`[done ] ${label}${tok} · ${formatDuration(raw.durationMs)} → ${written.notePath}`);
        return result;
      }

      if (outcome.kind === 'aborted' || outcome.kind === 'spawn_error') {
        log.warn(`[${outcome.kind === 'aborted' ? 'abort' : 'fatal'}] ${label}: ${outcome.error}`);
        return result;
      }

      // failure with backoff (never permanent)
      const attempts = item.attempts + 1;
      const next = nextAttemptAt(attempts, backoffMs, config.run.max_attempts, now());
      state.markFailed(item.id, { errorKind: outcome.kind, error: outcome.error, attempts, nextAttemptAt: next, runId: report.runId });
      result.attempts = attempts;
      result.nextAttemptAt = next;
      if (outcome.kind === 'invalid_envelope') {
        fs.mkdirSync(paths.stateDir, { recursive: true });
        fs.writeFileSync(paths.lastInvalidPath, JSON.stringify({ at: now().toISOString(), itemId: item.id, url: item.url, bin: source.summarize.bin, args, error: outcome.error, stdout: outcome.rawStdout }, null, 2));
      }
      failures.push({ source: item.sourceName, title: item.title ?? item.url, url: item.url, kind: outcome.kind, error: outcome.error, attempts, nextAttemptAt: next });
      log.warn(`[fail ] ${label} · ${outcome.kind} · ${outcome.error} · ${next ? `retry ${next.slice(11, 16)}` : 'gave up'}`);
      return result;
    };

    const worker = async () => {
      while (index < report.selected.length) {
        if (opts.signal?.aborted) return;
        const job = report.selected[index++];
        if (!job) return;
        const source = bySource.get(job.item.sourceName) as EffectiveSource;
        const processed = await processItem(job.item, source, job.args);
        report.processed.push(processed);
        if (processed.outcome.kind === 'spawn_error') throw new RunFatalError(processed.outcome.error);
        if (processed.outcome.kind === 'aborted') return;
      }
    };

    const workers = Array.from({ length: Math.max(1, Math.min(config.run.concurrency, report.selected.length)) }, worker);
    await Promise.all(workers);
    report.aborted = Boolean(opts.signal?.aborted);

    // ---- 7. digest ----
    report.finishedAt = now().toISOString();
    const section: DigestSection = {
      runId: report.runId,
      startedAt,
      finishedAt: report.finishedAt,
      model: mostCommonModel(report.processed),
      bySource: entries,
      failed: failures,
      skipped: report.skippedAtSelection,
      totals: {
        processed: report.processed.filter((p) => p.outcome.kind !== 'aborted').length,
        done, verbatim, failed: failures.length,
        skipped: Object.values(report.skippedAtSelection).reduce((a, b) => a + b, 0),
        tokensPrompt: report.tokensPrompt, tokensCompletion: report.tokensCompletion,
      },
    };
    if (section.totals.processed > 0 || section.totals.skipped > 0) {
      report.digestPath = appendDigest(paths.digestsDir, section);
    }
    finishCounts(report.aborted ? 'aborted' : 'completed');
    return report;
  } catch (e) {
    report.finishedAt = now().toISOString();
    if (e instanceof RunAbortedError) {
      report.aborted = true;
      finishCounts('aborted');
      return report;
    }
    report.fatal = (e as Error).message;
    finishCounts('aborted');
    throw e;
  }
}

// ---------- helpers ----------

/** Order matters: a feed-flagged Short is never wanted; then backfill (newest N on the first poll) beats `since`. */
function initialStatus(fi: FeedItem, poll: PollResult, since: Date | null, backfilled: number): { status: ItemStatus; skipReason?: string | null; viaBackfill?: boolean } {
  if (!fi.url) return { status: 'skipped', skipReason: 'no_url' };
  if (poll.source.type === 'youtube' && !poll.source.includeShorts && fi.isShortHint) return { status: 'skipped', skipReason: 'shorts' };
  if (poll.isFirstPoll && backfilled < poll.source.backfill) return { status: 'pending', viaBackfill: true };
  if (since && fi.publishedAt && new Date(fi.publishedAt) < since) return { status: 'skipped', skipReason: 'before_since' };
  return { status: 'pending' };
}

/** first_run → the source's first_seen_at; all → null; ISO → that instant; duration → now - d. */
export function resolveSince(since: string, firstSeenAt: string, now: Date): Date | null {
  if (since === 'all') return null;
  if (since === 'first_run') return new Date(firstSeenAt);
  if (/^\d+(ms|s|m|h|d)$/.test(since)) return new Date(now.getTime() - parseDuration(since));
  const d = new Date(since);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A Short serves 200 at /shorts/<id>; a normal video redirects (3xx) to /watch. Any doubt → not a Short. */
export async function probeIsShort(videoId: string, fetchImpl?: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchText(`https://www.youtube.com/shorts/${videoId}`, {
      timeoutMs: 5_000, redirect: 'manual', fetchImpl, accept: 'text/html', headers: { cookie: 'CONSENT=YES+1' },
    });
    if (res.status >= 300 && res.status < 400) return false;
    return res.status === 200;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isFailure(o: Outcome): boolean {
  return o.kind === 'not_summarized' || o.kind === 'failed_exit' || o.kind === 'timeout' || o.kind === 'invalid_envelope';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunAbortedError();
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function mostCommonModel(processed: ProcessedItem[]): string | null {
  const counts = new Map<string, number>();
  for (const p of processed) {
    if (p.outcome.kind !== 'summarized') continue;
    const m = modelLabel(p.outcome.envelope.llm);
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** "ollama/qwen3:14b" whether summarize reports model as "qwen3:14b" or already prefixed. */
export function modelLabel(llm: { provider: string; model: string } | null | undefined): string | null {
  if (!llm) return null;
  return llm.model.includes('/') ? llm.model : `${llm.provider}/${llm.model}`;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

// ---------- report rendering ----------

export function renderReport(report: RunReport): string {
  const ms = new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime();
  const when = `${localStamp(report.startedAt)} → ${localStamp(report.finishedAt).slice(11)} (${formatDuration(Math.max(ms, 0))})`;
  const lines: string[] = [];
  lines.push(`summarize-watch ${report.dryRun ? 'dry run' : `run${report.runId ? ` #${report.runId}` : ''}`} · ${when}${report.aborted ? ' · ABORTED' : ''}`);
  const failedPolls = report.polls.filter((p) => !p.ok);
  lines.push(`sources  ${report.polls.length} polled${failedPolls.length ? ` · ${failedPolls.length} failed (${failedPolls.map((p) => `${p.source.name}: ${p.error}`).join('; ')})` : ''}`);
  const init = Object.entries(report.initialStatuses).map(([k, v]) => `${v} ${k}`).join(', ');
  if (report.dryRun) {
    lines.push(`items    ${report.discovered} newly discovered${init ? ` (${init})` : ''} · ${report.selected.length} would be processed`);
    for (const s of report.selected) {
      lines.push(`  ${s.item.sourceName} · ${truncate(s.item.title ?? s.item.url, 70)}`);
      lines.push(`    ${s.bin} ${s.args.map(shellQuote).join(' ')}`);
    }
    const sk = Object.entries(report.skippedAtSelection).map(([k, v]) => `${v} ${k}`).join(', ');
    if (sk) lines.push(`skipped  ${sk}`);
    return lines.join('\n');
  }
  const done = report.processed.filter((p) => p.outcome.kind === 'summarized').length;
  const verbatim = report.processed.filter((p) => p.outcome.kind === 'short_verbatim').length;
  const failed = report.processed.filter((p) => isFailure(p.outcome));
  const skipped = Object.entries(report.skippedAtSelection).map(([k, v]) => `${v} ${k}`).join(', ');
  lines.push(
    `items    ${report.discovered} discovered${init ? ` (${init})` : ''} · ${report.processed.length} processed → ${done} done${verbatim ? ` · ${verbatim} verbatim` : ''} · ${failed.length} failed${skipped ? ` · skipped ${skipped}` : ''}`,
  );
  if (report.tokensPrompt || report.tokensCompletion) {
    const model = mostCommonModel(report.processed);
    lines.push(`tokens   ${report.tokensPrompt.toLocaleString('en-US')} prompt / ${report.tokensCompletion.toLocaleString('en-US')} completion${model ? ` · ${model}` : ''}`);
  }
  if (report.digestPath) lines.push(`digest   ${report.digestPath}`);
  if (failed.length) {
    lines.push('failed');
    for (const f of failed) {
      const o = f.outcome as Extract<Outcome, { error: string }>;
      lines.push(`  #${f.item.id} ${f.item.sourceName} · ${truncate(f.item.title ?? f.item.url, 50)} · ${o.kind} · ${truncate(o.error, 90)} · ${f.nextAttemptAt ? `retry ${localStamp(f.nextAttemptAt)}` : 'gave up'}`);
    }
  }
  return lines.join('\n');
}

/** "2026-09-25 16:27" in the machine's local time. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+?&-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
