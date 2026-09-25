import { describe, expect, it } from 'vitest';
import { discoverFeedLink, extractChannelIdFromHtml, normalizeInput, resolveSourceInput, suggestName } from '../src/feeds/resolve.js';
import { fixture } from './helpers.js';

/** Minimal fetch double keyed by URL prefix. */
function fakeFetch(routes: Record<string, { body: string; status?: number; type?: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key] as { body: string; status?: number; type?: string };
    return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'text/html' } });
  }) as typeof fetch;
}

describe('normalizeInput / suggestName', () => {
  it('adds schemes and expands bare handles', () => {
    expect(normalizeInput(' veritasium.com/feed ')).toBe('https://veritasium.com/feed');
    expect(normalizeInput('@veritasium')).toBe('https://www.youtube.com/@veritasium');
    expect(normalizeInput('https://x.test/a')).toBe('https://x.test/a');
    expect(() => normalizeInput('not a url at all')).toThrow();
  });
  it('suggests short slugs', () => {
    expect(suggestName("Simon Willison's Weblog: Everything", 'https://simonwillison.net/atom/', null)).toBe('simon-willisons-weblog-everything');
    expect(suggestName(null, 'https://feeds.transistor.fm/acquired', null)).toBe('feeds');
    expect(suggestName('Café Éclair!!', 'u', null)).toBe('cafe-eclair');
  });
});

describe('extractChannelIdFromHtml', () => {
  it('prefers the RSS alternate link, then externalId, and ignores related channels', () => {
    expect(extractChannelIdFromHtml(fixture('channel-page.html'))).toBe('UCHnyfMqiRRG1u-2MsSQLbXA');
    expect(extractChannelIdFromHtml('<script>{"externalId":"UCabcdefghijklmnopqrstuv"}</script>')).toBe('UCabcdefghijklmnopqrstuv');
    expect(extractChannelIdFromHtml('<script>"videoDetails":{"videoId":"x","channelId":"UC0123456789abcdefghijkl"}</script>')).toBe('UC0123456789abcdefghijkl');
    expect(extractChannelIdFromHtml('<html>nothing</html>')).toBeNull();
  });
});

describe('discoverFeedLink', () => {
  it('finds rss/atom alternates, resolves relative hrefs, and avoids comment feeds', () => {
    expect(discoverFeedLink(fixture('article.html'), 'https://blog.example.org/post')).toBe('https://blog.example.org/blog.atom.xml');
    const html = `<link rel="alternate" type="application/rss+xml" title="Comments feed" href="/comments/feed">
                  <link rel="alternate" type="application/rss+xml" title="Feed" href="/feed">`;
    expect(discoverFeedLink(html, 'https://b.test/x')).toBe('https://b.test/feed');
    expect(discoverFeedLink('<link rel="stylesheet" href="/x.css">', 'https://b.test')).toBeNull();
  });
});

describe('resolveSourceInput', () => {
  const yt = fixture('youtube.atom.xml');
  const pod = fixture('podcast.rss.xml');
  const blogAtom = fixture('blog.atom.xml');

  it('youtube channel url → feed without any fetch of the page', async () => {
    const fetchImpl = fakeFetch({ 'https://www.youtube.com/feeds/videos.xml': { body: yt, type: 'application/xml' } });
    const r = await resolveSourceInput('https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA', { fetchImpl });
    expect(r).toMatchObject({ type: 'youtube', channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA', title: 'Veritasium', suggestedName: 'veritasium', itemCount: 3, via: 'youtube channel' });
    expect(r.newestPublishedAt).toBe('2026-09-24T13:00:24.000Z');
  });

  it('youtube handle → page → channel id → feed', async () => {
    const fetchImpl = fakeFetch({
      'https://www.youtube.com/@veritasium': { body: fixture('channel-page.html') },
      'https://www.youtube.com/feeds/videos.xml': { body: yt, type: 'application/xml' },
    });
    const r = await resolveSourceInput('@veritasium', { fetchImpl });
    expect(r.feedUrl).toBe('https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA');
  });

  it('apple podcasts link → itunes lookup → feed', async () => {
    const fetchImpl = fakeFetch({
      'https://itunes.apple.com/lookup?id=1234': { body: JSON.stringify({ results: [{ feedUrl: 'https://feeds.example.com/pod.xml' }] }), type: 'application/json' },
      'https://feeds.example.com/pod.xml': { body: pod, type: 'application/rss+xml' },
    });
    const r = await resolveSourceInput('https://podcasts.apple.com/us/podcast/example/id1234', { fetchImpl });
    expect(r).toMatchObject({ type: 'podcast', feedUrl: 'https://feeds.example.com/pod.xml', title: 'Example Podcast', suggestedName: 'example-podcast', itemCount: 3, via: 'apple podcasts lookup' });
  });

  it('a feed url is detected by content; an html page is autodiscovered; forceType wins', async () => {
    const fetchImpl = fakeFetch({
      'https://blog.example.org/post': { body: fixture('article.html').replace('/blog.atom.xml', 'https://blog.example.org/feed.atom') },
      'https://blog.example.org/feed.atom': { body: blogAtom, type: 'application/atom+xml' },
      'https://feeds.example.com/pod.xml': { body: pod, type: 'application/rss+xml' },
    });
    const direct = await resolveSourceInput('https://feeds.example.com/pod.xml', { fetchImpl });
    expect(direct).toMatchObject({ type: 'podcast', via: 'feed url' });
    const auto = await resolveSourceInput('https://blog.example.org/post', { fetchImpl });
    expect(auto).toMatchObject({ type: 'rss', feedUrl: 'https://blog.example.org/feed.atom', itemCount: 2 });
    expect(auto.via).toMatch(/autodiscovered/);
    const forced = await resolveSourceInput('https://feeds.example.com/pod.xml', { fetchImpl, forceType: 'rss' });
    expect(forced.type).toBe('rss');
  });

  it('fails clearly for pages without feeds and unreachable urls', async () => {
    const fetchImpl = fakeFetch({ 'https://nofeed.test': { body: '<html><body>hi</body></html>' } });
    await expect(resolveSourceInput('https://nofeed.test/', { fetchImpl })).rejects.toThrow(/neither a feed nor a page that advertises one/);
    await expect(resolveSourceInput('https://missing.test/', { fetchImpl })).rejects.toThrow(/HTTP 404/);
  });
});
