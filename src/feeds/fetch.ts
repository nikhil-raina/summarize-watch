export const DEFAULT_USER_AGENT = 'summarize-watch/0.1 (+https://github.com/nikhil-raina/summarize-watch)';
/** Some sites (YouTube channel pages) serve different HTML to non-browser agents. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null = null,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetchTextOptions {
  timeoutMs?: number;
  accept?: string;
  userAgent?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** 'follow' (default) or 'manual' to observe redirects. */
  redirect?: 'follow' | 'manual' | 'error';
}

export interface FetchTextResult {
  text: string;
  status: number;
  contentType: string | null;
  finalUrl: string;
  /** Location header when redirect: 'manual' and the response was a 3xx. */
  location: string | null;
}

export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<FetchTextResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      redirect: opts.redirect ?? 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT,
        accept: opts.accept ?? 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
        'accept-language': 'en-US,en;q=0.8',
        ...(opts.headers ?? {}),
      },
    });
  } catch (e) {
    const err = e as Error & { name?: string; cause?: { code?: string; message?: string } };
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    if (timedOut) throw new FetchError(`fetch timed out after ${Math.round(timeoutMs / 1000)}s`, url, null, e);
    const code = err.cause?.code ?? '';
    const detail = code || err.cause?.message || err.message;
    const tlsHint = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code)
      ? ' (TLS trust problem: a corporate proxy may be re-signing certificates; on Node < 24.5 run with NODE_USE_SYSTEM_CA=1 or set NODE_EXTRA_CA_CERTS)'
      : '';
    throw new FetchError(`fetch failed: ${detail}${tlsHint}`, url, null, e);
  }
  const location = res.headers.get('location');
  if (opts.redirect === 'manual' && res.status >= 300 && res.status < 400) {
    return { text: '', status: res.status, contentType: res.headers.get('content-type'), finalUrl: res.url || url, location };
  }
  if (!res.ok) {
    throw new FetchError(`HTTP ${res.status} ${res.statusText}`.trim(), url, res.status);
  }
  const text = await res.text();
  return { text, status: res.status, contentType: res.headers.get('content-type'), finalUrl: res.url || url, location };
}
