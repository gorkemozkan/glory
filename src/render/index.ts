import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../state.js';

const formatLongDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T12:00:00Z`));

/** Regenerated on every successful run. Serves as the MkDocs landing page. */
export function renderIndex(): string {
  const dir = join(ROOT, 'archive');
  const days = readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort().reverse()
    .map(f => {
      const head = readFileSync(join(dir, f), 'utf8').slice(0, 400);
      return { date: f.slice(0, 10), count: Number(head.match(/^count: (\d+)$/m)?.[1] ?? 0) };
    });

  const lines = days.map(d =>
    `- [${formatLongDate(d.date)}](${d.date}.md) — ${d.count === 0 ? 'empty day' : `${d.count} items`}`);

  return ['# Archive', '', `${days.length} day${days.length === 1 ? '' : 's'} total.`, '', ...lines, ''].join('\n');
}

export function writeIndex(): void {
  writeFileSync(join(ROOT, 'archive/index.md'), renderIndex());
}
