// pagediff selector validator. Fetches the same page twice a few seconds apart; if the
// two hashes differ the selector is still capturing volatile markup and needs narrowing.
// Usage: npx tsx scripts/probe-selector.ts <url> <selector> [selector...]
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

const [url, ...selectors] = process.argv.slice(2);
const UA = 'digest-bot/1.0 (personal daily digest)';

const extract = (html: string, sel: string) =>
  cheerio.load(html)(sel).text().replace(/\s+/g, ' ').trim();

const grab = async () => {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  return { status: res.status, html: await res.text() };
};

const a = await grab();
const b = await grab();
console.log(`${url}  status=${a.status}  html=${a.html.length}B`);
for (const sel of selectors.length ? selectors : ['main', 'body']) {
  const ta = extract(a.html, sel), tb = extract(b.html, sel);
  const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
  console.log(`  ${sel.padEnd(40)} len=${String(ta.length).padStart(7)} ${h(ta) === h(tb) ? 'STABLE' : 'UNSTABLE'} ${h(ta)}`);
  if (ta.length) console.log(`      ${ta.slice(0, 120)}`);
}
