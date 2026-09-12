import { createHash } from 'node:crypto';

const DROP_PARAMS = /^(utm_.*|ref|si|feature|fbclid|gclid|t)$/;

export function normalizeUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return raw.trim(); }
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (DROP_PARAMS.test(k)) u.searchParams.delete(k);
  u.search = u.searchParams.toString() ? `?${u.searchParams}` : '';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, '');
  return u.toString();
}

/** Prefer a stable feed GUID; fall back to the normalized URL. */
export function itemKey(sourceId: string, url: string, guid?: string): string {
  const basis = guid?.trim() || normalizeUrl(url);
  return createHash('sha1').update(`${sourceId}|${basis}`).digest('hex');
}

export const SEEN_TTL_DAYS = 30;

export function pruneSeen(seen: Record<string, string>, now = Date.now()): void {
  const cutoff = now - SEEN_TTL_DAYS * 86400_000;
  for (const [k, iso] of Object.entries(seen)) if (Date.parse(iso) < cutoff) delete seen[k];
}
