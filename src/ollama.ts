// Small helpers for the local Ollama server. Only used when a source's model starts with "ollama/".

export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromBase = env.OLLAMA_BASE_URL?.trim();
  if (fromBase) return fromBase.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const host = env.OLLAMA_HOST?.trim();
  if (host) {
    const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
    return withScheme.replace(/\/$/, '');
  }
  return 'http://127.0.0.1:11434';
}

export function isOllamaModel(model: string | null | undefined): model is string {
  return typeof model === 'string' && model.startsWith('ollama/');
}

/** "ollama/qwen3:14b" → "qwen3:14b" */
export function ollamaTag(model: string): string {
  return model.replace(/^ollama\//, '');
}

export interface OllamaStatus {
  reachable: boolean;
  version: string | null;
  tags: string[];
  loaded: Array<{ name: string; contextLength: number | null }>;
  error: string | null;
}

export async function ollamaStatus(opts: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<OllamaStatus> {
  const base = opts.baseUrl ?? ollamaBaseUrl();
  const f = opts.fetchImpl ?? fetch;
  const t = opts.timeoutMs ?? 5_000;
  const status: OllamaStatus = { reachable: false, version: null, tags: [], loaded: [], error: null };
  try {
    const v = await f(`${base}/api/version`, { signal: AbortSignal.timeout(t) });
    if (!v.ok) throw new Error(`HTTP ${v.status}`);
    status.version = String(((await v.json()) as { version?: string }).version ?? '');
    status.reachable = true;
    const tags = await f(`${base}/api/tags`, { signal: AbortSignal.timeout(t) });
    if (tags.ok) status.tags = (((await tags.json()) as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name);
    const ps = await f(`${base}/api/ps`, { signal: AbortSignal.timeout(t) });
    if (ps.ok) {
      status.loaded = (((await ps.json()) as { models?: Array<{ name: string; context_length?: number }> }).models ?? []).map((m) => ({
        name: m.name,
        contextLength: typeof m.context_length === 'number' ? m.context_length : null,
      }));
    }
  } catch (e) {
    status.error = `${base}: ${(e as Error).message}`;
  }
  return status;
}

export interface WarmUpResult {
  ok: boolean;
  ms: number;
  error: string | null;
}

/**
 * Load a model into memory before the first real request. Ollama loads the model (and returns)
 * when it receives an empty prompt; `keep_alive` keeps it resident across a batch of long items.
 * A cold 14B load can exceed the connect window of the first summarize call, so warm first.
 */
export async function ollamaWarmUp(
  model: string,
  opts: { baseUrl?: string; timeoutMs?: number; keepAlive?: string; fetchImpl?: typeof fetch } = {},
): Promise<WarmUpResult> {
  const base = opts.baseUrl ?? ollamaBaseUrl();
  const f = opts.fetchImpl ?? fetch;
  const started = Date.now();
  try {
    const res = await f(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ollamaTag(model), prompt: '', keep_alive: opts.keepAlive ?? '30m' }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, ms: Date.now() - started, error: `HTTP ${res.status} ${text}`.trim() };
    }
    await res.text().catch(() => '');
    return { ok: true, ms: Date.now() - started, error: null };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: (e as Error).message };
  }
}
