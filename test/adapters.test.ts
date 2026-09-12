import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFeed, toItems } from '../src/adapters/rss.js';
import { contentHash } from '../src/adapters/pagediff.js';
import { npm, GATE, normalizeBump } from '../src/adapters/npm.js';
import { normalizeUrl, itemKey, pruneSeen } from '../src/dedup.js';
import { renderDigest, isBreaking, istanbulDate } from '../src/render/archive.js';
import { worthNotifying, telegramBody } from '../src/render/telegram.js';
import { updateHealth } from '../src/health.js';
import { ROOT } from '../src/state.js';
import type { Ctx, Item, SourceConfig } from '../src/types.js';

const fixture = (n: string) => readFileSync(join(ROOT, 'test/fixtures', n), 'utf8');
const src = (o: Partial<SourceConfig>): SourceConfig =>
  ({ id: 's', adapter: 'rss', section: 'reading', required: true, timeoutMs: 1000, retries: 0, ...o });
const ctx = (o: Partial<Ctx> = {}): Ctx =>
  ({ seen: {}, versions: {}, hashes: {}, etags: {}, health: {}, force: false, ...o });

describe('feed parsing', () => {
  it('maps Atom fields (entry/published/summary/link@href/id)', () => {
    const e = parseFeed(fixture('atom.xml'));
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({
      title: '0.82.0',
      url: 'https://github.com/facebook/react-native/releases/tag/v0.82.0',
      publishedAt: '2026-09-10T10:00:00.000Z',
      guid: 'tag:github.com,2008:Repository/29028775/v0.82.0',
    });
    expect(e[0].snippet).toBe('Breaking: the Touchable root export is removed. R&D notes.');
  });

  it('maps RSS 2.0 fields (item/pubDate/description/guid)', () => {
    const e = parseFeed(fixture('rss2.xml'));
    expect(e[0]).toMatchObject({
      title: 'Get ready for iPhone Duo',
      url: 'https://developer.apple.com/news/?id=vn8abkxx',
      publishedAt: '2026-09-10T06:05:23.000Z',
      guid: 'news-vn8abkxx',
    });
    expect(e[0].snippet).toBe('Start getting ready today.Explore now');
  });

  it('drops prereleases from release feeds only', () => {
    const entries = parseFeed(fixture('atom.xml'));
    expect(toItems(src({ section: 'releases' }), entries).map(i => i.title)).toEqual(['0.82.0']);
    expect(toItems(src({ section: 'reading' }), entries)).toHaveLength(2);
  });
});

describe('url normalization', () => {
  it.each([
    ['https://WWW.Example.com/a/', 'https://example.com/a'],
    ['https://example.com/a?utm_source=x&utm_campaign=y&keep=1', 'https://example.com/a?keep=1'],
    ['https://example.com/a?ref=hn&si=abc&feature=share&t=42', 'https://example.com/a'],
    ['https://example.com/a?fbclid=1&gclid=2', 'https://example.com/a'],
    ['https://youtu.be/abc#t=30', 'https://youtu.be/abc'],
    ['https://example.com/', 'https://example.com/'],
  ])('%s → %s', (input, expected) => expect(normalizeUrl(input)).toBe(expected));

  it('collapses the two URLs the same video arrives under', () => {
    expect(itemKey('s', 'https://www.youtube.com/watch?v=x&feature=share'))
      .toBe(itemKey('s', 'https://youtube.com/watch?v=x'));
  });

  it('prefers a stable guid over the url', () => {
    expect(itemKey('s', 'https://a.example/1', 'g1')).toBe(itemKey('s', 'https://b.example/2', 'g1'));
  });

  it('prunes seen entries past the 30-day TTL', () => {
    const now = Date.parse('2026-09-12T00:00:00Z');
    const seen = { old: '2026-08-01T00:00:00Z', fresh: '2026-09-10T00:00:00Z' };
    pruneSeen(seen, now);
    expect(Object.keys(seen)).toEqual(['fresh']);
  });
});

describe('semver tier gating', () => {
  it.each([
    [1, ['major', 'minor', 'patch']],
    [2, ['major', 'minor']],
    [3, ['major']],
  ] as const)('tier %i reports %s', (tier, allowed) => {
    for (const bump of ['major', 'minor', 'patch'] as const) {
      expect(GATE[tier].has(bump)).toBe(allowed.includes(bump as never));
    }
  });

  it('folds prerelease diffs onto their base bump', () => {
    expect(normalizeBump('preminor')).toBe('minor');
    expect(normalizeBump('premajor')).toBe('major');
    expect(normalizeBump('prerelease')).toBe('patch');
    expect(normalizeBump(null)).toBeNull();
  });

  it('treats a 0.x minor as breaking but a 3.x patch as not', () => {
    const item = (from: string, to: string, bump: 'minor' | 'patch'): Item =>
      ({ key: 'k', sourceId: 's', section: 'releases', title: 'p', url: 'u', meta: { fromVersion: from, toVersion: to, bump } });
    expect(isBreaking(item('0.81.5', '0.82.0', 'minor'))).toBe(true);
    expect(isBreaking(item('3.0.11', '3.0.12', 'patch'))).toBe(false);
  });
});

describe('pagediff', () => {
  const page = (nonce: string, body: string) =>
    `<html><head><script nonce="${nonce}"></script></head><body><nav>Menu ${nonce}</nav><main>${body}</main></body></html>`;

  it('ignores volatile markup outside the selector', () => {
    expect(contentHash(page('a1', 'Content'), 'main').hash).toBe(contentHash(page('zz', 'Content'), 'main').hash);
  });

  it('is stable across whitespace-only reflow', () => {
    expect(contentHash(page('a', 'one  two\n\t three'), 'main').hash).toBe(contentHash(page('a', 'one two three'), 'main').hash);
  });

  it('changes when the content changes', () => {
    expect(contentHash(page('a', 'old'), 'main').hash).not.toBe(contentHash(page('a', 'new'), 'main').hash);
  });
});

describe('npm adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (handler: (url: string) => { status: number; body?: unknown }) =>
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const { status, body } = handler(String(url));
      return { ok: status < 400, status, headers: new Headers(), text: async () => JSON.stringify(body ?? {}) } as Response;
    }));

  it('marks a 404 package private, once, and never requests it again', async () => {
    const calls: string[] = [];
    stub(u => { calls.push(u); return { status: 404 }; });
    const c = ctx();
    await npm(src({ id: 'npm-deps', adapter: 'npm', section: 'releases' }), c);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);
    expect(c.versions['react-native']).toEqual({ visibility: 'private' });

    calls.length = 0;
    await npm(src({ id: 'npm-deps', adapter: 'npm', section: 'releases' }), c);
    expect(calls).toHaveLength(0);
  });

  it('emits nothing on the first ever run and records baselines', async () => {
    stub(() => ({ status: 200, body: { 'dist-tags': { latest: '1.2.3' } } }));
    const c = ctx();
    const items = await npm(src({ id: 'npm-deps', adapter: 'npm', section: 'releases' }), c);
    expect(items).toHaveLength(0);
    expect(c.versions['react-native']).toBe('1.2.3');
  });

  it('emits only tier-allowed bumps on the second run', async () => {
    stub(u => u.endsWith('/latest')
      ? { status: 200, body: { repository: { url: 'git+https://github.com/o/r.git' } } }
      : { status: 200, body: { 'dist-tags': { latest: u.includes('react-native') ? '0.82.0' : '9.9.9' } } });
    const c = ctx({ versions: { 'react-native': '0.81.5', zod: '9.9.8' } });
    const items = await npm(src({ id: 'npm-deps', adapter: 'npm', section: 'releases' }), c);
    const titles = items.map(i => i.title);
    expect(titles).toContain('react-native');
    expect(titles).not.toContain('zod');
    expect(items.find(i => i.title === 'react-native')!.url).toBe('https://github.com/o/r/releases');
  });
});

describe('render + notification policy', () => {
  const sources = new Map<string, SourceConfig>([
    ['npm-deps', src({ id: 'npm-deps', title: 'npm dependencies', section: 'releases' })],
    ['appstore', src({ id: 'appstore', title: 'App Store Review Guidelines', section: 'platform' })],
  ]);
  const rn: Item = { key: 'a', sourceId: 'npm-deps', section: 'releases', title: 'react-native', url: 'https://x/r',
    meta: { fromVersion: '0.81.5', toVersion: '0.82.0', bump: 'minor', tier: 1 } };
  const patch3: Item = { key: 'b', sourceId: 'npm-deps', section: 'releases', title: 'left-pad', url: 'https://x/l',
    meta: { fromVersion: '1.0.0', toVersion: '1.0.1', bump: 'patch', tier: 3 } };
  const guideline: Item = { key: 'c', sourceId: 'appstore', section: 'platform', title: 'appstore', url: 'https://x/g',
    meta: { changedChars: 1400, lastChangedAt: '2026-06-14T00:00:00Z' } };

  const render = (items: Item[]) => renderDigest({
    date: '2026-09-12', items, sources, errors: [], wideWindow: false, uncurated: false, overflow: {} });

  it('omits empty sections entirely', () => {
    const md = render([rn]);
    expect(md).toContain('### 📦 Release Notes');
    expect(md).not.toContain('🎥 Video');
    expect(md).not.toContain('nothing here');
  });

  it('renders the spec line shapes', () => {
    expect(render([rn])).toContain('- **react-native 0.81.5 → 0.82.0** · minor 🔴 · [notes](https://x/r)');
    expect(render([guideline]))
      .toContain('- **App Store Review Guidelines changed** · ~1,400 characters · last changed June 14 · [page](https://x/g)');
  });

  it('writes a one-line body and no sections on an empty day', () => {
    const md = render([]);
    expect(md).toContain('Nothing new today.');
    expect(md).toContain('count: 0');
  });

  it('carries the header notes and the error footer', () => {
    const md = renderDigest({ date: '2026-09-12', items: [rn], sources, wideWindow: true, uncurated: true,
      overflow: {}, errors: [{ sourceId: 'appstore', error: '403' }] });
    expect(md).toContain('⚠️ 48-hour window');
    expect(md).toContain('⚠️ curation skipped');
    expect(md).toContain('⚠️ 1 source could not be retrieved: App Store Review Guidelines');
  });

  it('stays silent for a lone tier-3 patch but not for a tier-1 minor', () => {
    expect(worthNotifying([patch3])).toBe(false);
    expect(worthNotifying([])).toBe(false);
    expect(worthNotifying([rn])).toBe(true);
  });

  it('prefixes only on tier-1 minor/major or a new platform item', () => {
    const url = 'https://u.github.io/digest/archive/2026-09-12/';
    expect(telegramBody(url, [rn, guideline], sources, true))
      .toBe(`⚠️ react-native 0.82.0 + App Store Review Guidelines changed\nHere is your daily digest 👇\n${url}`);
    expect(telegramBody(url, [patch3], sources, true)).toBe(`Here is your daily digest 👇\n${url}`);
    expect(telegramBody(url, [rn], sources, false)).toBe(`Here is your daily digest 👇\n${url}`);
  });

  it('formats today as an Istanbul date', () => {
    expect(istanbulDate(new Date('2026-09-12T21:30:00Z'))).toBe('2026-09-13');
  });
});

describe('source health', () => {
  const s = [src({ id: 'dead' }), src({ id: 'quiet' })];
  const fail = { sourceId: 'dead', items: [], error: 'HTTP 403' };
  const ok = { sourceId: 'quiet', items: [] as Item[] };

  it('escalates 3 fails → issue, 14 → disable in state', () => {
    const health = { dead: { failCount: 2 }, quiet: { failCount: 0, lastItemAt: new Date().toISOString() } };
    expect(updateHealth(health, s, [fail, ok]).map(a => a.title)).toEqual(['dead: failed for 3 days']);
    expect(updateHealth(health, s, [fail, ok])).toEqual([]);
    health.dead.failCount = 13;
    const alerts = updateHealth(health, s, [fail, ok]);
    expect(alerts[0].title).toContain('disabled');
    expect(health.dead).toHaveProperty('disabledAt');
  });

  it('flags 45 days of silence on a source that never errors', () => {
    const old = new Date(Date.now() - 50 * 86400_000).toISOString();
    const health = { quiet: { failCount: 0, lastItemAt: old } };
    expect(updateHealth(health, s, [ok])[0].title).toContain('zero items for 50 days');
  });

  it('exempts a source configured as silenceExempt', () => {
    const old = new Date(Date.now() - 50 * 86400_000).toISOString();
    const exempt = [src({ id: 'quiet', silenceExempt: true })];
    expect(updateHealth({ quiet: { failCount: 0, lastItemAt: old } }, exempt, [ok])).toEqual([]);
  });
});
