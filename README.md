# Glory

A scheduled pipeline that collects new items from a fixed set of machine-readable sources
relevant to a React Native / mobile developer, ranks and annotates them with a single LLM
call, writes a dated Markdown digest into this repository, publishes it as a searchable
static site on GitHub Pages, and sends one Telegram message containing the link.

Single recipient. Read-only with respect to every source. No accounts, no UI, no real-time
alerting.

**Guiding principle:** collection is deterministic code; judgement is the LLM's, and only for
two of the four output sections. Whether a React Native release matters is never a judgement
call. If the LLM call fails, the digest still publishes.

**Language convention:** English throughout - code, comments, config keys, the LLM prompt,
and all rendered output (digest, Telegram, health issues).

---

## How it works

```
guard ──► fetch ──► threshold check ──► curate ──► render ──► commit ──► site build
  │                                        │                              │
  └─ exit 0 if today is done               └─ skip on failure             ▼
                                                                    Pages deploy
                                                                          │
                                                                          ▼
                                                                     Telegram
```

| Stage | File | What it does |
| --- | --- | --- |
| Guard | `src/guard.ts` | If `state/runs.json` says today is done, exit in seconds |
| Fetch | `src/adapters/*` | Every source in an isolated `try/catch`, all through `src/http.ts` |
| Threshold | `src/main.ts` | Abort before writing anything if >40% of required sources failed |
| Curate | `src/curate.ts` | One LLM call over `reading` + `video` candidates only |
| Render | `src/render/*` | Dated archive file, archive index, Telegram body |
| Publish | `.github/workflows/digest.yml` | Commit, MkDocs build, Pages deploy, then Telegram |

### Adapters vs sections

`adapter` is the fetch mechanism. `section` is the rendered bucket. **They are not 1:1** —
release notes arrive from three different adapters, and Apple Developer News arrives over
plain RSS but renders under `platform`. Every source entry declares both independently.

| Adapter | What it does | Notes |
| --- | --- | --- |
| `rss` | RSS 2.0 and Atom through one parser | Normalizes both field sets; strips HTML from snippets; drops nightlies/rc from release feeds |
| `youtube` | `feeds/videos.xml?channel_id=…` | Handles don't work on this endpoint — channel IDs are pinned in config. The feed always returns the latest 15 regardless of date, so `seen.json` is the only dedup |
| `npm` | `registry.npmjs.org` abridged packument | Tier-gated. First run baselines silently. A 404 marks the package private, permanently |
| `pagediff` | CSS selector text hash | For sources with no feed. Hashes the selector's *text*, never raw HTML |
| `discussions` | GitHub GraphQL | Discussions have no Atom feed and are absent from the REST API |

### Curation

One LLM call per run, `claude-sonnet-5` by default.

- **Input:** `config/profile.md` verbatim, plus only the `reading` and `video` candidates.
- **`releases` and `platform` are never sent.** They are gated deterministically by tier and
  by "did the page change".
- The requested `why` gloss is a single English reason, ≤ 12 words.
- Score threshold 55. An id missing from the response keeps `score: null` and sorts last
  rather than being dropped.
- **On failure** (after the SDK's retries): publish uncurated. `releases` and `platform` are
  unaffected and remain fully correct; `reading` and `video` render unranked, capped at 15,
  and the header carries `⚠️ curation skipped`.

---

## Repository layout

```
config/
  sources.yml            all non-npm sources, plus llm/telegram/caps settings
  deps.yml               npm tier lists + denylist
  package.snapshot.json  copy of the app repo's package.json (names only are read)
  profile.md             "who I am, what I care about" - fed to the LLM verbatim
src/
  main.ts                orchestration, CLI flags
  guard.ts               "already produced today?" check
  http.ts                timeout, retry, backoff, ETag, 429 handling
  dedup.ts               URL normalization + seen-key hashing
  curate.ts              the single LLM call + fallback
  health.ts              failCount / lastItemAt rules, issue payloads
  state.ts               JSON state read/write with sorted keys
  adapters/              rss, youtube, npm, pagediff, discussions
  render/                archive.ts, index.ts, telegram.ts
state/                   committed; see below
archive/                 committed; index.md + YYYY-MM-DD.md
scripts/                 resolve-youtube-ids.ts, probe-selector.ts
test/                    fixture-based adapter tests
```

`state/` and `archive/` are **committed to the repository**. The Actions cache is not durable
and is not used for state.

### State files

| File | Holds | Notes |
| --- | --- | --- |
| `runs.json` | `lastRunAt`, `lastSuccessDate` | Drives the guard and the collection window |
| `seen.json` | `key -> lastSeenISO` | 30-day TTL, pruned every run |
| `versions.json` | `pkg -> version` or `{visibility:'private'}` | npm baselines |
| `hashes.json` | `url -> {hash, at}` | pagediff baselines; `at` powers "last changed on X" |
| `etags.json` | `url -> {etag, lastModified}` | Conditional requests; a 304 skips parsing |
| `health.json` | `failCount`, `lastItemAt`, `disabledAt` | Source health and auto-disabling |

All state is written with sorted keys and two-space indent so diffs stay readable in a
GitHub commit view.

---

## Running locally

```bash
npm install

npm run digest -- --dry-run     # print the rendered Markdown, touch no state
npm run digest                  # real run: writes archive/ and state/
npm run digest -- --force       # bypass guard, ignore seen.json, skip all state writes
npm test                        # fixture tests
npm run typecheck
```

`GITHUB_TOKEN` is needed for the `discussions` adapter (`GITHUB_TOKEN=$(gh auth token)`
locally). `ANTHROPIC_API_KEY` is needed for curation — without it the run still completes
via the uncurated fallback.

### Helper scripts

```bash
# Resolve YouTube handles to channel IDs and verify each feed returns entries
npx tsx scripts/resolve-youtube-ids.ts @ByteByteGo @hnasr

# Validate a pagediff selector: fetches twice, hashes must match
npx tsx scripts/probe-selector.ts https://expo.dev/changelog article main
```

---

## Configuration

### `config/sources.yml`

```yaml
- id: hn-frontpage
  adapter: rss              # rss | youtube | npm | pagediff | discussions
  section: reading          # releases | platform | reading | video
  url: https://hnrss.org/frontpage?points=150
  title: "Hacker News"      # display label in rendered output
  required: false           # excluded from the >40% abort calculation
  silenceExempt: true       # skip the 45-day zero-items alarm
  userAgent: "…"            # per-source override
  selector: "main"          # pagediff only
  channelId: UC…            # youtube only
  repo: owner/name          # discussions only
```

Tail of the same file:

```yaml
telegram: { criticalPrefix: true }      # one-line switch for the ⚠️ prefix
llm:      { model: claude-sonnet-5, scoreThreshold: 55 }
caps:     { reading: 8, video: 6 }
```

### `config/deps.yml`

`tier1` reports every release including patches, `tier2` reports minor and major only,
everything else falls to `defaultTier: 3` (major only). The package *list* comes from
`config/package.snapshot.json` — a committed copy of the app repo's `package.json`, so this
repo needs no access to the app repo. **Update that snapshot by hand when dependencies
change.**

### `config/profile.md`

Hand-written, passed to the LLM verbatim. The "not interested in" half does more filtering
work than the "interested in" half — keep it specific.

---

## Scheduling

Five identical cron slots, all guarded. This is **not** a retry chain: the slots are
independent, because a retry chain cannot recover the case where the job never triggers at
all, and GitHub's scheduler does drop runs during platform incidents.

| Cron (UTC) | TR | Role |
| --- | --- | --- |
| `7 5 * * *` | 08:00 | primary |
| `7 8 * * *` | 11:00 | guarded |
| `7 11 * * *` | 14:00 | guarded |
| `7 14 * * *` | 17:00 | guarded |
| `7 17 * * *` | 20:00 | last chance |

Minute 7 is deliberate — the top of the hour is the most congested slot on the shared Actions
scheduler. Slots that hit the guard cost about 15 seconds. `concurrency.cancel-in-progress:
false` matters: a slow 11:00 run must queue the 14:00 slot rather than race it, or two jobs
`git push` simultaneously.

Timezone is `Europe/Istanbul`, fixed UTC+3, no DST since 2016 — cron expressions are static.

There are no overnight slots. If all five fail, tomorrow's 08:00 run picks up a ~48-hour
window and delivers a double-size digest (headed `⚠️ 48 saatlik pencere`), which beats a
02:00 "daily" notification.

---

## Error handling

Retries are the last resort, not the first. `ETag` / `Last-Modified` are stored per URL and
replayed as `If-None-Match` / `If-Modified-Since`; a `304` skips parsing entirely.

| Condition | Behaviour |
| --- | --- |
| Timeout, 5xx, DNS failure | 3 retries, exponential backoff with jitter (1s → 3s → 9s) |
| `429` | Honour `Retry-After`, else 30s; 2 attempts |
| `403`, `404` | No retry. Durable, `failCount++` |
| npm `404` | Marked private, permanent skip, never surfaced as an error again |
| >40% of **required** sources failed | Archive not written, job fails. A garbage digest is worse than no digest |
| LLM failure | Publish uncurated |
| `git push` non-fast-forward | `pull --rebase` then retry, ×3 |
| Pages deploy failure | Telegram links the raw file on github.com instead — GitHub renders Markdown natively |
| Telegram 5xx | 3 retries, then log only. Content is already committed; no data loss |
| All five slots failed | Open or update a `digest-failure` issue, **then** a best-effort Telegram one-liner |

The issue is the primary failure channel: if the failure is network-layer, Telegram cannot be
reached either.

### Source health

`state/health.json` tracks `failCount` and `lastItemAt` per source, because retries cannot
fix a source that is structurally broken:

| Threshold | Action |
| --- | --- |
| 3 consecutive failed days | Open or update a `digest-health` issue |
| 14 consecutive failed days | Auto-disable the source **in state, never in config** |
| 45 days with zero items | Silent-death suspicion — open an issue |

The last rule catches the nastiest failure mode: a source returning `200` with valid XML that
has been empty for weeks. A renamed YouTube channel ID behaves exactly like this and no
amount of retrying detects it. Disabling lives in state rather than config on purpose — the
config file belongs to the owner and the script must not silently rewrite it.

To re-enable a disabled source, delete its `disabledAt` field in `state/health.json`.

---

## Output

### `archive/YYYY-MM-DD.md`

Sections are ordered by actionability: things that can break your build come before things
that can break your store submission, which come before optional reading. Empty sections are
omitted entirely rather than rendered with a "nothing here" line.

```markdown
---
date: 2026-09-12
generated: 2026-09-12T08:03:11+00:00
count: 4
---

# September 12, 2026

### 📦 Releases

- **react-native 0.81.5 → 0.82.0** · minor 🔴 · [notes](…)
- **expo-image 3.0.11 → 3.0.12** · patch · [notes](…)

### ⚠️ Platform & Policy

- **App Store Review Guidelines changed** · ~1,400 characters · last changed June 14 · [page](…)

### 📄 Reading & Discussions

- [Title](…) · *source* · one-line reason it matters

### 🎥 Video

- [Title](…) · *@channel* · one-line reason it matters

---
⚠️ 1 source could not be retrieved: r/reactnative
```

🔴 marks a breaking change: a major bump, or a minor bump while the major version is still
`0` (RN 0.81 → 0.82 carries breaking changes).

**Empty-day policy:** if nothing survives, the file is a single line (`Nothing new today.`)
and **no Telegram message is sent**. Expect this on weekends. If the only items are
tier-3 patch bumps, the day is treated as empty too — notification fatigue kills this system
faster than any bug.

### Telegram

Plain text, link only. No `parse_mode` — this sidesteps MarkdownV2 escaping, which reliably
breaks on the `_` and `.` in package names.

```
⚠️ react-native 0.82.0 + App Store Review Guidelines changed
Here is your daily digest 👇
https://gorkemozkan.github.io/glory/archive/2026-09-12/
```

The critical prefix trigger is deterministic, never LLM-driven: a tier-1 minor or major bump,
or any new `platform` item. Its purpose is narrow — an always-identical message trains the
recipient to stop opening it within about two weeks. Set `telegram.criticalPrefix: false` to
turn it off.

The message is sent **after** the Pages deploy succeeds; deploying takes 60–90 seconds and a
link sent earlier 404s.

---

## Deployment setup

1. **Secrets** — repository → Settings → Secrets and variables → Actions:

   | Secret | Use |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | Curation call |
   | `TELEGRAM_BOT_TOKEN` | Delivery |
   | `TELEGRAM_CHAT_ID` | Delivery |

   `GITHUB_TOKEN` is provided by Actions and is used for the Discussions GraphQL query and
   for issue creation. Workflow permissions are `contents: write`, `issues: write`,
   `pages: write`, `id-token: write`.

2. **Pages** — Settings → Pages → Source: **GitHub Actions**.

3. **Labels** — create `digest-health` and `digest-failure`.

4. **Snapshot** — replace `config/package.snapshot.json` with the real `package.json` from
   the app repo.

5. **Profile** — edit `config/profile.md`. This is the only feedback loop in the system.

The repository is public and nothing secret is committed.

> **Known platform behaviour:** GitHub disables scheduled workflows in repositories with 60
> days of no activity. Normal operation commits daily so this never triggers, but 60
> consecutive failed days would silently kill the cron itself. The health rules surface
> trouble long before that.

---

## Adding a source

```yaml
# A feed
- { id: my-feed, adapter: rss, section: reading, url: https://…/feed, title: "My Feed" }

# A YouTube channel — resolve the ID first, handles do not work
- { id: yt-x, adapter: youtube, section: video, handle: "@x", channelId: UC… }

# A page with no feed — validate the selector first
- { id: my-page, adapter: pagediff, section: platform, url: https://…, selector: "main", title: "My Page" }
```

For `pagediff`, run `scripts/probe-selector.ts` and confirm the selector is reported
`STABLE`. If it isn't, the selector is still capturing nonces, ad slots or build hashes and
every run would report a diff. Prefer a slightly noisy selector over a brittle narrow one —
for policy pages a false negative is far more costly than a false positive.

New `pagediff` and `npm` entries emit nothing on their first run; they only record a
baseline.

---

## Testing

```bash
npm test
```

Fixture tests cover Atom vs RSS 2.0 field mapping, prerelease filtering, URL normalization
(every dropped param), the seen-TTL prune, semver tier gating for all three bump types,
`pagediff` hash stability against volatile markup, npm 404 → private marking, npm first-run
baselining, render line shapes, the empty-day and tier-3-patch silence policies, the Telegram
prefix trigger, Istanbul date handling, and all three source-health escalations.

Verified end to end against live sources:

- First-ever run emits **zero** `npm` and `pagediff` items and populates 47 package baselines
  plus 3 page hashes.
- A second run on unchanged sources produces an empty digest and sends no Telegram message.
- Running twice in one day produces exactly one archive file; the guarded run exits in ~0.4s.
- A missing API key still produces a complete, correct `releases` + `platform` digest carrying
  the `curation skipped` note.
- Forcing 16/33 required sources to fail aborts with exit code 1 and leaves the archive
  untouched.
- `--dry-run` mutates no state file.

---

## Deliberate non-goals

Not built, and not to be added as "natural extensions":

- Real-time or breaking-news notification. This is a daily batch.
- Full-article fetching and deep summarization. Headline curation only.
- X/Twitter as a first-class source.
- A recommendation engine that learns from behaviour. The only feedback loop is
  `config/profile.md`.
- Any web UI beyond the generated static site.
- Multi-user support, auth, or accounts.

## Known gaps

- **Dropped sources**, documented at the bottom of `config/sources.yml`:
  `expo/expo/releases.atom` (valid feed, permanently empty), `reactnative.directory` (server
  HTML is a `__NEXT_DATA__` blob whose download counts churn daily), the upgrade-helper
  (fully client-rendered, 611 bytes of HTML), and `blog.expo.dev/feed` (dead Medium mirror,
  newest post 2024-05).
- **`reactwg/react-native-releases`** is configured but near-silent since 2025, so it is
  marked `silenceExempt`. `facebook/react-native/releases.atom` covers most of the same
  ground.
- **r/reactnative** is best-effort. Reddit returns 403 to Actions runner IP ranges
  frequently; it is `required: false` and a 403 is never retried.
- **Private packages** on the denylist are exactly the kind that break a build silently, and
  the digest does not watch them. That channel stays with the team.
- **Shorts** are indistinguishable from normal videos without the YouTube Data API. Rather
  than add that dependency they are passed to curation with a `kind: 'video'` hint and left
  to sink on a low score.
