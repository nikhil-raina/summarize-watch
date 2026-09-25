import { describe, expect, it } from 'vitest';
import { detectFeedKind, parseFeed } from '../src/feeds/parse.js';
import { fixture } from './helpers.js';

describe('detectFeedKind', () => {
  it('classifies the fixtures', () => {
    expect(detectFeedKind(fixture('youtube.atom.xml'))).toBe('youtube');
    expect(detectFeedKind(fixture('podcast.rss.xml'))).toBe('podcast');
    expect(detectFeedKind(fixture('blog.atom.xml'))).toBe('rss');
    expect(detectFeedKind(fixture('blog.rss.xml'))).toBe('rss');
    expect(detectFeedKind(fixture('article.html'))).toBeNull();
    expect(detectFeedKind('')).toBeNull();
  });
});

describe('parseFeed: YouTube Atom', () => {
  const feed = parseFeed(fixture('youtube.atom.xml'));

  it('reads the channel title and every entry with a video id', () => {
    expect(feed.kind).toBe('youtube');
    expect(feed.title).toBe('Veritasium');
    expect(feed.items.map((i) => i.externalId)).toEqual(['VKlulHwMxgU', 'JsBZOcqZerk', 'abcdefghijk']);
  });

  it('canonicalises every url to watch?v= and flags shorts from the link', () => {
    const [short, normal, derived] = feed.items;
    expect(short?.url).toBe('https://www.youtube.com/watch?v=VKlulHwMxgU');
    expect(short?.isShortHint).toBe(true);
    expect(normal?.isShortHint).toBe(false);
    expect(derived?.url).toBe('https://www.youtube.com/watch?v=abcdefghijk');
  });

  it('decodes entities in titles and parses published dates to ISO', () => {
    const normal = feed.items[1];
    expect(normal?.title).toBe('The Insane Real Engineering of the Nazi Enigma Machine & Bletchley Park');
    expect(normal?.publishedAt).toBe('2026-09-21T17:49:57.000Z');
  });
});

describe('parseFeed: podcast RSS', () => {
  it('uses guid → enclosure → link for ids and prefers the enclosure url by default', () => {
    const feed = parseFeed(fixture('podcast.rss.xml'));
    expect(feed.kind).toBe('podcast');
    expect(feed.title).toBe('Example Podcast');
    expect(feed.items).toHaveLength(3); // the item with nothing identifying is dropped
    const [a, b, c] = feed.items;
    expect(a?.externalId).toBe('https://example.com/?p=6554');
    expect(a?.url).toBe('https://media.example.com/ep101.mp3');
    expect(a?.linkUrl).toBe('https://example.com/episodes/101?utm_source=rss&utm_medium=rss');
    expect(a?.title).toBe('#101 – Guid with isPermaLink=false');
    expect(a?.publishedAt).toBe('2026-09-17T00:40:49.000Z');
    expect(b?.externalId).toBe('https://media.example.com/ep100.mp3');
    expect(b?.url).toBe('https://media.example.com/ep100.mp3');
    expect(c?.externalId).toBe('ep-99');
    expect(c?.url).toBe('https://example.com/episodes/99'); // no enclosure → falls back to link
    expect(c?.publishedAt).toBeNull(); // "not a date"
  });

  it('prefer: link hands the episode page to summarize when present', () => {
    const feed = parseFeed(fixture('podcast.rss.xml'), { prefer: 'link' });
    expect(feed.items[0]?.url).toBe('https://example.com/episodes/101?utm_source=rss&utm_medium=rss');
    expect(feed.items[1]?.url).toBe('https://media.example.com/ep100.mp3'); // no link → enclosure
  });
});

describe('parseFeed: generic feeds', () => {
  it('Atom: picks the text/html alternate link, ignores replies links, uses published over updated', () => {
    const feed = parseFeed(fixture('blog.atom.xml'));
    expect(feed.kind).toBe('rss');
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]?.url).toBe('https://simonwillison.net/2026/Sep/24/quote/#atom-everything');
    expect(feed.items[0]?.externalId).toBe('https://simonwillison.net/2026/Sep/24/quote/#atom-everything');
    expect(feed.items[0]?.publishedAt).toBe('2026-09-24T22:02:12.000Z');
    expect(feed.items[1]?.url).toBe('https://simonwillison.net/2026/Sep/23/post/');
    expect(feed.items[1]?.externalId).toBe('tag:simonwillison.net,2026:post-23');
    expect(feed.items[1]?.publishedAt).toBe('2026-09-23T10:00:00.000Z');
  });

  it('RSS 2.0: guid then link as id; missing dates become null', () => {
    const feed = parseFeed(fixture('blog.rss.xml'));
    expect(feed.items.map((i) => i.externalId)).toEqual(['https://blog.example.org/first', 'https://blog.example.org/second']);
    expect(feed.items[1]?.publishedAt).toBeNull();
  });

  it('rejects HTML and garbage', () => {
    expect(() => parseFeed(fixture('article.html'))).toThrow(/not an RSS\/Atom feed/);
    expect(() => parseFeed('<rss><channel><title>x</title></channel></rss>', { type: 'rss' }).items).not.toThrow();
    expect(parseFeed('<rss><channel><title>x</title></channel></rss>', { type: 'rss' }).items).toEqual([]);
  });

  it('a forced type overrides detection', () => {
    const feed = parseFeed(fixture('blog.rss.xml'), { type: 'podcast' });
    expect(feed.kind).toBe('podcast');
    expect(feed.items[0]?.url).toBe('https://blog.example.org/first'); // no enclosure → link
  });
});
