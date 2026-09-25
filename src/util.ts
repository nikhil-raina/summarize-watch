import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

// ---------- durations ----------

export const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s" | "2m" | "10m" | "1h" | "3d" | "500ms" → milliseconds. Throws on anything else. */
export function parseDuration(input: string): number {
  const m = DURATION_RE.exec(input.trim());
  if (!m) throw new Error(`Invalid duration "${input}" (expected e.g. 30s, 2m, 10m, 1h, 3d)`);
  return Number(m[1]) * (UNIT_MS[m[2] as string] ?? 0);
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

// ---------- strings ----------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Last `maxChars` of a string with CRs dropped and blank runs collapsed. Prefixed with … when cut. */
export function tail(s: string, maxChars: number): string {
  const collapsed = s.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
  return collapsed.length <= maxChars ? collapsed : `…${collapsed.slice(-maxChars)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------- paths ----------

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Expand ~ and resolve relative paths against `baseDir`. */
export function resolvePath(p: string, baseDir: string): string {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

// ---------- YouTube URLs ----------

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function extractYouTubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0] ?? '';
    return YT_ID_RE.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  const v = u.searchParams.get('v');
  if (v && YT_ID_RE.test(v)) return v;
  const m = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/.exec(u.pathname);
  return m?.[1] ?? null;
}

export function canonicalYouTubeUrl(url: string): string | null {
  const id = extractYouTubeId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

export function isYouTubeShortsUrl(url: string): boolean {
  try {
    return /\/shorts\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// ---------- retry scheduling ----------

/**
 * When to try again after `attempts` failed attempts (attempts >= 1).
 * Returns null once `maxAttempts` is reached ("gave up"; `retry` can reset it).
 */
export function nextAttemptAt(
  attempts: number,
  backoffMs: readonly number[],
  maxAttempts: number,
  now: Date = new Date(),
): string | null {
  if (attempts >= maxAttempts) return null;
  const idx = Math.min(Math.max(attempts - 1, 0), backoffMs.length - 1);
  const delay = backoffMs[idx] ?? backoffMs[backoffMs.length - 1] ?? 3_600_000;
  return new Date(now.getTime() + delay).toISOString();
}

// ---------- logging (stderr only; stdout is for results) ----------

export type LogLevel = 'quiet' | 'normal' | 'verbose';
let currentLevel: LogLevel = 'normal';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export const log = {
  info(msg: string): void {
    if (currentLevel !== 'quiet') process.stderr.write(`${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },
  debug(msg: string): void {
    if (currentLevel === 'verbose') process.stderr.write(`${msg}\n`);
  },
};

/** Patch process.emitWarning so Node 22's SQLite ExperimentalWarning stays quiet. Idempotent. */
export function suppressSqliteExperimentalWarning(): void {
  const marker = '__summarizeWatchWarningPatched';
  const proc = process as unknown as Record<string, unknown>;
  if (proc[marker]) return;
  proc[marker] = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const first = rest[0] as { type?: string } | string | undefined;
    const type = typeof first === 'string' ? first : first?.type ?? (warning as { name?: string } | undefined)?.name;
    const text = typeof warning === 'string' ? warning : ((warning as { message?: string } | undefined)?.message ?? '');
    if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
    return (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

// ---------- TLS trust ----------

export interface SystemCaResult {
  supported: boolean;
  added: number;
  skipped: boolean;
}

/**
 * Many work machines sit behind TLS-inspecting proxies (Cloudflare Gateway, Zscaler, Netskope) whose
 * root lives in the OS keychain but not in Node's bundled Mozilla list, so `fetch` fails with
 * SELF_SIGNED_CERT_IN_CHAIN while curl works. Node >= 24.5 / 22.19 can merge the system store at
 * runtime; older Nodes need `--use-system-ca` or NODE_EXTRA_CA_CERTS. Opt out with
 * SUMMARIZE_WATCH_NO_SYSTEM_CA=1. Idempotent.
 */
export function trustSystemCertificates(env: NodeJS.ProcessEnv = process.env): SystemCaResult {
  if (env.SUMMARIZE_WATCH_NO_SYSTEM_CA === '1') return { supported: true, added: 0, skipped: true };
  const t = tls as unknown as {
    getCACertificates?: (type: 'default' | 'system' | 'bundled' | 'extra') => string[];
    setDefaultCACertificates?: (certs: string[]) => void;
  };
  if (typeof t.getCACertificates !== 'function' || typeof t.setDefaultCACertificates !== 'function') {
    return { supported: false, added: 0, skipped: false };
  }
  const marker = '__summarizeWatchSystemCa';
  const proc = process as unknown as Record<string, unknown>;
  if (typeof proc[marker] === 'number') return { supported: true, added: proc[marker] as number, skipped: false };
  try {
    const current = t.getCACertificates('default');
    const system = t.getCACertificates('system');
    const have = new Set(current.map(normalizePem));
    const extra = system.filter((c) => !have.has(normalizePem(c)));
    if (extra.length) t.setDefaultCACertificates([...current, ...extra]);
    proc[marker] = extra.length;
    return { supported: true, added: extra.length, skipped: false };
  } catch {
    proc[marker] = 0;
    return { supported: true, added: 0, skipped: false };
  }
}

function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, '');
}
