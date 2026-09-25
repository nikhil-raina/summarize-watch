import fs from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { SourceType, TranscriptMode } from './config.js';
import type { Envelope } from './summarizer.js';
import { formatDuration } from './util.js';

// ---------- filenames ----------

const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

/** Filesystem- and Obsidian-safe slug. Lowercase so case-insensitive volumes cannot collide. */
export function slugify(title: string | null | undefined, fallback: string, maxLen = 80): string {
  let s = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (s.length > maxLen) {
    const cut = s.slice(0, maxLen);
    const atWord = cut.lastIndexOf(' ');
    s = (atWord > maxLen / 2 ? cut.slice(0, atWord) : cut).trim();
  }
  s = s.replace(/[. ]+$/g, '').trim();
  return s || fallback.replace(FORBIDDEN, '-').replace(/-+/g, '-').toLowerCase();
}

export function localDateStamp(iso: string | null | undefined, fallbackIso: string): string {
  const d = new Date(iso ?? fallbackIso);
  const use = Number.isNaN(d.getTime()) ? new Date(fallbackIso) : d;
  const y = use.getFullYear();
  const m = String(use.getMonth() + 1).padStart(2, '0');
  const day = String(use.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Pick a note filename (relative to the notes dir). `ownerOf(rel)` returns the item id that owns an
 * existing file, or null when unknown; a file owned by this same item is reused (retry overwrites).
 */
export function noteFilename(
  notesDir: string,
  base: string,
  ownItemId: number,
  ownerOf: (relPath: string) => number | null,
): string {
  let candidate = `${base}.md`;
  for (let n = 2; n < 1000; n++) {
    const abs = path.join(notesDir, candidate);
    if (!fs.existsSync(abs)) return candidate;
    if (ownerOf(candidate) === ownItemId) return candidate;
    candidate = `${base} (${n}).md`;
  }
  return `${base} (${Date.now()}).md`;
}

// ---------- notes ----------

export interface NoteItem {
  id: number;
  title: string | null;
  url: string;
  publishedAt: string | null;
  discoveredAt: string;
  sourceName: string;
  sourceType: SourceType;
  externalId: string;
}

export interface NoteInput {
  item: NoteItem;
  tags: string[];
  envelope: Envelope;
  summarized: boolean;
  model: string | null;
  provider: string | null;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  transcriptMode: TranscriptMode;
}

export interface NotePaths {
  outputDir: string;
  transcriptsDir: string;
}

export interface WrittenNote {
  /** relative to outputDir */
  notePath: string;
  /** relative to outputDir, or null */
  transcriptPath: string | null;
  absNotePath: string;
  title: string;
}

export function writeNote(paths: NotePaths, input: NoteInput, noteRel: string): WrittenNote {
  const { item, envelope } = input;
  const title = (envelope.extracted.title ?? item.title ?? item.externalId).trim();
  const body = input.summarized ? (envelope.summary ?? '') : envelope.extracted.content;
  const wantsTranscript = shouldWriteTranscript(input.transcriptMode, item.sourceType, envelope);
  const transcriptRel = wantsTranscript && input.transcriptMode !== 'inline' ? path.join(path.basename(paths.transcriptsDir), noteRel) : null;

  const frontmatter: Record<string, unknown> = {
    title,
    source: item.sourceName,
    source_type: item.sourceType,
    url: item.url,
    published: item.publishedAt ?? undefined,
    summarized_at: new Date().toISOString(),
    summarized: input.summarized,
    model: input.model ?? undefined,
    provider: input.provider ?? undefined,
    tokens_prompt: input.tokensPrompt ?? undefined,
    tokens_completion: input.tokensCompletion ?? undefined,
    duration_seconds: envelope.extracted.mediaDurationSeconds ?? undefined,
    transcript_source: envelope.extracted.transcriptSource ?? undefined,
    transcript: transcriptRel ?? undefined,
    tags: input.tags,
    summarize_watch_id: item.id,
  };
  for (const k of Object.keys(frontmatter)) if (frontmatter[k] === undefined) delete frontmatter[k];

  const headerBits = [`[${item.sourceName}](${item.url})`];
  if (item.publishedAt) headerBits.push(`published ${item.publishedAt.slice(0, 10)}`);
  const dur = envelope.extracted.mediaDurationSeconds;
  if (dur && dur > 0) headerBits.push(formatDuration(dur * 1000));
  if (!input.summarized) headerBits.push('filed verbatim (too short to summarize)');

  let text = `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n# ${title}\n${headerBits.join(' · ')}\n\n${body.trim()}\n`;
  if (wantsTranscript && input.transcriptMode === 'inline') {
    text += `\n## Transcript\n\n${envelope.extracted.content.trim()}\n`;
  }

  const absNotePath = path.join(paths.outputDir, noteRel);
  fs.mkdirSync(path.dirname(absNotePath), { recursive: true });
  fs.writeFileSync(absNotePath, text, 'utf8');

  if (transcriptRel) {
    const absTranscript = path.join(paths.transcriptsDir, noteRel);
    fs.mkdirSync(path.dirname(absTranscript), { recursive: true });
    const tfm = stringifyYaml({
      title,
      url: item.url,
      note: `[[${noteRel.replace(/\.md$/, '')}]]`,
      characters: envelope.extracted.content.length,
      transcript_source: envelope.extracted.transcriptSource ?? undefined,
    }).trimEnd();
    fs.writeFileSync(absTranscript, `---\n${tfm}\n---\n# ${title} (transcript)\n\n${envelope.extracted.content.trim()}\n`, 'utf8');
  }
  return { notePath: noteRel, transcriptPath: transcriptRel, absNotePath, title };
}

export function shouldWriteTranscript(mode: TranscriptMode, sourceType: SourceType, env: Envelope): boolean {
  if (mode === 'none') return false;
  if (mode === 'all' || mode === 'inline') return true;
  // media: youtube/podcast sources, or anything summarize transcribed
  return sourceType === 'youtube' || sourceType === 'podcast' || Boolean(env.extracted.video) || Boolean(env.extracted.transcriptSource);
}

// ---------- excerpts ----------

export function excerpt(summary: string, maxChars = 200): string {
  const cleaned = summary
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l)) // headings say what a section is, not what it says
    .map((l) => l.replace(/^\s*([-*+]\s+|\d+[.)]\s+|>\s+)/, '').trim())
    .filter((l) => l && !/^[-*_]{3,}$/.test(l))
    .join(' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(cleaned);
  let out = m?.[1] ?? cleaned;
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trimEnd()}…`;
  return out;
}

// ---------- digest ----------

export interface DigestEntry {
  title: string;
  noteRel: string;
  url: string;
  excerpt: string;
  verbatim: boolean;
}

export interface DigestFailure {
  source: string;
  title: string;
  url: string;
  kind: string;
  error: string;
  attempts: number;
  nextAttemptAt: string | null;
}

export interface DigestSection {
  runId: number | null;
  startedAt: string;
  finishedAt: string;
  model: string | null;
  bySource: Map<string, DigestEntry[]>;
  failed: DigestFailure[];
  skipped: Record<string, number>;
  totals: { processed: number; done: number; verbatim: number; failed: number; skipped: number; tokensPrompt: number; tokensCompletion: number };
}

export function digestFilename(startedAt: string): string {
  return `${localDateStamp(startedAt, startedAt)}.md`;
}

/** Append one run section to today's digest, creating the file (with frontmatter) on first use. Returns the absolute path. */
export function appendDigest(digestsDir: string, section: DigestSection): string {
  fs.mkdirSync(digestsDir, { recursive: true });
  const file = path.join(digestsDir, digestFilename(section.startedAt));
  const date = localDateStamp(section.startedAt, section.startedAt);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `---\n${stringifyYaml({ date, summarize_watch: 'digest', tags: ['summarize-watch', 'digest'] }).trimEnd()}\n---\n# Digest ${date}\n`, 'utf8');
  }
  fs.appendFileSync(file, `\n${renderDigestSection(section)}`, 'utf8');
  return file;
}

function localClock(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderDigestSection(s: DigestSection): string {
  const hm = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const lines: string[] = [`## Run ${hm(s.startedAt)} → ${hm(s.finishedAt)}${s.runId ? ` (#${s.runId})` : ''}`];
  const sources = [...s.bySource.entries()].filter(([, entries]) => entries.length).sort(([a], [b]) => a.localeCompare(b));
  if (!sources.length && !s.failed.length) lines.push('', '_Nothing new._');
  for (const [source, entries] of sources) {
    lines.push('', `### ${source} (${entries.length})`);
    for (const e of entries) {
      const link = `[[${e.noteRel.replace(/\.md$/, '')}|${e.title.replace(/[|\]]/g, ' ')}]]`;
      const tailText = e.excerpt ? ` — ${e.excerpt}` : '';
      lines.push(`- ${link}${e.verbatim ? ' (verbatim)' : ''}${tailText}`);
    }
  }
  if (s.failed.length) {
    lines.push('', `### Failed (${s.failed.length})`);
    for (const f of s.failed) {
      const retry = f.nextAttemptAt ? `retry ${localClock(f.nextAttemptAt)}` : 'gave up';
      lines.push(`- ${f.source} · [${f.title.replace(/[[\]]/g, '')}](${f.url}) — ${f.kind}: ${f.error} (attempt ${f.attempts}, ${retry})`);
    }
  }
  const skippedTotal = Object.values(s.skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal) {
    lines.push('', `### Skipped (${skippedTotal})`);
    for (const [reason, n] of Object.entries(s.skipped).sort()) lines.push(`- ${n} ${reason}`);
  }
  const t = s.totals;
  const tokens = t.tokensPrompt || t.tokensCompletion ? ` · ${t.tokensPrompt.toLocaleString('en-US')} / ${t.tokensCompletion.toLocaleString('en-US')} tokens` : '';
  const model = s.model ? ` · ${s.model}` : '';
  lines.push('', `**Totals:** ${t.processed} processed · ${t.done} done${t.verbatim ? ` · ${t.verbatim} verbatim` : ''} · ${t.failed} failed · ${t.skipped} skipped${tokens}${model}`, '');
  return lines.join('\n');
}
