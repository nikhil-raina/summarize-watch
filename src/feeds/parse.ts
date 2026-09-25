import { XMLParser } from 'fast-xml-parser';
import type { Prefer, SourceType } from '../config.js';
import { canonicalYouTubeUrl, extractYouTubeId, isYouTubeShortsUrl } from '../util.js';

export interface FeedItem {
  /** Stable id used for idempotency: YouTube videoId, podcast guid/enclosure/link, RSS guid/id/link. */
  externalId: string;
  /** What gets handed to `summarize`. */
  url: string;
  title: string | null;
  /** ISO timestamp or null when the feed has no usable date. */
  publishedAt: string | null;
  linkUrl: string | null;
  enclosureUrl: string | null;
  /** True when the feed itself hints this is a YouTube Short (link under /shorts/). */
  isShortHint: boolean;
}

export interface ParsedFeed {
  kind: SourceType;
  title: string | null;
  items: FeedItem[];
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

const ARRAY_TAGS = new Set(['entry', 'item', 'link', 'enclosure', 'category', 'author', 'media:content']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  removeNSPrefix: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

/** youtube | podcast | rss from the raw XML, or null when it is not a feed at all. */
export function detectFeedKind(xml: string): SourceType | null {
  const head = stripBom(xml).slice(0, 4000);
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(head) && !/<\?xml/i.test(head)) return null;
  if (/xmlns:yt=|<yt:videoId>/i.test(head) || /<yt:videoId>/i.test(xml)) return 'youtube';
  if (/xmlns:itunes=/i.test(head) || /<enclosure\s/i.test(xml)) return 'podcast';
  if (/<(rss|feed|rdf:RDF)[\s>]/i.test(head)) return 'rss';
  return null;
}

export function parseFeed(xml: string, opts: { type?: SourceType; prefer?: Prefer } = {}): ParsedFeed {
  const text = stripBom(xml);
  const kind = opts.type ?? detectFeedKind(text);
  if (!kind) throw new FeedParseError('not an RSS/Atom feed (no <rss>, <feed> or <rdf:RDF> root)');
  let doc: Node;
  try {
    doc = parser.parse(text) as Node;
  } catch (e) {
    throw new FeedParseError(`XML parse failed: ${(e as Error).message}`);
  }
  const feed = doc.feed as Node | undefined;
  const rss = doc.rss as Node | undefined;
  const channel = rss?.channel as Node | undefined;
  if (!feed && !channel && !(doc['rdf:RDF'] as Node | undefined)) {
    throw new FeedParseError('not an RSS/Atom feed (parsed XML has no feed or channel)');
  }
  const prefer = opts.prefer ?? 'enclosure';
  const title = textOf(feed?.title ?? channel?.title) ?? null;

  if (kind === 'youtube') return { kind, title, items: youtubeEntries(feed, channel) };
  if (kind === 'podcast') return { kind, title, items: podcastItems(feed, channel, prefer) };
  return { kind, title, items: genericItems(feed, channel, doc['rdf:RDF'] as Node | undefined) };
}

// ---------- YouTube Atom ----------

function youtubeEntries(feed: Node | undefined, channel: Node | undefined): FeedItem[] {
  const entries = asArray<Node>(feed?.entry ?? channel?.item);
  const out: FeedItem[] = [];
  for (const e of entries) {
    const link = atomAlternateLink(e) ?? textOf(e.link);
    let videoId = textOf(e['yt:videoId']);
    if (!videoId && link) videoId = extractYouTubeId(link);
    if (!videoId) {
      const id = textOf(e.id);
      const m = id ? /yt:video:([A-Za-z0-9_-]{11})/.exec(id) : null;
      videoId = m?.[1] ?? null;
    }
    if (!videoId) continue;
    const url = canonicalYouTubeUrl(`https://www.youtube.com/watch?v=${videoId}`) as string;
    const mediaGroup = e['media:group'] as Node | undefined;
    out.push({
      externalId: videoId,
      url,
      title: textOf(e.title) ?? textOf(mediaGroup?.['media:title']) ?? null,
      publishedAt: toIso(textOf(e.published) ?? textOf(e.updated)),
      linkUrl: link ?? url,
      enclosureUrl: null,
      isShortHint: link ? isYouTubeShortsUrl(link) : false,
    });
  }
  return out;
}

// ---------- Podcast RSS ----------

function podcastItems(feed: Node | undefined, channel: Node | undefined, prefer: Prefer): FeedItem[] {
  const items = asArray<Node>(channel?.item ?? feed?.entry);
  const out: FeedItem[] = [];
  for (const it of items) {
    const enclosure = firstEnclosureUrl(it);
    const link = atomAlternateLink(it) ?? textOf(it.link);
    const guid = textOf(it.guid) ?? textOf(it.id);
    const externalId = guid ?? enclosure ?? link;
    if (!externalId) continue;
    const url = prefer === 'enclosure' ? enclosure ?? link : link ?? enclosure;
    if (!url) continue;
    out.push({
      externalId,
      url,
      title: textOf(it.title) ?? null,
      publishedAt: toIso(textOf(it.pubDate) ?? textOf(it.published) ?? textOf(it.updated) ?? textOf(it['dc:date'])),
      linkUrl: link ?? null,
      enclosureUrl: enclosure ?? null,
      isShortHint: false,
    });
  }
  return out;
}

// ---------- Generic RSS 2.0 / Atom / RDF ----------

function genericItems(feed: Node | undefined, channel: Node | undefined, rdf: Node | undefined): FeedItem[] {
  const items = asArray<Node>(channel?.item ?? feed?.entry ?? rdf?.item);
  const out: FeedItem[] = [];
  for (const it of items) {
    const link = atomAlternateLink(it) ?? textOf(it.link) ?? textOf((it as Node)['@_rdf:about']);
    const guid = textOf(it.guid) ?? textOf(it.id);
    const enclosure = firstEnclosureUrl(it);
    const externalId = guid ?? link ?? enclosure;
    const url = link ?? enclosure;
    if (!externalId || !url) continue;
    out.push({
      externalId,
      url,
      title: textOf(it.title) ?? null,
      publishedAt: toIso(textOf(it.pubDate) ?? textOf(it.published) ?? textOf(it.updated) ?? textOf(it['dc:date'])),
      linkUrl: link ?? null,
      enclosureUrl: enclosure ?? null,
      isShortHint: false,
    });
  }
  return out;
}

// ---------- helpers ----------

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function asArray<T>(v: unknown): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? (v as T[]) : [v as T];
}

/** Text of a node that may be a string, a {'#text', '@_attr'} object, or an array of those. */
export function textOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = textOf(x);
      if (t) return t;
    }
    return null;
  }
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const t = (v as Node)['#text'];
    if (typeof t === 'string') return t.trim() || null;
    if (typeof t === 'number') return String(t);
    // Atom <link href="..."/> with no text: caller should use atomAlternateLink
    const href = (v as Node)['@_href'];
    if (typeof href === 'string' && Object.keys(v as Node).every((k) => k.startsWith('@_'))) return href.trim() || null;
  }
  return null;
}

/** <link rel="alternate" href> (Atom), preferring text/html, else the first href without a rel like self/enclosure/replies. */
function atomAlternateLink(node: Node): string | null {
  const links = asArray<unknown>(node.link).filter((l) => typeof l === 'object' && l !== null) as Node[];
  if (!links.length) return null;
  const byRel = (rel: string | undefined) => links.filter((l) => (l['@_rel'] as string | undefined) === rel);
  const pick = (ls: Node[]) => ls.find((l) => (l['@_type'] as string | undefined)?.includes('html')) ?? ls[0];
  const alt = pick(byRel('alternate')) ?? pick(byRel(undefined));
  const href = alt?.['@_href'];
  return typeof href === 'string' && href.trim() ? href.trim() : null;
}

function firstEnclosureUrl(node: Node): string | null {
  const enclosures = asArray<Node>(node.enclosure);
  for (const e of enclosures) {
    const u = e?.['@_url'];
    if (typeof u === 'string' && u.trim()) return u.trim();
  }
  // Atom: <link rel="enclosure" href="...">
  const links = asArray<Node>(node.link).filter((l) => typeof l === 'object' && l !== null);
  const enc = links.find((l) => l['@_rel'] === 'enclosure');
  const href = enc?.['@_href'];
  if (typeof href === 'string' && href.trim()) return href.trim();
  // media:content url (YouTube-style / MRSS)
  const media = asArray<Node>((node['media:group'] as Node | undefined)?.['media:content'] ?? node['media:content']);
  const mu = media[0]?.['@_url'];
  return typeof mu === 'string' && mu.trim() ? mu.trim() : null;
}

function toIso(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
