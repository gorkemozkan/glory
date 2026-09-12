import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import { getBody } from '../http.js';
import { itemKey } from '../dedup.js';
import type { Ctx, Item, SourceConfig } from '../types.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

const arr = <T>(v: T | T[] | undefined): T[] => v === undefined ? [] : Array.isArray(v) ? v : [v];

/** A text node may be a bare string, a number, or { '#text': ... }. */
function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return text((v as Record<string, unknown>)['#text']);
  return String(v);
}

/** An Atom link may be a single object or an array; prefer rel=alternate. */
function atomLink(v: unknown): string {
  const links = arr(v as Record<string, string> | Record<string, string>[]);
  const alt = links.find(l => l?.['@_rel'] === 'alternate') ?? links[0];
  return alt?.['@_href'] ?? text(v);
}

export function stripHtml(html: string, max = 400): string {
  const t = cheerio.load(`<div>${html}</div>`).text().replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

export interface RawEntry { title: string; url: string; publishedAt?: string; snippet?: string; guid?: string }

/** Reads RSS 2.0 and Atom with one parser and normalizes both into one shape. */
export function parseFeed(xml: string): RawEntry[] {
  const doc = parser.parse(xml) as Record<string, any>;

  if (doc.feed) {                                              // Atom
    return arr(doc.feed.entry).map((e: any): RawEntry => ({
      title: text(e.title),
      url: atomLink(e.link),
      publishedAt: iso(text(e.published) || text(e.updated)),
      snippet: stripHtml(text(e.summary) || text(e.content) || text(e['media:group']?.['media:description'])),
      guid: text(e.id) || undefined,
    }));
  }

  const channel = doc.rss?.channel ?? doc['rdf:RDF'];           // RSS 2.0 / RDF
  return arr(channel?.item).map((e: any): RawEntry => ({
    title: text(e.title),
    url: text(e.link) || text(e.guid),
    publishedAt: iso(text(e.pubDate) || text(e['dc:date'])),
    snippet: stripHtml(text(e.description) || text(e['content:encoded'])),
    guid: e.guid?.['@_isPermaLink'] === 'false' ? text(e.guid) : undefined,
  }));
}

function iso(v: string): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

// Release feeds publish nightlies and release candidates too; noise for a daily digest.
const PRERELEASE = /[-.](rc|nightly|alpha|beta|canary|next|dev|preview|pre)[.\d-]*/i;

export function toItems(src: SourceConfig, entries: RawEntry[]): Item[] {
  return entries
    .filter(e => e.title && e.url)
    .filter(e => src.section !== 'releases' || !PRERELEASE.test(e.title))
    .map(e => ({
      key: itemKey(src.id, e.url, e.guid),
      sourceId: src.id,
      section: src.section,
      title: e.title,
      url: e.url,
      publishedAt: e.publishedAt,
      snippet: e.snippet || undefined,
    }));
}

export async function rss(src: SourceConfig, ctx: Ctx): Promise<Item[]> {
  const xml = await getBody(src.url!, {
    timeoutMs: src.timeoutMs, retries: src.retries,
    userAgent: src.userAgent, etags: ctx.force ? undefined : ctx.etags,
  });
  if (xml === null) return [];                                 // 304
  return toItems(src, parseFeed(xml));
}
