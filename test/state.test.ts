import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { State } from '../src/state.js';

let state: State;
beforeEach(() => {
  state = State.open(':memory:');
});
afterEach(() => state.close());

const T0 = '2026-09-25T03:00:00.000Z';

describe('State', () => {
  it('migrates once and reports the schema version', () => {
    expect(state.schemaVersion()).toBe(1);
  });

  it('upserts sources idempotently and keeps first_seen_at', () => {
    const a = state.upsertSource({ name: 'vt', type: 'youtube', feedUrl: 'https://yt/feed' }, T0);
    const b = state.upsertSource({ name: 'vt', type: 'youtube', feedUrl: 'https://yt/feed2' }, '2026-09-26T00:00:00.000Z');
    expect(b.id).toBe(a.id);
    expect(b.firstSeenAt).toBe(T0);
    expect(b.feedUrl).toBe('https://yt/feed2');
    expect(b.lastPolledAt).toBeNull();
    state.recordPoll(a.id, false, 'HTTP 503', null);
    expect(state.getSourceByName('vt')?.lastPollOk).toBe(false);
    expect(state.getSourceByName('vt')?.lastPollError).toBe('HTTP 503');
  });

  it('upsertItem inserts once and never downgrades an existing row', () => {
    const src = state.upsertSource({ name: 'vt', type: 'youtube', feedUrl: 'f' }, T0);
    const item = { externalId: 'abc', url: 'https://www.youtube.com/watch?v=abc', title: 'A', publishedAt: T0 };
    const first = state.upsertItem(src.id, item, { status: 'pending' });
    expect(first.inserted).toBe(true);
    state.markDone(first.id, {
      notePath: 'n.md', transcriptPath: null, model: 'ollama/qwen3:14b', provider: 'ollama', tokensPrompt: 10, tokensCompletion: 5,
      durationSeconds: 120, processingMs: 1000, transcriptSource: 'captions', runId: null,
    });
    const again = state.upsertItem(src.id, item, { status: 'skipped', skipReason: 'before_since' });
    expect(again.inserted).toBe(false);
    expect(again.status).toBe('done');
    expect(state.getItem(first.id)?.status).toBe('done');
  });

  it('selectDue returns pending items and failed items whose retry time has come, newest first', () => {
    const src = state.upsertSource({ name: 'p', type: 'podcast', feedUrl: 'f' }, T0);
    const older = state.upsertItem(src.id, { externalId: '1', url: 'u1', title: 'old', publishedAt: '2026-09-01T00:00:00.000Z' }, { status: 'pending' });
    const newer = state.upsertItem(src.id, { externalId: '2', url: 'u2', title: 'new', publishedAt: '2026-09-20T00:00:00.000Z' }, { status: 'pending' });
    const undated = state.upsertItem(src.id, { externalId: '3', url: 'u3', title: 'undated', publishedAt: null }, { status: 'pending' });
    const failedDue = state.upsertItem(src.id, { externalId: '4', url: 'u4', title: 'due', publishedAt: '2026-09-10T00:00:00.000Z' }, { status: 'pending' });
    const failedLater = state.upsertItem(src.id, { externalId: '5', url: 'u5', title: 'later', publishedAt: '2026-09-11T00:00:00.000Z' }, { status: 'pending' });
    const gaveUp = state.upsertItem(src.id, { externalId: '6', url: 'u6', title: 'gave up', publishedAt: '2026-09-12T00:00:00.000Z' }, { status: 'pending' });
    state.markFailed(failedDue.id, { errorKind: 'failed_exit', error: 'boom', attempts: 1, nextAttemptAt: '2026-09-25T02:00:00.000Z', runId: null });
    state.markFailed(failedLater.id, { errorKind: 'timeout', error: 'slow', attempts: 2, nextAttemptAt: '2026-09-25T09:00:00.000Z', runId: null });
    state.markFailed(gaveUp.id, { errorKind: 'failed_exit', error: 'no', attempts: 5, nextAttemptAt: null, runId: null });

    const due = state.selectDue(T0).map((i) => i.id);
    expect(due).toEqual([newer.id, failedDue.id, older.id, undated.id]);
    expect(due).not.toContain(failedLater.id);
    expect(due).not.toContain(gaveUp.id);
  });

  it('resetItems reverts failed rows (and skipped rows only by id)', () => {
    const src = state.upsertSource({ name: 'p', type: 'rss', feedUrl: 'f' }, T0);
    const failed = state.upsertItem(src.id, { externalId: 'a', url: 'ua', title: null, publishedAt: null }, { status: 'pending' });
    const skipped = state.upsertItem(src.id, { externalId: 'b', url: 'ub', title: null, publishedAt: null }, { status: 'skipped', skipReason: 'shorts' });
    state.markFailed(failed.id, { errorKind: 'timeout', error: 'x', attempts: 3, nextAttemptAt: null, runId: null });

    expect(state.resetItems({})).toBe(0); // nothing selected → no-op
    expect(state.resetItems({ all: true })).toBe(1);
    const row = state.getItem(failed.id);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBeNull();
    expect(state.getItem(skipped.id)?.status).toBe('skipped');
    expect(state.resetItems({ ids: [skipped.id] })).toBe(1);
    expect(state.getItem(skipped.id)?.status).toBe('pending');
  });

  it('findDoneByUrl finds a finished duplicate; markSkipped keeps the note path', () => {
    const a = state.upsertSource({ name: 'a', type: 'youtube', feedUrl: 'fa' }, T0);
    const b = state.upsertSource({ name: 'b', type: 'youtube', feedUrl: 'fb' }, T0);
    const url = 'https://www.youtube.com/watch?v=dupdupdupdu';
    const first = state.upsertItem(a.id, { externalId: 'dupdupdupdu', url, title: 't', publishedAt: null }, { status: 'pending' });
    const second = state.upsertItem(b.id, { externalId: 'dupdupdupdu', url, title: 't', publishedAt: null }, { status: 'pending' });
    expect(state.findDoneByUrl(url)).toBeNull();
    state.markDone(first.id, { notePath: 'x.md', transcriptPath: null, model: null, provider: null, tokensPrompt: null, tokensCompletion: null, durationSeconds: null, processingMs: 1, transcriptSource: null, runId: null });
    expect(state.findDoneByUrl(url)?.id).toBe(first.id);
    state.markSkipped(second.id, `duplicate_of:${first.id}`, 'x.md');
    expect(state.getItem(second.id)).toMatchObject({ status: 'skipped', skipReason: `duplicate_of:${first.id}`, notePath: 'x.md' });
    expect(state.countByStatus()).toEqual({ pending: 0, done: 1, failed: 0, skipped: 1 });
  });

  it('runs: start, finish, detect a running run', () => {
    const id = state.startRun(process.pid, false, T0);
    expect(state.findRunningRun()?.id).toBe(id);
    state.finishRun(id, 'completed', { itemsProcessed: 3, itemsDone: 2, itemsFailed: 1, tokensPrompt: 100, digestPath: 'd.md' });
    expect(state.findRunningRun()).toBeNull();
    expect(state.getRun(id)).toMatchObject({ status: 'completed', itemsProcessed: 3, itemsDone: 2, itemsFailed: 1, tokensPrompt: 100, digestPath: 'd.md' });
    const crashed = state.startRun(999999, false);
    state.markRunCrashed(crashed);
    expect(state.getRun(crashed)?.status).toBe('crashed');
  });
});
