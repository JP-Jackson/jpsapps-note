# Note — build specification

**note.jpsapps.com** · a capture-first day log for work and home
Owner: JP · Last updated: 6 September 2026

---

## 1. What this is

A tool for capturing moments as they happen and finding them again later. JP works in oil and gas automation, running a shop and going out to customer sites. He also maintains vehicles, a mower, an AC unit, a camera system and a Home Assistant install at home.

The core loop: pull the phone out, take a photo, dictate a line, put the phone away. Fifteen seconds. Later, from any desktop, review the day, close out follow-ups, and have real conversations with Claude about what's accumulated.

**The single most important property is capture speed.** If capture takes longer than about fifteen seconds, the habit dies and the whole thing is worthless. Every design decision should be checked against that.

---

## 2. Hard constraints

- **No Anthropic API spend.** JP has a Claude subscription and will not pay per token. Everything must work on the flat subscription plus Cloudflare's usage-based pricing.
- **Cloud-first.** No device is authoritative. Phone captures in the field, desktop reviews at the office, and the desktop is not always the same machine.
- **Must work offline.** Metal buildings and remote leases have no signal. A capture tool that fails in a dead zone is a capture tool that stops being trusted.
- **Exportable.** Plain JSON and markdown out, from day one.

---

## 3. Stack

| Layer | Choice | Notes |
|---|---|---|
| Compute | Cloudflare Workers | 100k requests/day free; cron triggers included |
| Database | Cloudflare D1 | 5 GB, 5M row reads/day, 100k row writes/day free |
| Photos | Cloudflare R2 | 10 GB free, no egress charges ever |
| Photo delivery | `img.jpsapps.com` bound to the R2 bucket | serves from cache, bypasses the Worker, doesn't consume request quota |
| Email | Resend | 3,000/month free; already connected to JP's account |
| In-app AI | Cloudflare Workers AI | 10,000 neurons/day free, then $0.011/1,000 |
| Real AI | Claude, via a custom MCP connector | on the subscription, no per-query cost |
| Source control | GitHub | for the app's code only, not for log data |

### Why these, and why not the alternatives

**D1 over Supabase.** JP raised concerns about Supabase limitations. D1 keeps everything under one roof, one bill, one auth story. It's SQLite underneath, which is the most portable database format there is — if Cloudflare ever stops being a good fit, the data moves almost anywhere without translation. R2 speaks the S3 protocol, so photos move by changing a connection string.

**Not GitHub for log data.** Every entry would be a commit; it's slow from a phone and wrong for an append-only stream. GitHub stays for the app's source.

**Not Obsidian.** It's a personal knowledge base — markdown files with good linking and search, built for thinking and writing. It is not a capture pipeline with location, photos and follow-up threads. Forcing it would mean fighting it.

**Not RAG at launch.** Proper retrieval needs an embedding model and costs per query. At a few hundred entries a month the log fits comfortably in a conversation whole, and full context beats retrieval because nothing gets missed by a bad search. Cloudflare Vectorize (30M queried dimensions/month free) is the escape hatch when the log outgrows a conversation. Adding it later is purely additive: backfill embeddings in one pass, add a search endpoint. An afternoon's work, nothing thrown away.

**Portability discipline.** Keep all database calls in one file. That makes the code cleaner regardless, and if a port is ever needed it touches one place. Do *not* build a database-agnostic abstraction layer — that's real cost for a hypothetical.

---

## 4. Data model

Three ideas: **entries** are what happened, **subjects** are the things involved, **places** are where. Everything else hangs off those.

```sql
-- ---------- people ----------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);
```

> **`user_id` goes on every table from day one.** This is the one thing in the whole design that is genuinely painful to retrofit — adding it after 2,000 entries means backfilling rows and rewriting every query. JP's wife will use the Home context. Everything else in this spec is additive; this is not.

```sql
-- ---------- the event stream ----------
CREATE TABLE entries (
  id            TEXT PRIMARY KEY,      -- generated on the device at capture time
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,      -- when it happened (device clock)
  synced_at     INTEGER,               -- when the server received it
  context       TEXT NOT NULL,         -- 'work' | 'home' | 'vehicles' | ...
  body          TEXT,                  -- the cleaned-up note
  body_raw      TEXT,                  -- original dictation, never overwritten
  lat           REAL,
  lng           REAL,
  place_id      TEXT REFERENCES places(id),
  activity_id   TEXT REFERENCES activities(id),
  is_open       INTEGER DEFAULT 0,     -- an unresolved follow-up
  resolved_by   TEXT REFERENCES entries(id),
  version       INTEGER DEFAULT 1,
  edited_at     INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX idx_entries_user_time ON entries(user_id, created_at DESC);
CREATE INDEX idx_entries_open      ON entries(user_id, is_open, created_at);
```

**Entries are append-only in spirit, editable in practice.** JP wants to fix typos. So edits are allowed, but `body_raw` preserves the original dictation forever and `edited_at` records the change. You can always re-derive from the original words; throw them away and they're gone.

```sql
-- ---------- one entry can touch several subjects ----------
CREATE TABLE entry_subjects (
  entry_id    TEXT NOT NULL REFERENCES entries(id),
  subject_id  TEXT NOT NULL REFERENCES subjects(id),
  PRIMARY KEY (entry_id, subject_id)
);
```

> A join table, not a column on `entries`. A single visit to a customer site can touch the site, the panel and the specific device. Retrofitting one-to-many later is a genuine pain; allowing it now costs one table.

```sql
-- ---------- the things ----------
CREATE TABLE subjects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,         -- 'generic' | 'vehicle' | 'equipment'
  context       TEXT NOT NULL,
  visibility    TEXT DEFAULT 'private',-- 'private' | 'shared'
  hero_photo_id TEXT REFERENCES attachments(id),
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER
);

-- variable detail without schema changes, ever
CREATE TABLE subject_attributes (
  subject_id  TEXT NOT NULL REFERENCES subjects(id),
  key         TEXT NOT NULL,           -- 'Engine oil', 'Tire size', 'VIN'
  value       TEXT,
  sort_order  INTEGER DEFAULT 0,
  PRIMARY KEY (subject_id, key)
);
```

> Key-value attributes rather than a table per thing type. A truck needs oil weight, tire size and VIN; a coffee cup needs one row or none. New kinds of things never require a migration.

```sql
-- ---------- what to ask when adding a new subject ----------
CREATE TABLE subject_templates (
  type        TEXT NOT NULL,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  sort_order  INTEGER DEFAULT 0,
  PRIMARY KEY (type, key)
);
```

**Start with exactly three types: generic, vehicle, equipment.** Generic asks name, make, model, notes — that covers about ninety percent of things, including the new bidet and the AC unit. Only promote something to its own template when you've added a third or fourth of that kind and you're tired of typing the same fields. Template sprawl would kill this; templates must earn their existence. Because attributes are key-value anyway, a generic subject can hold any field — the template's only job is remembering what to ask.

```sql
-- ---------- named places ----------
CREATE TABLE places (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,           -- 'Shop', 'Home', 'Baker Lease'
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  radius_m    INTEGER DEFAULT 150,
  created_at  INTEGER NOT NULL
);
```

Every entry stores raw coordinates **always**. Named places are matched by proximity and suggested, never forced — "at the Shop?" and you accept or ignore. After the second or third capture at an unnamed spot, offer to name it. This is also how arrival detection works without background GPS.

```sql
-- ---------- time as a stack, not a clock ----------
CREATE TABLE activities (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  parent_id   TEXT REFERENCES activities(id),
  label       TEXT NOT NULL,           -- 'At the shop', 'Compressor 2 — contactor'
  subject_id  TEXT REFERENCES subjects(id),
  context     TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
```

> JP is salaried; this is not a time clock. Something is always running, and it nests: *At the shop* → *Compressor 2 — contactor swap* → possibly a sub-task. The `parent_id` column permits any depth for free, but **the UI only ever surfaces the current activity and its parent.** Two levels covers essentially everything; deeper nesting is allowed by the data and ignored by the interface.

```sql
-- ---------- files, links, photos ----------
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  entry_id     TEXT REFERENCES entries(id),
  subject_id   TEXT REFERENCES subjects(id),
  kind         TEXT NOT NULL,          -- 'photo' | 'file' | 'url'
  r2_key       TEXT,
  url          TEXT,
  title        TEXT,                   -- fetched page title for urls
  mime         TEXT,
  bytes        INTEGER,
  created_at   INTEGER NOT NULL
);
```

One typed table so a photo, a PDF manual and a parts link all attach the same way, to an entry *or* a subject. The manual belongs on the machine, not scattered across entries.

```sql
-- ---------- saved context for Claude ----------
CREATE TABLE context_blocks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  context     TEXT,
  subject_id  TEXT REFERENCES subjects(id),
  updated_at  INTEGER NOT NULL
);

-- ---------- self-metered usage, for the quota bars ----------
CREATE TABLE usage_log (
  user_id     TEXT NOT NULL,
  day         TEXT NOT NULL,           -- 'YYYY-MM-DD' UTC
  metric      TEXT NOT NULL,           -- 'neurons' | 'rows_read' | 'rows_written'
  amount      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, metric)
);
```

Every D1 query returns a `meta` object with `rows_read` and `rows_written`; Workers AI returns neuron cost. Tally them here rather than polling Cloudflare's analytics API — accurate, instant, no external dependency.

---

## 5. Photos

Capture happens **inside the app**, not through the phone's camera app. That means photos land in R2 and are linked automatically. It also means they do not sync to Google Photos going forward, which is the accepted trade — Google Photos has no API available here, so anything stored there can never be searched or referenced by the app.

**Compress at capture time, not at upload.** 1600px on the long edge, JPEG quality 80. Nameplates and part numbers stay readable, and it's roughly a quarter the size. That's the difference between about 5,000 and about 20,000 photos in the free 10 GB. Compressing at capture also means a photo queued offline is already small, so a day of shooting in a dead zone doesn't fill the phone.

Video is not supported. It eats gigabytes and blows the storage model apart.

---

## 6. Offline and sync

**Expect to work offline. This is not optional.**

- Entry IDs are generated on the device. An offline entry is a new row that lands whenever it lands — two devices capturing at once produce two entries, never a collision. The append-only design is what buys this.
- Queued entries and compressed photos live in IndexedDB until there's signal.
- **Status indicator: a dot plus small text**, always visible in the header. Green with `SYNCED`; amber with `OFFLINE · 3 QUEUED`; a spinner while uploading. The word does the work, the colour confirms it.

**Conflicts only affect mutable data** — editing an entry, changing a subject's attributes, resolving a follow-up. Three defences, all cheap, build all three:

1. Every mutable record carries `version` and a modified timestamp. The client sends the version it started from; if the server has moved on, it rejects rather than overwrites.
2. A rejected edit is never silently dropped — show both versions and ask which to keep. Rare enough that a simple prompt is fine.
3. Field-level merge for non-overlapping changes. If JP edited the note text and his wife changed the oil weight, both apply. Only genuine same-field collisions reach the prompt.

---

## 7. Auth

- **Cloudflare Access** handles login — email and password, or a one-time code — with a long-lived session so it isn't a daily chore.
- **Passkeys** on top for fingerprint or face unlock. WebAuthn works in a home-screen web app and the biometric never leaves the device.
- The MCP connector's auth hangs off this, so it needs to be settled before the connector is built.
- **Sharing is scoped by context, not all-or-nothing.** JP's wife sees Home — the AC, the mower, the cameras. She never sees Work. Each subject carries a visibility setting defaulting to its context.

---

## 8. Claude integration

There is **no AI inside the app** that costs Anthropic money. Three separate mechanisms:

### 8a. MCP connector — the main event

The Worker exposes a remote MCP endpoint at `note.jpsapps.com/mcp`. JP adds it once in Claude under Customize → Connectors. After that he can ask Claude questions about his log *natively*, on the subscription, with no copy-paste and no per-query cost.

Facts that constrain the build:
- Custom connectors work on Free, Pro, Max, Team and Enterprise plans.
- **Claude connects from Anthropic's cloud, not from the local device**, so the endpoint must be reachable on the public internet. The Worker already is.
- This is private data — it needs real OAuth, not an authless endpoint.
- Claude supports both SSE and Streamable HTTP; SSE may be deprecated, so build Streamable HTTP.
- Cloudflare provides remote MCP server hosting with OAuth token management built in — use it rather than hand-rolling.
- Once added on the web, it works from Claude on iOS and Android too, so it's available in the field.

Tools the connector should expose: search entries, get a day, get a subject with its full history, list open items, get activity totals for a period.

### 8b. In-app chat — Workers AI

For quick lookups while standing in the shop. Llama 3.3 70B costs roughly 210 neurons per exchange (about 4,000 tokens in, 500 out), so the 10,000/day free allocation is around 45 questions a day. Past that it's about a quarter of a cent per question.

Handles "what did I do on Compressor 2 in March" perfectly well. It will **not** do the diagnostic reasoning-plus-web-search work — that's Claude's job, and the two are not redundant.

**Usage bars** on a settings page: AI neurons, database reads, database writes, storage, each as today's percentage. At 80% of the daily neuron allocation, the in-app chat button quietly changes from "Ask here" to "Ask Claude." The user never hits an error; the app routes to the free path when the cheap one runs low.

> Worth knowing: since 1 September 2026, D1 queries on the Workers Free plan **fail outright** when the daily row limits are exceeded, returning errors until midnight UTC. Stored data is unaffected but the app goes down. Index properly and watch the meter — it's a cliff, not a throttle.

### 8c. Handoff button

On a subject page: "Ask Claude about this." Because the connector exists, the button only needs to carry **the question** — "Look at Compressor 2's history and tell me why it keeps tripping on startup" — not the whole context. Claude fetches the data itself. Copy to clipboard, open Claude, paste. Two taps.

### 8d. The loop that makes this valuable

JP brings Claude a problem with full subject context. Claude searches the web — service bulletins, forum threads, the manual — and suggests causes. JP tries things, finds it, then logs an entry against that subject describing symptom, cause and fix. That fix is now permanently in the machine's history and is in the bundle next time before Claude even searches.

Year one is mostly searching the internet. Year three is mostly recognising your own patterns. The entry screen therefore needs a **"paste Claude's answer"** field — that's the mechanism that turns a conversation into permanent history.

---

## 9. Reference tools (no AI, no cost)

JP does not want to write a wiki about things that already exist. He wants tools and quick answers.

- **Modbus RTU frame parser.** Paste hex, get slave ID, function code, byte count, registers in both byte orders, float32 interpretation, and CRC-16 validation. Pure JavaScript, runs in the browser, costs nothing. (A working implementation exists in the mockup — reuse it.)
- **Unit converter.** °F/°C, psi/bar, gpm/L·min, in/mm.
- **Bookmarks** to manuals and specs actually used. Not rewriting them.
- **Context blocks** — the saved paragraphs described above. JP does not write these by hand; he talks them through with Claude, Claude drafts them, he pastes them in. Every time he has to explain something twice, that line gets added.

---

## 10. Design

**Structure: "Toolbox."** Chunky, tactile, glove-friendly. Buttons sit on a hard 4px bottom shadow and visibly depress. Large hit targets, high contrast.

**Palette: Hydraulic blue on navy chrome.**

```
--navy      #16222E   header, timer bar, chrome
--blue      #2C7BC4   primary action
--blue-deep #1B5486   button shadow
```

Light mode: bg `#E6E9EC`, card `#FFFFFF`, ink `#121A22`, ink-2 `#586573`, line `#D2D8DE`.
Dark mode: bg `#171B20`, card `#222831`, ink `#E6EBF0`, ink-2 `#94A1AE`, line `#323A45`, accent lifts to `#5AA9EE`.

Dark surfaces sit at 12–15% lightness, **not** near-black — text lands around 13:1 contrast without the glare of pure white on pure black. Accent colours brighten in dark mode rather than keeping the same hex; a red that works on white goes muddy on charcoal.

**Theme follows the system with a user override.** Every colour is a token, so a theme is a named set of values and a picker is about an hour's work. Ship the picker.

**Type:** Archivo (400/500/600/700) for UI, IBM Plex Mono for timestamps, metrics and small labels.

**Icon:** the JP monogram — one vertical stem shared by both letters, the J's arm reaching left across the top and its hook curving left at the bottom, the P's bowl on the right. White on a navy tile with a per-app colour keyline. Assets exist as `icon-note.svg` and `jp-mark.svg` (the latter uses `currentColor`).

**App family** — same mark, keyline colour differentiates:

| App | Keyline |
|---|---|
| Note (day log) | `#2C7BC4` |
| Bid (estimates) | `#2E9E63` |
| Parts | `#D9931A` |
| Crew | `#D9483C` |

**Splash:** `note-splash-final.html`, 4.21 seconds. The monogram draws itself, a pulse lays down the keyline and accelerates off the end, the border blooms, the name arrives, half a second of stillness, then it clears. Themed by a `data-app` attribute; the whole animation runs off four CSS variables. Plays on cold start only — a `sessionStorage` flag skips it on reload.

---

## 11. Build order

**Do not build this all at once.** Phases 1–3 make it useful; everything after is layered on.

1. **Foundation.** Worker, D1 schema, R2 bucket, `img.jpsapps.com` custom domain, Cloudflare Access + passkeys, `user_id` everywhere.
2. **Capture.** Home-screen web app. One big button: camera plus dictated note. Auto-stamps time, coordinates and current activity. Context chips, optional subject. Compress to 1600px/q80 on capture. Offline queue in IndexedDB with the dot-plus-text status indicator.
3. **Views.** Today's log, open items oldest-first, search, entry detail with the follow-up thread and the raw dictation preserved.
4. **Subjects.** List, detail with attributes and full history, three onboarding templates, hero photo, attachments. Bulk day-one import by pasting a Claude-structured list.
5. **Activities.** The nested timer stack. Smart prompts: if an entry is made with nothing running, ask when the day started; if it's gone quiet in the evening, ask when it ended. Always manually correctable after the fact. **No background GPS** — a web app can only read location while open, and chasing MacroDroid or geofencing burns a weekend for a couple of minutes of accuracy.
6. **MCP connector.** OAuth, Streamable HTTP, the tool set from §8a.
7. **Weekly digest.** Cron trigger Sunday evening, Resend HTML email: hours by activity, evening work flagged, open items, per-context summary. Deterministic, no AI.
8. **In-app chat + usage bars.** Workers AI, self-metered, with automatic routing to Claude near the cap.
9. **Reference tools.** Modbus parser, converter, context blocks, bookmarks.
10. **Export + Synology backup.** JSON and markdown endpoints. A scheduled job on the NAS pulls nightly — entries, subjects and photos, since R2 egress is free. This is a *backup*, not offline operation; running the app locally on Synology Docker is a possible future escape hatch, not something to build.

---

## 12. Open questions

- **The Base44 GitHub log.** JP keeps a separate repo of notes, zip snapshots and an HTML log tracking his work on the company's Base44 app. It should auto-attach to the right day and subject in Note. Mechanism not yet designed — probably a read-only fetch from the repo, matched by date, surfaced against an "App project" subject. **This is the one genuinely unresolved item.**
- Whether a URL parameter can prefill the Claude composer (would make the handoff one tap instead of two). Five minutes of testing will answer it.
- PNG icon exports at 192 and 512 for the home-screen install.

## 13. Explicitly deferred

- **Estimates** — separate app at `bid.jpsapps.com`. Different shape entirely: structured documents with a lifecycle (draft, revised, sent, won/lost), line items, pricing, customer drawings, PSIDs and ISO drawings, junction box callouts. Needs its own access control. Connects to Note only by tagging site visits to a job.
- **Vectorize / RAG** — add when the log stops fitting comfortably in a conversation.
- **Local hosting on Synology** — backup now, hosting probably never.
