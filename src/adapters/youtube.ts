import { getBody } from '../http.js';
import { parseFeed, toItems } from './rss.js';
import type { Ctx, Item, SourceConfig } from '../types.js';

// Handles (@ByteByteGo) do not work on this endpoint; channel IDs are pinned in sources.yml.
// The feed always returns the latest 15 videos regardless of date, so seen.json is the only
// reliable dedup here. Shorts are indistinguishable from normal videos without the Data API;
// they are passed to curation with kind:'video' and left to sink on a low score.
export async function youtube(src: SourceConfig, ctx: Ctx): Promise<Item[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${src.channelId}`;
  const xml = await getBody(url, {
    timeoutMs: src.timeoutMs, retries: src.retries,
    userAgent: src.userAgent, etags: ctx.force ? undefined : ctx.etags,
  });
  if (xml === null) return [];
  return toItems(src, parseFeed(xml)).map(i => ({ ...i, kind: 'video' as const }));
}
