import type { Etags } from './types.js';

export interface GetOptions {
  timeoutMs: number;
  retries: number;
  userAgent?: string;
  etags?: Etags;          // when given, sends a conditional request and stores the new validator
  headers?: Record<string, string>;
}

/** On 304 the body is null: nothing to parse. */
export interface Response304 { status: number; body: string | null }

const DEFAULT_UA = 'digest-bot/1.0 (personal daily digest; +https://github.com)';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function get(url: string, opts: GetOptions): Promise<Response304> {
  const attempts = Math.max(1, opts.retries) + 1;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(3 ** (i - 1) * 1000 * (0.75 + Math.random() * 0.5)); // 1s → 3s → 9s + jitter

    const headers: Record<string, string> = {
      'user-agent': opts.userAgent ?? DEFAULT_UA,
      'accept-encoding': 'gzip, deflate',
      ...opts.headers,
    };
    const cached = opts.etags?.[url];
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });

      if (res.status === 403 || res.status === 404) {          // durable, no retry
        return { status: res.status, body: null };
      }
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 30_000;
        if (i >= 1) return { status: 429, body: null };        // 2 attempts
        await sleep(wait);
        continue;
      }
      if (res.status === 304) return { status: 304, body: null };
      if (res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      if (!res.ok) return { status: res.status, body: null };

      if (opts.etags) {
        const etag = res.headers.get('etag') ?? undefined;
        const lastModified = res.headers.get('last-modified') ?? undefined;
        if (etag || lastModified) opts.etags[url] = { etag, lastModified };
        else delete opts.etags[url];
      }
      return { status: res.status, body: await res.text() };
    } catch (e) {
      lastErr = e;                                              // timeout / DNS / network
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** For callers that need a body: throws on non-2xx, returns null on 304. */
export async function getBody(url: string, opts: GetOptions): Promise<string | null> {
  const res = await get(url, opts);
  if (res.status === 304) return null;
  if (res.body === null) throw new Error(`HTTP ${res.status}`);
  return res.body;
}
