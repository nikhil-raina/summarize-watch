import fs from 'node:fs';
import path from 'node:path';
import { CliError, type GlobalOptions } from '../cli-types.js';
import { CONFIG_FILENAME, configPaths, loadConfig, parseConfigText, renderStarterConfig } from '../config.js';
import type { ItemRow, ItemStatus } from '../state.js';
import { log, resolvePath } from '../util.js';

// ---------- init ----------

export async function init(opts: GlobalOptions & { output?: string; force?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const configPath = opts.config ? resolvePath(opts.config, cwd) : path.join(cwd, CONFIG_FILENAME);
  if (fs.existsSync(configPath) && !opts.force) {
    throw new CliError(`${configPath} already exists (use --force to overwrite)`);
  }
  const outputDir = opts.output ?? './notes';
  const text = renderStarterConfig({ outputDir });
  // Round-trip through the schema so a broken template can never be written.
  const config = parseConfigText(text, configPath);
  const paths = configPaths(config, configPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, text, 'utf8');
  for (const dir of [paths.outputDir, paths.digestsDir, paths.transcriptsDir, paths.stateDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  process.stdout.write(
    [
      `wrote ${configPath}`,
      `notes → ${paths.outputDir}`,
      `state → ${paths.stateDir}`,
      '',
      'next:',
      '  summarize-watch add https://www.youtube.com/@<channel>     # or a podcast feed / Apple Podcasts link / blog URL',
      '  summarize-watch doctor',
      '  summarize-watch run --dry-run',
      '',
    ].join('\n'),
  );
}

// ---------- list ----------

export async function list(
  opts: GlobalOptions & { failed?: boolean; status?: string; source?: string; limit?: number; json?: boolean },
): Promise<void> {
  const loaded = loadConfig(opts.config);
  const { openState } = await import('../state.js');
  const state = openState(loaded.paths.dbPath);
  try {
    const status = (opts.failed ? 'failed' : opts.status) as ItemStatus | undefined;
    const items = state.listItems({ status, sourceName: opts.source, limit: opts.limit ?? 50 });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return;
    }
    if (!items.length) {
      const counts = state.countByStatus();
      process.stdout.write(
        `no items${status ? ` with status ${status}` : ''}${opts.source ? ` for ${opts.source}` : ''} · totals: ${formatCounts(counts)}\n`,
      );
      return;
    }
    process.stdout.write(`${renderItemTable(items)}\n`);
    const counts = state.countByStatus();
    process.stdout.write(`totals: ${formatCounts(counts)}\n`);
  } finally {
    state.close();
  }
}

export function formatCounts(c: Record<ItemStatus, number>): string {
  return `${c.pending} pending · ${c.done} done · ${c.failed} failed · ${c.skipped} skipped`;
}

export function renderItemTable(items: ItemRow[]): string {
  const rows = items.map((i) => [
    String(i.id),
    i.status,
    i.sourceName,
    i.publishedAt ? i.publishedAt.slice(0, 10) : '—',
    truncate(i.title ?? i.url, 50),
    String(i.attempts),
    nextColumn(i),
  ]);
  const header = ['id', 'status', 'source', 'published', 'title', 'att', 'next / reason'];
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((r) => (r[col] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, col) => c.padEnd(widths[col] ?? c.length)).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function nextColumn(i: ItemRow): string {
  if (i.status === 'failed') {
    const when = i.nextAttemptAt ? `retry ${i.nextAttemptAt.slice(0, 16).replace('T', ' ')}` : 'gave up';
    return truncate(`${when} · ${i.lastErrorKind ?? ''} ${i.lastError ?? ''}`.trim(), 60);
  }
  if (i.status === 'skipped') return truncate(i.skipReason ?? 'skipped', 60);
  if (i.status === 'done') return truncate(i.notePath ?? '', 60);
  return '';
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

// ---------- retry ----------

export async function retry(opts: GlobalOptions & { all?: boolean; id?: number[]; source?: string }): Promise<void> {
  const loaded = loadConfig(opts.config);
  const { openState } = await import('../state.js');
  const state = openState(loaded.paths.dbPath);
  try {
    if (!opts.all && !opts.id?.length && !opts.source) {
      const failed = state.listItems({ status: 'failed', limit: 50 });
      if (!failed.length) {
        process.stdout.write('no failed items\n');
        return;
      }
      process.stdout.write(`${renderItemTable(failed)}\n\nreset with: summarize-watch retry --all | --id <id> | --source <name>\n`);
      return;
    }
    const n = state.resetItems({ all: opts.all, ids: opts.id, sourceName: opts.source, includeSkipped: Boolean(opts.id?.length) });
    process.stdout.write(`${n} item${n === 1 ? '' : 's'} reset to pending${n ? ' · now run: summarize-watch run' : ''}\n`);
    if (!n) log.info('nothing matched (only failed items are reset; use --id to un-skip a skipped item)');
  } finally {
    state.close();
  }
}
