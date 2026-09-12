import Anthropic from '@anthropic-ai/sdk';
import type { Item } from './types.js';

const SYSTEM = `You rank and gloss reading material for a React Native / Expo mobile developer.

You will receive a JSON array of candidate items (articles, discussions and videos).
For EACH candidate, return:

  score  0-100  How much this specific developer should care. Be harsh: 55 is the
                publication threshold, so most generic items belong below it.
                Items unrelated to React Native, Expo, mobile development, or the
                developer's stated interests score under 20 even if they are well made.
                Items with kind:"video" that look like YouTube
                Shorts or clickbait belong under 30.
  why    A single reason in English, at most 12 words, no trailing period.
         Say why it matters to the developer, not what the item is about.
  flag   "breaking" only if this describes a change that will break their build or
         their App Store / Play Store submission. Otherwise null.

Return the ids exactly as given. Output JSON only: no prose, no markdown fences.
Shape: {"items":[{"id":"...","score":0,"why":"...","flag":null}]}`;

interface Verdict { id: string; score?: number; why?: string; flag?: 'breaking' | null }

/**
 * The single LLM call per run. Only reading + video candidates are sent; releases and
 * platform are gated deterministically by tier and by "did the page change", and never
 * reach the model. On failure this returns null and the digest publishes uncurated -
 * a failed curation must never block the digest.
 */
export async function curate(candidates: Item[], model: string): Promise<Map<string, Verdict> | null> {
  if (!candidates.length) return new Map();

  const payload = candidates.map(i => ({
    id: i.key, title: i.title, sourceId: i.sourceId, url: i.url,
    snippet: i.snippet?.slice(0, 400), kind: i.kind,
  }));

  try {
    // The SDK retries 429/529/5xx itself; no hand-rolled retry loop needed.
    const client = new Anthropic({ maxRetries: 3 });
    const res = await client.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: 'low' },
      messages: [{
        role: 'user',
        content: `<candidates>\n${JSON.stringify(payload)}\n</candidates>`,
      }],
    });

    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(stripFences(text)) as { items?: Verdict[] };
    return new Map((parsed.items ?? []).map(v => [v.id, v]));
  } catch (e) {
    console.error(`curation failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** The model may still wrap the JSON in fences; take everything between the outer braces. */
function stripFences(s: string): string {
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

export function applyVerdicts(items: Item[], verdicts: Map<string, Verdict>): Item[] {
  return items.map(i => {
    const v = verdicts.get(i.key);
    // An id missing from the response keeps score:null and sorts last rather than being dropped.
    return { ...i, score: v?.score ?? null, why: v?.why, flag: v?.flag ?? null };
  });
}
