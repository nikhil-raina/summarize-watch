import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SourceType } from './config.js';
import { nowIso } from './util.js';

// This is the only module that touches node:sqlite. Import it lazily (await import) from
// command handlers so the ExperimentalWarning patch in cli.ts / bin runs first on Node 22.

export type ItemStatus = 'pending' | 'done' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'completed' | 'aborted' | 'crashed';

export interface SourceRow {
  id: number;
  name: string;
  type: SourceType;
  feedUrl: string;
  firstSeenAt: string;
  lastPolledAt: string | null;
  lastPollOk: boolean | null;
  lastPollError: string | null;
  lastPollItems: number | null;
}

export interface ItemRow {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceType: SourceType;
  externalId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  status: ItemStatus;
  skipReason: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lastErrorKind: string | null;
  notePath: string | null;
  transcriptPath: string | null;
  model: string | null;
  provider: string | null;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  durationSeconds: number | null;
  processingMs: number | null;
  transcriptSource: string | null;
  summarizedAt: string | null;
  lastRunId: number | null;
}

export interface RunRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  pid: number;
  status: RunStatus;
  dryRun: boolean;
  sourcesPolled: number;
  sourcesFailed: number;
  itemsDiscovered: number;
  itemsProcessed: number;
  itemsDone: number;
  itemsFailed: number;
  itemsSkipped: number;
  tokensPrompt: number;
  tokensCompletion: number;
  digestPath: string | null;
}

export interface RunCounts {
  sourcesPolled?: number;
  sourcesFailed?: number;
  itemsDiscovered?: number;
  itemsProcessed?: number;
  itemsDone?: number;
  itemsFailed?: number;
  itemsSkipped?: number;
  tokensPrompt?: number;
  tokensCompletion?: number;
  digestPath?: string | null;
}

export interface NewItem {
  externalId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
}

export interface DoneFields {
  notePath: string | null;
  transcriptPath: string | null;
  model: string | null;
  provider: string | null;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  durationSeconds: number | null;
  processingMs: number;
  transcriptSource: string | null;
  runId: number | null;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  INSERT INTO schema_version (version) VALUES (0);

  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('youtube','podcast','rss')),
    feed_url TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_polled_at TEXT,
    last_poll_ok INTEGER,
    last_poll_error TEXT,
    last_poll_items INTEGER
  );

  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    external_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    published_at TEXT,
    discovered_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','skipped')),
    skip_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    last_error_kind TEXT,
    note_path TEXT,
    transcript_path TEXT,
    model TEXT,
    provider TEXT,
    tokens_prompt INTEGER,
    tokens_completion INTEGER,
    duration_seconds REAL,
    processing_ms INTEGER,
    transcript_source TEXT,
    summarized_at TEXT,
    last_run_id INTEGER,
    UNIQUE (source_id, external_id)
  );
  CREATE INDEX items_due ON items (status, next_attempt_at);
  CREATE INDEX items_url ON items (url);

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    pid INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','aborted','crashed')),
    dry_run INTEGER NOT NULL DEFAULT 0,
    sources_polled INTEGER NOT NULL DEFAULT 0,
    sources_failed INTEGER NOT NULL DEFAULT 0,
    items_discovered INTEGER NOT NULL DEFAULT 0,
    items_processed INTEGER NOT NULL DEFAULT 0,
    items_done INTEGER NOT NULL DEFAULT 0,
    items_failed INTEGER NOT NULL DEFAULT 0,
    items_skipped INTEGER NOT NULL DEFAULT 0,
    tokens_prompt INTEGER NOT NULL DEFAULT 0,
    tokens_completion INTEGER NOT NULL DEFAULT 0,
    digest_path TEXT,
    notes TEXT
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

type Row = Record<string, unknown>;

export class State {
  private constructor(readonly db: DatabaseSync, readonly path: string) {}

  static open(dbPath: string): State {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const state = new State(db, dbPath);
    state.migrate();
    return state;
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    const has = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`).get();
    if (!has) return 0;
    const row = this.db.prepare('SELECT version FROM schema_version').get() as Row | undefined;
    return Number(row?.version ?? 0);
  }

  private migrate(): void {
    const current = this.schemaVersion();
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`UPDATE schema_version SET version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  // ---------- sources ----------

  upsertSource(spec: { name: string; type: SourceType; feedUrl: string }, now: string = nowIso()): SourceRow {
    this.db
      .prepare(`INSERT INTO sources (name, type, feed_url, first_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET type = excluded.type, feed_url = excluded.feed_url`)
      .run(spec.name, spec.type, spec.feedUrl, now);
    return this.getSourceByName(spec.name) as SourceRow;
  }

  getSourceByName(name: string): SourceRow | null {
    const row = this.db.prepare('SELECT * FROM sources WHERE name = ?').get(name) as Row | undefined;
    return row ? toSource(row) : null;
  }

  listSources(): SourceRow[] {
    return (this.db.prepare('SELECT * FROM sources ORDER BY name').all() as Row[]).map(toSource);
  }

  recordPoll(sourceId: number, ok: boolean, error: string | null, itemCount: number | null, now: string = nowIso()): void {
    this.db
      .prepare('UPDATE sources SET last_polled_at = ?, last_poll_ok = ?, last_poll_error = ?, last_poll_items = ? WHERE id = ?')
      .run(now, ok ? 1 : 0, error, itemCount, sourceId);
  }

  // ---------- items ----------

  /** Insert if unseen. Existing rows are left untouched (never downgrades done/failed). */
  upsertItem(
    sourceId: number,
    item: NewItem,
    initial: { status: ItemStatus; skipReason?: string | null },
    now: string = nowIso(),
  ): { id: number; inserted: boolean; status: ItemStatus } {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO items (source_id, external_id, url, title, published_at, discovered_at, status, skip_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sourceId, item.externalId, item.url, item.title, item.publishedAt, now, initial.status, initial.skipReason ?? null);
    const row = this.db
      .prepare('SELECT id, status FROM items WHERE source_id = ? AND external_id = ?')
      .get(sourceId, item.externalId) as Row;
    return { id: Number(row.id), inserted: Number(result.changes) > 0, status: row.status as ItemStatus };
  }

  getItem(id: number): ItemRow | null {
    const row = this.db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as Row | undefined;
    return row ? toItem(row) : null;
  }

  findDoneByUrl(url: string): ItemRow | null {
    const row = this.db.prepare(`${ITEM_SELECT} WHERE i.url = ? AND i.status = 'done' ORDER BY i.id LIMIT 1`).get(url) as Row | undefined;
    return row ? toItem(row) : null;
  }

  /** Pending items plus failed items whose retry time has come. Newest first. */
  selectDue(now: string = nowIso()): ItemRow[] {
    const rows = this.db
      .prepare(
        `${ITEM_SELECT}
         WHERE i.status = 'pending' OR (i.status = 'failed' AND i.next_attempt_at IS NOT NULL AND i.next_attempt_at <= ?)
         ORDER BY (i.published_at IS NULL), i.published_at DESC, i.discovered_at DESC, i.id DESC`,
      )
      .all(now) as Row[];
    return rows.map(toItem);
  }

  markDone(id: number, f: DoneFields, now: string = nowIso()): void {
    this.db
      .prepare(
        `UPDATE items SET status = 'done', skip_reason = NULL, next_attempt_at = NULL, last_error = NULL, last_error_kind = NULL,
           note_path = ?, transcript_path = ?, model = ?, provider = ?, tokens_prompt = ?, tokens_completion = ?,
           duration_seconds = ?, processing_ms = ?, transcript_source = ?, summarized_at = ?, last_run_id = ?
         WHERE id = ?`,
      )
      .run(
        f.notePath, f.transcriptPath, f.model, f.provider, f.tokensPrompt, f.tokensCompletion,
        f.durationSeconds, f.processingMs, f.transcriptSource, now, f.runId, id,
      );
  }

  markFailed(id: number, f: { errorKind: string; error: string; attempts: number; nextAttemptAt: string | null; runId: number | null }): void {
    this.db
      .prepare(
        `UPDATE items SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error = ?, last_error_kind = ?, last_run_id = ? WHERE id = ?`,
      )
      .run(f.attempts, f.nextAttemptAt, f.error, f.errorKind, f.runId, id);
  }

  markSkipped(id: number, reason: string, notePath: string | null = null): void {
    this.db
      .prepare(`UPDATE items SET status = 'skipped', skip_reason = ?, note_path = COALESCE(?, note_path) WHERE id = ?`)
      .run(reason, notePath, id);
  }

  /** Reset items to pending (attempts 0). Returns how many rows changed. */
  resetItems(filter: { all?: boolean; ids?: number[]; sourceName?: string; includeSkipped?: boolean }): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.ids && filter.ids.length) {
      where.push(`i.id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
      where.push(`i.status IN ('failed', 'skipped')`);
    } else {
      where.push(filter.includeSkipped ? `i.status IN ('failed', 'skipped')` : `i.status = 'failed'`);
      if (filter.sourceName) {
        where.push('s.name = ?');
        params.push(filter.sourceName);
      } else if (!filter.all) {
        return 0;
      }
    }
    const sql = `UPDATE items SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, last_error_kind = NULL, skip_reason = NULL
                 WHERE id IN (SELECT i.id FROM items i JOIN sources s ON s.id = i.source_id WHERE ${where.join(' AND ')})`;
    return Number(this.db.prepare(sql).run(...(params as never[])).changes);
  }

  listItems(filter: { status?: ItemStatus; sourceName?: string; limit?: number } = {}): ItemRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('i.status = ?');
      params.push(filter.status);
    }
    if (filter.sourceName) {
      where.push('s.name = ?');
      params.push(filter.sourceName);
    }
    const sql = `${ITEM_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY (i.published_at IS NULL), i.published_at DESC, i.id DESC LIMIT ?`;
    params.push(filter.limit ?? 50);
    return (this.db.prepare(sql).all(...(params as never[])) as Row[]).map(toItem);
  }

  countByStatus(): Record<ItemStatus, number> {
    const out: Record<ItemStatus, number> = { pending: 0, done: 0, failed: 0, skipped: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all() as Row[]) {
      out[r.status as ItemStatus] = Number(r.n);
    }
    return out;
  }

  // ---------- runs ----------

  startRun(pid: number, dryRun: boolean, now: string = nowIso()): number {
    const r = this.db.prepare('INSERT INTO runs (started_at, pid, dry_run) VALUES (?, ?, ?)').run(now, pid, dryRun ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  finishRun(id: number, status: RunStatus, counts: RunCounts, now: string = nowIso()): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, status = ?, sources_polled = ?, sources_failed = ?, items_discovered = ?, items_processed = ?,
           items_done = ?, items_failed = ?, items_skipped = ?, tokens_prompt = ?, tokens_completion = ?, digest_path = ? WHERE id = ?`,
      )
      .run(
        now, status, counts.sourcesPolled ?? 0, counts.sourcesFailed ?? 0, counts.itemsDiscovered ?? 0, counts.itemsProcessed ?? 0,
        counts.itemsDone ?? 0, counts.itemsFailed ?? 0, counts.itemsSkipped ?? 0, counts.tokensPrompt ?? 0, counts.tokensCompletion ?? 0,
        counts.digestPath ?? null, id,
      );
  }

  findRunningRun(): RunRow | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`).get() as Row | undefined;
    return row ? toRun(row) : null;
  }

  markRunCrashed(id: number, now: string = nowIso()): void {
    this.db.prepare(`UPDATE runs SET status = 'crashed', finished_at = COALESCE(finished_at, ?) WHERE id = ?`).run(now, id);
  }

  getRun(id: number): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }
}

const ITEM_SELECT = `SELECT i.*, s.name AS source_name, s.type AS source_type FROM items i JOIN sources s ON s.id = i.source_id`;

function toSource(r: Row): SourceRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    type: r.type as SourceType,
    feedUrl: String(r.feed_url),
    firstSeenAt: String(r.first_seen_at),
    lastPolledAt: (r.last_polled_at as string | null) ?? null,
    lastPollOk: r.last_poll_ok === null || r.last_poll_ok === undefined ? null : Number(r.last_poll_ok) === 1,
    lastPollError: (r.last_poll_error as string | null) ?? null,
    lastPollItems: r.last_poll_items === null || r.last_poll_items === undefined ? null : Number(r.last_poll_items),
  };
}

function toItem(r: Row): ItemRow {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    id: Number(r.id),
    sourceId: Number(r.source_id),
    sourceName: String(r.source_name),
    sourceType: r.source_type as SourceType,
    externalId: String(r.external_id),
    url: String(r.url),
    title: str(r.title),
    publishedAt: str(r.published_at),
    discoveredAt: String(r.discovered_at),
    status: r.status as ItemStatus,
    skipReason: str(r.skip_reason),
    attempts: Number(r.attempts),
    nextAttemptAt: str(r.next_attempt_at),
    lastError: str(r.last_error),
    lastErrorKind: str(r.last_error_kind),
    notePath: str(r.note_path),
    transcriptPath: str(r.transcript_path),
    model: str(r.model),
    provider: str(r.provider),
    tokensPrompt: num(r.tokens_prompt),
    tokensCompletion: num(r.tokens_completion),
    durationSeconds: num(r.duration_seconds),
    processingMs: num(r.processing_ms),
    transcriptSource: str(r.transcript_source),
    summarizedAt: str(r.summarized_at),
    lastRunId: num(r.last_run_id),
  };
}

function toRun(r: Row): RunRow {
  return {
    id: Number(r.id),
    startedAt: String(r.started_at),
    finishedAt: (r.finished_at as string | null) ?? null,
    pid: Number(r.pid),
    status: r.status as RunStatus,
    dryRun: Number(r.dry_run) === 1,
    sourcesPolled: Number(r.sources_polled),
    sourcesFailed: Number(r.sources_failed),
    itemsDiscovered: Number(r.items_discovered),
    itemsProcessed: Number(r.items_processed),
    itemsDone: Number(r.items_done),
    itemsFailed: Number(r.items_failed),
    itemsSkipped: Number(r.items_skipped),
    tokensPrompt: Number(r.tokens_prompt),
    tokensCompletion: Number(r.tokens_completion),
    digestPath: (r.digest_path as string | null) ?? null,
  };
}

export function openState(dbPath: string): State {
  return State.open(dbPath);
}
