import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function read<T>(name: string, fallback: T): T {
  const p = join(ROOT, 'state', name);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf8')) as T; }
  catch { console.warn(`state/${name} is invalid; starting from scratch`); return fallback; }
}

/** Two-space indent + sorted keys, so state diffs stay readable in a commit view. */
export function write(name: string, data: unknown): void {
  writeFileSync(join(ROOT, 'state', name), JSON.stringify(sortKeys(data), null, 2) + '\n');
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v) || v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, val]) => [k, sortKeys(val)]));
}
