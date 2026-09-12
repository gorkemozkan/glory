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

For `pagediff`, validate the selector first — it fetches the page twice and the two hashes
must match:

```bash
npx tsx scripts/probe-selector.ts https://expo.dev/changelog article main
```

Confirm the selector you pick is reported `STABLE`. If it isn't, it is still capturing
nonces, ad slots or build hashes and every run would report a diff. Prefer a slightly noisy
selector over a brittle narrow one — for policy pages a false negative is far more costly
than a false positive.

New `pagediff` and `npm` entries emit nothing on their first run; they only record a
baseline.
