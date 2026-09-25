import type { Prefer, SourceType } from '../config.js';
import { BROWSER_USER_AGENT, FetchError, fetchText } from './fetch.js';
import { detectFeedKind, parseFeed } from './parse.js';

export interface ResolvedSource {
  type: SourceType;
  /** The feed the runner will poll. */
  feedUrl: string;
  channelId: string | null;
  /** Feed title, when verified. */
  title: string | null;
  suggestedName: string;
  itemCount: number | null;
  newestPublishedAt: string | null;
  /** How we got here, for the user's benefit. */
  via: string;
}

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  forceType?: SourceType;
  prefer?: Prefer;
  /** Fetch and parse the resolved feed once (default true). */
  verify?: boolean;
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

const CHANNEL_ID_RE = /UC[A-Za-z0-9_-]{22}/;

export async function resolveSourceInput(input: string, opts: ResolveOptions = {}): Promise<ResolvedSource> {
  const url = normalizeInput(input);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const fetchOpts = { fetchImpl: opts.fetchImpl, timeoutMs };

  let resolved: Omit<ResolvedSource, 'title' | 'suggestedName' | 'itemCount' | 'newestPublishedAt'> & { titleHint?: string | null };

  if (isYouTube(url)) {
    const channelId = await resolveYouTubeChannelId(url, fetchOpts);
    resolved = { type: 'youtube', feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, channelId, via: 'youtube channel' };
  } else if (/^https?:\/\/podcasts\.apple\.com\//i.test(url)) {
    const feedUrl = await resolveApplePodcastFeed(url, fetchOpts);
    resolved = { type: 'podcast', feedUrl, channelId: null, via: 'apple podcasts lookup' };
  } else {
    const res = await fetchOrThrow(url, fetchOpts);
    const kind = detectFeedKind(res.text);
    if (kind) {
      resolved = { type: kind === 'youtube' ? 'youtube' : kind, feedUrl: res.finalUrl, channelId: kind === 'youtube' ? (CHANNEL_ID_RE.exec(res.text)?.[0] ?? null) : null, via: 'feed url' };
    } else {
      const discovered = discoverFeedLink(res.text, res.finalUrl);
      if (!discovered) throw new ResolveError(`${url} is neither a feed nor a page that advertises one (<link rel="alternate" type="application/rss+xml">). Pass the feed URL directly.`);
      const feedRes = await fetchOrThrow(discovered, fetchOpts);
      const feedKind = detectFeedKind(feedRes.text);
      if (!feedKind) throw new ResolveError(`${discovered} (advertised by ${url}) is not a parseable feed`);
      resolved = { type: feedKind, feedUrl: feedRes.finalUrl, channelId: null, via: `autodiscovered from ${url}` };
    }
  }

  if (opts.forceType) resolved.type = opts.forceType;

  let title: string | null = null;
  let itemCount: number | null = null;
  let newest: string | null = null;
  if (opts.verify !== false) {
    const res = await fetchOrThrow(resolved.feedUrl, fetchOpts);
    let parsed;
    try {
      parsed = parseFeed(res.text, { type: resolved.type, prefer: opts.prefer });
    } catch (e) {
      throw new ResolveError(`${resolved.feedUrl}: ${(e as Error).message}`);
    }
    title = parsed.title;
    itemCount = parsed.items.length;
    newest = parsed.items.map((i) => i.publishedAt).filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;
  }

  return { ...resolved, title, suggestedName: suggestName(title, resolved.feedUrl, resolved.channelId), itemCount, newestPublishedAt: newest };
}

// ---------- youtube ----------

export function isYouTube(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^(www|m|music)\./, '');
    return host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com';
  } catch {
    return false;
  }
}

export async function resolveYouTubeChannelId(url: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<string> {
  const u = new URL(url);
  const fromPath = /^\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(u.pathname)?.[1];
  if (fromPath) return fromPath;
  const fromFeed = u.pathname === '/feeds/videos.xml' ? u.searchParams.get('channel_id') : null;
  if (fromFeed && CHANNEL_ID_RE.test(fromFeed)) return fromFeed;

  // Handle, /c/, /user/, watch?v=, youtu.be: read the page. YouTube serves a consent page to
  // unknown agents without the cookie, so pretend to be a browser that already agreed.
  const res = await fetchOrThrow(url, {
    ...opts,
    userAgent: BROWSER_USER_AGENT,
    accept: 'text/html',
    headers: { cookie: 'CONSENT=YES+1; SOCS=CAI' },
  });
  const id = extractChannelIdFromHtml(res.text);
  if (!id) throw new ResolveError(`could not find a channel id on ${url}. Try the channel URL (youtube.com/channel/UC…) or the feed URL (youtube.com/feeds/videos.xml?channel_id=UC…).`);
  return id;
}

export function extractChannelIdFromHtml(html: string): string | null {
  const rss = /<link[^>]+type="application\/rss\+xml"[^>]+href="([^"]+channel_id=(UC[A-Za-z0-9_-]{22})[^"]*)"/i.exec(html);
  if (rss?.[2]) return rss[2];
  const external = /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html);
  if (external?.[1]) return external[1];
  const identifier = /<meta itemprop="identifier" content="(UC[A-Za-z0-9_-]{22})"/.exec(html);
  if (identifier?.[1]) return identifier[1];
  const canonical = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/.exec(html);
  if (canonical?.[1]) return canonical[1];
  // watch pages: the video's own channel comes first in videoDetails
  const details = /"videoDetails":\{[^}]*?"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(html);
  if (details?.[1]) return details[1];
  return null;
}

// ---------- apple podcasts ----------

export async function resolveApplePodcastFeed(url: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<string> {
  const id = /\/id(\d+)/.exec(new URL(url).pathname)?.[1];
  if (!id) throw new ResolveError(`no show id in ${url} (expected .../podcast/<name>/id<digits>)`);
  const res = await fetchOrThrow(`https://itunes.apple.com/lookup?id=${id}&entity=podcast`, { ...opts, accept: 'application/json' });
  let feedUrl: string | undefined;
  try {
    const data = JSON.parse(res.text) as { results?: Array<{ feedUrl?: string }> };
    feedUrl = data.results?.[0]?.feedUrl;
  } catch {
    /* fall through */
  }
  if (!feedUrl) throw new ResolveError(`Apple Podcasts lookup for id ${id} returned no feed URL`);
  return feedUrl;
}

// ---------- html autodiscovery ----------

export function discoverFeedLink(html: string, baseUrl: string): string | null {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const candidates: Array<{ href: string; score: number }> = [];
  for (const tag of links) {
    const rel = /\brel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const type = /\btype=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !rel.split(/\s+/).includes('alternate')) continue;
    if (!/application\/(rss|atom)\+xml|application\/feed\+json/.test(type)) continue;
    let score = type.includes('rss') ? 2 : type.includes('atom') ? 1 : 0;
    if (/comments?/i.test(href) || /comments?/i.test(/\btitle=["']([^"']+)["']/i.exec(tag)?.[1] ?? '')) score -= 5;
    candidates.push({ href, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]?.href;
  if (!best) return null;
  try {
    return new URL(best, baseUrl).toString();
  } catch {
    return null;
  }
}

// ---------- helpers ----------

export function normalizeInput(input: string): string {
  let s = input.trim();
  if (/^@[A-Za-z0-9._-]+$/.test(s)) s = `https://www.youtube.com/${s}`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  new URL(s); // throws on garbage
  return s;
}

export function suggestName(title: string | null, feedUrl: string, channelId: string | null): string {
  const base = title ?? hostLabel(feedUrl) ?? channelId ?? 'source';
  const slug = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'source';
}

function hostLabel(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.')[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchOrThrow(url: string, opts: Parameters<typeof fetchText>[1]) {
  try {
    return await fetchText(url, opts);
  } catch (e) {
    if (e instanceof FetchError) throw new ResolveError(`${url}: ${e.message}`);
    throw e;
  }
}
