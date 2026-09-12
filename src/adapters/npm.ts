import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import semver from 'semver';
import { get, getBody } from '../http.js';
import { itemKey } from '../dedup.js';
import { ROOT } from '../state.js';
import type { Ctx, Item, SourceConfig } from '../types.js';

interface Deps { tier1: string[]; tier2: string[]; defaultTier: 1 | 2 | 3; denylist?: string[] }

export function loadPackages(): { pkg: string; tier: 1 | 2 | 3 }[] {
  const deps = parse(readFileSync(join(ROOT, 'config/deps.yml'), 'utf8')) as Deps;
  const snapshot = JSON.parse(readFileSync(join(ROOT, 'config/package.snapshot.json'), 'utf8'));
  const denied = new Set(deps.denylist ?? []);
  const t1 = new Set(deps.tier1), t2 = new Set(deps.tier2);
  const names = [...Object.keys(snapshot.dependencies ?? {}), ...Object.keys(snapshot.devDependencies ?? {})];

  return [...new Set(names)].filter(p => !denied.has(p)).sort().map(pkg => ({
    pkg,
    // devDependencies are not automatically tier 3: an explicit tier list entry wins.
    tier: t1.has(pkg) ? 1 : t2.has(pkg) ? 2 : deps.defaultTier,
  }));
}

export const GATE: Record<1 | 2 | 3, Set<string>> = {
  1: new Set(['major', 'minor', 'patch']),
  2: new Set(['major', 'minor']),
  3: new Set(['major']),
};

/** semver.diff can return values like 'preminor'; fold them onto the base bump. */
export function normalizeBump(d: string | null): 'major' | 'minor' | 'patch' | null {
  if (!d) return null;
  const base = d.replace(/^pre/, '') || 'patch';
  return base === 'major' || base === 'minor' ? base : 'patch';
}

export async function npm(src: SourceConfig, ctx: Ctx): Promise<Item[]> {
  const items: Item[] = [];
  const http = { timeoutMs: src.timeoutMs, retries: src.retries };

  for (const { pkg, tier } of loadPackages()) {
    const prev = ctx.versions[pkg];
    if (typeof prev === 'object') continue;                     // known private, never ask again

    // The abridged packument is mandatory: the full document is multi-megabyte for popular packages.
    const res = await get(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`, {
      ...http, headers: { accept: 'application/vnd.npm.install-v1+json' },
    });

    if (res.status === 404) {                                   // not on the public registry
      ctx.versions[pkg] = { visibility: 'private' };
      console.log(`npm: ${pkg} is not on the public registry, skipping permanently`);
      continue;
    }
    if (res.body === null) { console.warn(`npm: ${pkg} HTTP ${res.status}`); continue; }

    const latest: string | undefined = JSON.parse(res.body)['dist-tags']?.latest;
    if (!latest) continue;

    if (!prev) { ctx.versions[pkg] = latest; continue; }         // first ever run: baseline only
    if (prev === latest) continue;

    const bump = normalizeBump(semver.valid(prev) && semver.valid(latest) ? semver.diff(prev, latest) : null);
    ctx.versions[pkg] = latest;
    if (!bump || !GATE[tier].has(bump)) continue;

    const url = await releaseUrl(pkg, latest, http);
    items.push({
      key: itemKey(src.id, `${url}#${prev}-${latest}`),
      sourceId: src.id, section: src.section,
      title: pkg, url,
      publishedAt: new Date().toISOString(),
      meta: { fromVersion: prev, toVersion: latest, bump, tier },
    });
  }
  return items;
}

/** Only for packages that actually changed: /latest is small and carries `repository`. */
async function releaseUrl(pkg: string, version: string, http: { timeoutMs: number; retries: number }) {
  const fallback = `https://www.npmjs.com/package/${pkg}/v/${version}`;
  try {
    const body = await getBody(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}/latest`, http);
    const repo: string | undefined = JSON.parse(body ?? '{}').repository?.url ?? JSON.parse(body ?? '{}').repository;
    const gh = repo?.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    return gh ? `https://github.com/${gh[1]}/${gh[2]}/releases` : fallback;
  } catch { return fallback; }
}
