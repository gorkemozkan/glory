// Resolve a YouTube handle to its channel ID (handles do not work on the feed endpoint).
// Run once, verify each feed returns entries, then paste the IDs into config/sources.yml.
// Usage: npx tsx scripts/resolve-youtube-ids.ts @handle [@handle...]
const HANDLES = process.argv.slice(2);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

async function resolve(handle: string): Promise<string | null> {
  const res = await fetch(`https://www.youtube.com/${handle}`, { headers: { 'user-agent': UA } });
  if (!res.ok) return null;
  const html = await res.text();
  return html.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/)?.[1]
    ?? html.match(/"channelId":"(UC[\w-]{22})"/)?.[1]
    ?? null;
}

async function feedHasEntries(channelId: string): Promise<boolean> {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  return res.ok && (await res.text()).includes('<entry>');
}

for (const handle of HANDLES) {
  const id = await resolve(handle);
  if (!id) { console.log(`${handle}\tFAILED`); continue; }
  console.log(`${handle}\t${id}\t${(await feedHasEntries(id)) ? 'ok' : 'EMPTY-FEED'}`);
}
