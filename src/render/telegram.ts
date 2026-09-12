import type { Item, SourceConfig } from '../types.js';

/**
 * Plain text, link only. No parse_mode: MarkdownV2 escaping reliably breaks on the
 * `_` and `.` characters in package names.
 */
export function telegramBody(
  url: string, items: Item[], sources: Map<string, SourceConfig>, criticalPrefix: boolean,
): string {
  const lines: string[] = [];
  if (criticalPrefix) {
    const critical = criticalReasons(items, sources);
    if (critical.length) lines.push(`⚠️ ${critical.join(' + ')}`);
  }
  lines.push('Here is your daily digest 👇', url);
  return lines.join('\n');
}

/**
 * The trigger is deterministic, never LLM-driven: a tier-1 minor or major bump, or any
 * new platform item. The purpose is narrow - an always-identical message trains the
 * recipient to stop opening it within about two weeks.
 */
function criticalReasons(items: Item[], sources: Map<string, SourceConfig>): string[] {
  const reasons = [
    ...items
      .filter(i => i.section === 'releases' && i.meta?.tier === 1 && (i.meta.bump === 'minor' || i.meta.bump === 'major'))
      .map(i => `${i.title} ${i.meta!.toVersion}`),
    ...items
      .filter(i => i.section === 'platform')
      .map(i => `${sources.get(i.sourceId)?.title ?? i.title} changed`),
  ];
  return reasons.slice(0, 3);
}

/** If only tier-3 patch bumps survive, treat the day as empty. Notification fatigue kills this. */
export function worthNotifying(items: Item[]): boolean {
  return items.some(i => !(i.section === 'releases' && i.meta?.tier === 3 && i.meta.bump === 'patch'));
}
