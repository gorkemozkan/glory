import type { Health, SourceConfig, SourceResult } from './types.js';

export const FAIL_ISSUE_DAYS = 3;
export const FAIL_DISABLE_DAYS = 14;
export const SILENCE_DAYS = 45;

export interface Alert { key: string; title: string; body: string }

/**
 * Retries cannot fix a structurally broken source, so escalate instead:
 * 3 days -> issue, 14 days -> disabled in state, 45 days with zero items -> silent-death
 * suspicion. Disabling lives in state, never in config: the config file belongs to the
 * owner and this script must not silently rewrite it.
 */
export function updateHealth(
  health: Health, sources: SourceConfig[], results: SourceResult[], now = new Date(),
): Alert[] {
  const alerts: Alert[] = [];
  const iso = now.toISOString();
  const byId = new Map(sources.map(s => [s.id, s]));

  for (const r of results) {
    const h = health[r.sourceId] ??= { failCount: 0 };
    if (r.error) h.failCount++;
    else {
      h.failCount = 0;
      delete h.disabledAt;
      if (h.issueOpenedFor === 'fail') delete h.issueOpenedFor;
      if (r.items.length) h.lastItemAt = iso;
    }
    h.lastItemAt ??= iso;   // first sighting: start the silence clock now
  }

  for (const [id, h] of Object.entries(health)) {
    const src = byId.get(id);
    if (!src) continue;

    if (h.failCount >= FAIL_DISABLE_DAYS && !h.disabledAt) {
      h.disabledAt = iso;
      alerts.push(alert(id, `${id}: failed for ${h.failCount} days, disabled`,
        `\`${id}\` has failed consecutively for ${h.failCount} days. It was disabled in state/health.json (config was not changed). Remove \`disabledAt\` when it is fixed.`));
      h.issueOpenedFor = 'fail';
    } else if (h.failCount >= FAIL_ISSUE_DAYS && h.issueOpenedFor !== 'fail') {
      h.issueOpenedFor = 'fail';
      alerts.push(alert(id, `${id}: failed for ${h.failCount} days`,
        `\`${id}\` has failed consecutively for ${h.failCount} days. It will be disabled automatically on day ${FAIL_DISABLE_DAYS}.`));
    }

    // 200 + valid XML + empty for weeks is the nastiest failure mode. A renamed YouTube
    // channel ID behaves exactly like this and no amount of retrying detects it.
    const silentDays = h.lastItemAt ? (now.getTime() - Date.parse(h.lastItemAt)) / 86400_000 : 0;
    if (!src.silenceExempt && silentDays >= SILENCE_DAYS && h.issueOpenedFor !== 'silence' && !h.failCount) {
      h.issueOpenedFor = 'silence';
      alerts.push(alert(id, `${id}: zero items for ${Math.floor(silentDays)} days`,
        `\`${id}\` has not errored, but has produced no items for ${Math.floor(silentDays)} days. The selector may be broken, the channel ID may have changed, or the feed may be empty.`));
    }
  }
  return alerts;
}

export const isDisabled = (health: Health, id: string) => Boolean(health[id]?.disabledAt);

const alert = (key: string, title: string, body: string): Alert => ({ key, title, body });
