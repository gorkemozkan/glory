import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { getBody } from '../http.js';
import { itemKey } from '../dedup.js';
import type { Ctx, Item, SourceConfig } from '../types.js';

/**
 * For sources with no feed at all. Hashes the selector's TEXT, not the raw HTML: raw HTML
 * carries nonces, ad slots, build hashes and CSRF tokens that change on every request.
 * This is the most fragile adapter — a redesign empties the selector and the source goes
 * quiet rather than erroring, which is what the 45-day silence rule catches.
 */
/** Hashes the normalized text of the selector, never the raw HTML. */
export function contentHash(html: string, selector: string): { text: string; hash: string } {
  const text = cheerio.load(html)(selector).text().replace(/\s+/g, ' ').trim();
  return { text, hash: createHash('sha256').update(text).digest('hex') };
}

export async function pagediff(src: SourceConfig, ctx: Ctx): Promise<Item[]> {
  const html = await getBody(src.url!, {
    timeoutMs: src.timeoutMs, retries: src.retries,
    userAgent: src.userAgent, etags: ctx.force ? undefined : ctx.etags,
  });
  if (html === null) return [];                                  // 304

  const { text: t, hash } = contentHash(html, src.selector!);
  if (!t) throw new Error(`selector "${src.selector}" matched nothing - the page may have been redesigned`);

  const prev = ctx.hashes[src.url!];
  const now = new Date().toISOString();
  ctx.hashes[src.url!] = { hash, at: prev?.hash === hash ? prev.at : now };

  if (!prev) return [];                                          // first ever run: baseline only
  if (prev.hash === hash) return [];

  return [{
    key: itemKey(src.id, `${src.url}#${hash.slice(0, 12)}`),
    sourceId: src.id, section: src.section,
    title: src.id, url: src.url!,
    publishedAt: now,
    meta: { changedChars: t.length, lastChangedAt: prev.at },
  }];
}
