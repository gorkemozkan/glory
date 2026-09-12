import { read } from './state.js';
import { istanbulDate } from './render/archive.js';
import type { Runs } from './types.js';

/**
 * Exit within seconds if runs.json already marks today. This makes the whole pipeline
 * idempotent: it can run five times a day, be triggered manually, or be retried by CI,
 * and still produce exactly one digest per day.
 */
export function alreadyRanToday(): { done: boolean; runs: Runs } {
  const runs = read<Runs>('runs.json', {});
  return { done: runs.lastSuccessDate === istanbulDate(), runs };
}
