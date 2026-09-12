export type Section = 'releases' | 'platform' | 'reading' | 'video';
export type Adapter = 'rss' | 'youtube' | 'npm' | 'pagediff' | 'discussions';

export interface Item {
  key: string;          // sha1(sourceId + '|' + normalizeUrl(url))
  sourceId: string;
  section: Section;     // from source config; the LLM may not change it
  title: string;
  url: string;
  publishedAt?: string;
  snippet?: string;
  kind?: 'video';
  meta?: {
    fromVersion?: string;
    toVersion?: string;
    bump?: 'major' | 'minor' | 'patch';
    tier?: 1 | 2 | 3;
    changedChars?: number;
    lastChangedAt?: string;
  };
  score?: number | null;
  why?: string;
  flag?: 'breaking' | null;
}

export interface SourceConfig {
  id: string;
  adapter: Adapter;
  section: Section;
  url?: string;
  selector?: string;
  channelId?: string;
  handle?: string;
  repo?: string;
  title?: string;       // human-readable label, used in rendered output
  required: boolean;
  silenceExempt?: boolean;
  userAgent?: string;
  timeoutMs: number;
  retries: number;
}

export interface Config {
  sources: SourceConfig[];
  telegram: { criticalPrefix: boolean };
  llm: { model: string; scoreThreshold: number };
  caps: { reading: number; video: number };
}

export interface Runs { lastRunAt?: string; lastSuccessDate?: string }
export type Seen = Record<string, string>;                                  // key -> ISO
export type Versions = Record<string, string | { visibility: 'private' }>;  // pkg -> version
export type Hashes = Record<string, { hash: string; at: string }>;
export type Etags = Record<string, { etag?: string; lastModified?: string }>;
export type Health = Record<string, {
  failCount: number;
  lastItemAt?: string;
  disabledAt?: string;
  issueOpenedFor?: 'fail' | 'silence';   // which condition already has an open issue
}>;

export interface Ctx {
  seen: Seen;
  versions: Versions;
  hashes: Hashes;
  etags: Etags;
  health: Health;
  since?: string;      // runs.lastRunAt
  force: boolean;
}

export interface SourceResult {
  sourceId: string;
  items: Item[];
  error?: string;
}
