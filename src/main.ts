import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ROOT, read, write } from './state.js';
import { alreadyRanToday } from './guard.js';
import { pruneSeen } from './dedup.js';
import { rss } from './adapters/rss.js';
import { youtube } from './adapters/youtube.js';
import { npm } from './adapters/npm.js';
import { pagediff } from './adapters/pagediff.js';
import { discussions } from './adapters/discussions.js';
import { curate, applyVerdicts } from './curate.js';
import { renderDigest, istanbulDate } from './render/archive.js';
import { writeIndex } from './render/index.js';
import { telegramBody, worthNotifying } from './render/telegram.js';
import { updateHealth, isDisabled } from './health.js';
import type { Config, Ctx, Etags, Hashes, Health, Item, Runs, Seen, SourceConfig, SourceResult, Versions } from './types.js';

const ADAPTERS = { rss, youtube, npm, pagediff, discussions } as const;
const WIDE_WINDOW_HOURS = 30;
const ABORT_FAIL_RATIO = 0.4;
const UNCURATED_CAP = 15;

const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

function loadConfig(): Config {
  const raw = parse(readFileSync(join(ROOT, 'config/sources.yml'), 'utf8'));
  return {
    ...raw,
    sources: raw.sources.map((s: Partial<SourceConfig>) => ({ ...raw.defaults, ...s })),
  };
}

async function runSource(src: SourceConfig, ctx: Ctx): Promise<SourceResult> {
  // Every source runs in an isolated try/catch: one dead source never fails another.
  try {
    return { sourceId: src.id, items: await ADAPTERS[src.adapter](src, ctx) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`  ✗ ${src.id}: ${error}`);
    return { sourceId: src.id, items: [], error };
  }
}

async function main() {
  const cfg = loadConfig();
  const today = istanbulDate();

  const { done, runs } = alreadyRanToday();
  if (done && !force && !dryRun) {
    console.log(`guard: ${today} already produced, exiting`);
    return emit({ date: today, notify: false });
  }

  const health = read<Health>('health.json', {});
  const ctx: Ctx = {
    seen: force ? {} : read<Seen>('seen.json', {}),
    versions: read<Versions>('versions.json', {}),
    hashes: read<Hashes>('hashes.json', {}),
    etags: read<Etags>('etags.json', {}),
    health,
    since: runs.lastRunAt,
    force,
  };

  const active = cfg.sources.filter(s => !isDisabled(health, s.id));
  console.log(`fetching ${active.length} sources (window: ${ctx.since ?? 'first run'})`);
  const results = await Promise.all(active.map(s => runSource(s, ctx)));

  // If a whole group of sources is down, publish nothing rather than a garbage digest.
  const required = active.filter(s => s.required);
  const failed = results.filter(r => r.error && required.some(s => s.id === r.sourceId));
  if (required.length && failed.length / required.length > ABORT_FAIL_RATIO) {
    console.error(`${failed.length}/${required.length} required sources failed (>40%) - archive not written`);
    process.exitCode = 1;
    return emit({ date: today, notify: false, aborted: true });
  }

  const windowStart = ctx.since ? Date.parse(ctx.since) : Date.now() - 24 * 3600_000;
  const wideWindow = (Date.now() - windowStart) / 3600_000 > WIDE_WINDOW_HOURS;

  const fetched = results.flatMap(r => r.items);
  const fresh = fetched.filter(i =>
    !ctx.seen[i.key] && (!i.publishedAt || Date.parse(i.publishedAt) >= windowStart));
  const nowIso = new Date().toISOString();
  for (const i of fetched) ctx.seen[i.key] = nowIso;   // mark everything fetched as seen
  pruneSeen(ctx.seen);

  // releases and platform never reach the LLM: gated by tier and by "did the page change".
  const gated = fresh.filter(i => i.section === 'releases' || i.section === 'platform');
  const candidates = fresh.filter(i => i.section === 'reading' || i.section === 'video');

  const verdicts = await curate(candidates, cfg.llm.model);
  const uncurated = verdicts === null;
  const { picked, overflow } = uncurated
    ? pickUncurated(candidates)
    : pickCurated(applyVerdicts(candidates, verdicts), cfg);

  const items = [...sortReleases(gated), ...picked];
  const sources = new Map(cfg.sources.map(s => [s.id, s]));
  const markdown = renderDigest({
    date: today, items, sources, wideWindow, uncurated, overflow,
    errors: results.filter(r => r.error).map(r => ({ sourceId: r.sourceId, error: r.error! })),
  });

  if (dryRun) {
    console.log('\n──────── dry-run: no state written ────────\n');
    console.log(markdown);
    return;
  }

  writeFileSync(join(ROOT, 'archive', `${today}.md`), markdown);
  writeIndex();

  const alerts = updateHealth(health, cfg.sources, results);
  if (!force) {
    write('seen.json', ctx.seen);
    write('versions.json', ctx.versions);
    write('hashes.json', ctx.hashes);
    write('etags.json', ctx.etags);
    write('health.json', health);
    write('runs.json', { lastRunAt: nowIso, lastSuccessDate: today } satisfies Runs);
  }

  const notify = worthNotifying(items);
  console.log(`wrote ${items.length} items${notify ? '' : ' (no notification)'}`);
  emit({
    date: today, notify, alerts,
    telegram: notify ? telegramBody(siteUrl(today), items, sources, cfg.telegram.criticalPrefix) : undefined,
  });
}

function pickCurated(items: Item[], cfg: Config) {
  const byScore = (a: Item, b: Item) => (b.score ?? -1) - (a.score ?? -1);  // score:null sorts last
  const take = (section: 'reading' | 'video', cap: number) => {
    const pool = items
      .filter(i => i.section === section && (i.score == null || i.score >= cfg.llm.scoreThreshold))
      .sort(byScore);
    return { kept: pool.slice(0, cap), over: Math.max(0, pool.length - cap) };
  };
  const r = take('reading', cfg.caps.reading);
  const v = take('video', cfg.caps.video);
  return { picked: [...r.kept, ...v.kept], overflow: { reading: r.over, video: v.over } };
}

/** LLM fallback: unranked, newest first, 15 items total across both sections. */
function pickUncurated(candidates: Item[]) {
  const sorted = [...candidates].sort((a, b) =>
    Date.parse(b.publishedAt ?? '0') - Date.parse(a.publishedAt ?? '0'));
  const picked = sorted.slice(0, UNCURATED_CAP);
  const dropped = (s: 'reading' | 'video') =>
    candidates.filter(i => i.section === s).length - picked.filter(i => i.section === s).length;
  return { picked, overflow: { reading: dropped('reading'), video: dropped('video') } };
}

const BUMP_ORDER = { major: 0, minor: 1, patch: 2 } as const;
const sortReleases = (items: Item[]) => [...items].sort((a, b) =>
  (a.section === 'platform' ? 0 : 1) - (b.section === 'platform' ? 0 : 1) ||
  (a.meta?.tier ?? 9) - (b.meta?.tier ?? 9) ||
  (BUMP_ORDER[a.meta?.bump ?? 'patch'] - BUMP_ORDER[b.meta?.bump ?? 'patch']) ||
  a.title.localeCompare(b.title, 'tr'));

function siteUrl(date: string): string {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? 'user/digest').split('/');
  return `https://${owner}.github.io/${repo}/archive/${date}/`;
}

/** The workflow reads this file to drive the Telegram and issue steps. */
function emit(out: Record<string, unknown>) {
  mkdirSync(join(ROOT, '.build'), { recursive: true });
  writeFileSync(join(ROOT, '.build/out.json'), JSON.stringify(out, null, 2));
}

await main();
