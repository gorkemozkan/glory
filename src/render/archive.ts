import type { Item, SourceConfig } from '../types.js';

export const TZ = 'Europe/Istanbul';

export const istanbulDate = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);          // YYYY-MM-DD

const formatLongDate = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(d);
const formatShortDate = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', timeZone: TZ }).format(d);
const formatNumber = (n: number) => new Intl.NumberFormat('en-US').format(n);

export interface DigestInput {
  date: string;                      // YYYY-MM-DD (Istanbul)
  items: Item[];
  sources: Map<string, SourceConfig>;
  errors: { sourceId: string; error: string }[];
  wideWindow: boolean;
  uncurated: boolean;
  overflow: Partial<Record<'reading' | 'video', number>>;
}

export const EMPTY_BODY = 'Nothing new today.';

/** In 0.x a minor is breaking too: RN 0.81 -> 0.82 carries breaking changes. */
export function isBreaking(i: Item): boolean {
  const { bump, fromVersion } = i.meta ?? {};
  if (bump === 'major') return true;
  return bump === 'minor' && /^0\./.test(fromVersion ?? '');
}

export function renderDigest(d: DigestInput): string {
  const generated = new Date().toISOString().replace('Z', '+00:00');
  const head = [
    '---',
    `date: ${d.date}`,
    `generated: ${generated}`,
    `count: ${d.items.length}`,
    '---',
    '',
    `# ${formatLongDate(new Date(`${d.date}T12:00:00Z`))}`,
    '',
  ];
  if (d.wideWindow) head.push('⚠️ 48-hour window', '');
  if (d.uncurated) head.push('⚠️ curation skipped', '');

  if (!d.items.length) return [...head, EMPTY_BODY, '', ...footer(d)].join('\n');

  const body = [
    section('### 📦 Release Notes', d.items.filter(i => i.section === 'releases'), i => releaseLine(i, d.sources)),
    section('### ⚠️ Platform & Policy', d.items.filter(i => i.section === 'platform'), i => platformLine(i, d.sources)),
    section('### 📄 Reading & Discussions', d.items.filter(i => i.section === 'reading'), readingLine, d.overflow.reading),
    section('### 🎥 Video', d.items.filter(i => i.section === 'video'), i => videoLine(i, d.sources), d.overflow.video),
  ].filter(Boolean);

  return [...head, ...body, ...footer(d)].join('\n');
}

/** Empty sections are omitted entirely, never rendered with a "nothing here" line. */
function section(heading: string, items: Item[], line: (i: Item) => string, overflow = 0): string {
  if (!items.length) return '';
  const lines = items.map(line);
  if (overflow > 0) lines.push(`- … and ${overflow} more`);
  return `${heading}\n\n${lines.join('\n')}\n`;
}

function releaseLine(i: Item, sources: Map<string, SourceConfig>): string {
  const m = i.meta;
  if (!m?.toVersion) {
    const label = sources.get(i.sourceId)?.title ?? i.sourceId;
    return `- **${i.title}** · *${label}* · [notes](${i.url})`;
  }
  const mark = isBreaking(i) ? ' 🔴' : '';
  return `- **${i.title} ${m.fromVersion} → ${m.toVersion}** · ${m.bump}${mark} · [notes](${i.url})`;
}

function platformLine(i: Item, sources: Map<string, SourceConfig>): string {
  const m = i.meta;
  if (m?.changedChars === undefined) return `- **${i.title}** · [read](${i.url})`;
  const title = sources.get(i.sourceId)?.title ?? i.title;
  const last = m.lastChangedAt ? ` · last changed ${formatShortDate(new Date(m.lastChangedAt))}` : '';
  return `- **${title} changed** · ~${formatNumber(m.changedChars)} characters${last} · [page](${i.url})`;
}

const readingLine = (i: Item) =>
  `- [${i.title}](${i.url}) · *${publisher(i.url)}*${i.why ? ` · ${i.why}` : ''}${i.flag === 'breaking' ? ' 🔴' : ''}`;

const videoLine = (i: Item, sources: Map<string, SourceConfig>) =>
  `- [${i.title}](${i.url}) · *${sources.get(i.sourceId)?.handle ?? i.sourceId}*${i.why ? ` · ${i.why}` : ''}`;

function publisher(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'source'; }
}

function footer(d: DigestInput): string[] {
  if (!d.errors.length) return [];
  const names = d.errors.map(e => d.sources.get(e.sourceId)?.title ?? e.sourceId);
  return ['---', `⚠️ ${names.length} source${names.length === 1 ? '' : 's'} could not be retrieved: ${names.join(', ')}`, ''];
}
