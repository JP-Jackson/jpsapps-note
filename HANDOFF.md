# Note — handoff

Written 7 Sep 2026, at **v1.22.0**. `NOTE_SPEC.md` is the authority: where it states a
decision and a reason, follow it rather than substituting a different approach.

## Where things stand

Phases 1–6 of §11 are built and deployed. Every push to `main` deploys automatically.

| Thing | Value |
|---|---|
| Worker | `https://note.jpsapps.com` — live, behind Access |
| Photos (public) | `https://img.jpsapps.com` → `note-photos` |
| Documents (private) | `note-files` — no custom domain, reachable only through the Worker |
| D1 | `note` — `416aa6a6-0c76-4f21-88eb-56a73c3d25bc` (ENAM) |
| Zero Trust team | `jpsapps.cloudflareaccess.com` |
| Access app | `Note` — AUD `38735e0c…163b92c`, plus six bypass apps for `/mcp` and OAuth |
| MCP connector | `https://note.jpsapps.com/mcp` — connected, 7 tools |
| Account | jpsappshq@gmail.com — `bf9f771dae485c448a5740c54ca5771d` |

Migrations applied: `0001_init`, `0002_subjects`, `0003_oauth`, `0004_hierarchy`.
Secrets: `OAUTH_SECRET`.

**Live data, as of v1.21.0.** Three things exist and nest: `Yard` → `Front sprinkler`,
plus a loose `Air conditioner`. The places `Home` and `Rental` do **not** exist yet —
they need coordinates, and neither the MCP connector nor a sandboxed session can
create a place. JP adds those two from the map picker, then drags the two things into
them. Do not invent coordinates for him.

## Two rules that must not be relaxed

1. **`user_id` on every table.** Only `users` (its `id` is the user id) and
   `subject_templates` (global reference data) are exempt.
2. **All D1 access lives in `src/db.ts`.** Nothing else imports `D1Database` or writes
   SQL. `Db` is constructed with a user id in middleware; handlers never see one. This
   is why OAuth went into D1 rather than the KV-backed reference provider.

## Cloudflare account situation

- Everything belongs in the **jpsappshq@gmail.com** account, ID above.
- Do **not** create anything in the account holding `polk-*` resources — that is
  work-related and separate. The Cloudflare MCP tools in a session may well be pointed
  at it; check before trusting them.
- `footballplays.jpsapps.com` is still down. Its Worker is in the old
  ftmtit51@gmail.com account and the custom-domain binding was lost in the registrar
  transfer. Unrelated to Note.
- Workers KV is **not reachable** with the current API token (`Authentication error
  [code: 10000]`; D1, R2 and Access on the same token are fine). Nothing needs it.

## What is built, beyond the spec's phase list

- **Delete.** Notes are deletable for 15 minutes after capture, then permanent. A note
  still in the offline queue can be discarded outright. Things, places, activities and
  files delete with no window. Objects are removed from R2, not merely unlinked.
- **Attachments.** PDFs and other files against a note or a thing, split by MIME:
  images to the public bucket, everything else to the private one, always downloaded
  and never rendered.
- **Install flow.** Settings and the capture screen offer it; iPhone gets written
  steps because Apple has no `beforeinstallprompt`.
- **Usage bars**, **cover photos**, **post-save linking**, **capture from a thing**.
- **Hierarchy for things** (v1.19.0). `subjects.parent_id` and `subjects.place_id`,
  one additive migration, places as the roots — the model this file proposed. Things
  nest to any depth; the Things tab draws the tree with foldable branches and keeps
  the flat list behind a toggle. Decisions worth not re-arguing:
  - **Only one of the two columns is ever set.** A child inherits its place from its
    root, so writing the place on every descendant would be a second copy of the same
    fact and the copy is what goes stale the first time a branch moves. `setHome` in
    `db.ts` enforces it; sending both keeps the parent.
  - **Deleting a thing promotes its children** into whatever it was inside, rather
    than cascading. A confirm that names one thing must not delete four.
  - **Deleting a place** leaves the things that were rooted there and only unfiles
    them — the same reasoning as entries keeping their coordinates.
  - **Cycles are refused server-side** by walking up from the proposed parent, and
    the client never offers a thing its own branch. The tree renderer also has a
    depth guard: a corrupt row should not hang the tab.
  - **The tree is assembled on the client** from the one flat `/api/subjects`
    response. No recursive CTE — at this scale it would be a second way to be wrong
    about the same shape.
  - The capture payoff is in: after saving, things that live where you are rank
    second, behind a thing the note actually names. Evidence beats geography.
- **Dragging the tree** (v1.21.0). Press-and-hold a row and drop it on a thing, a
  place heading, or "Not in a place". A `+` on every row and heading opens the Add
  screen already filed. Two things here were invisible from the code and only showed
  up in the browser:
  - **`touch-action` is read once, when the finger lands.** Setting `touch-action:
    none` when the drag begins does nothing to the gesture in flight, so Chromium
    decided the first movement after the hold was a scroll, took the gesture over and
    fired `pointercancel` — dropping the thing before it moved. Fixed by a
    **non-passive** `touchmove` listener that `preventDefault()`s while dragging. Do
    not "tidy" that into a passive listener; a passive one cannot preventDefault and
    the whole feature dies silently on phones.
  - **Mouse and touch want opposite things from press-and-move.** A mouse drags on
    movement; a finger must hold first, because press-and-move is how you scroll.
    Split on `e.pointerType`.
  - Every place is a heading now even when empty — an empty place that is not drawn
    is a place nothing can be dragged into.
- **Places from a map** (v1.20.0). A pin picker, because "add where I am now" can only
  ever answer where the phone is — and the two failures already written down here are
  both cases where that is wrong. Notes:
  - **Hand-rolled, not Leaflet.** A centre-pinned slippy map is Web Mercator and a
    grid of `<img>`. Pulling in a library would have been the first runtime
    dependency in an app that self-hosts even its fonts.
  - **Tiles come from `tile.openstreetmap.org`** — free, no key, no account. The
    attribution in `#mapAttr` is required by the licence, not decoration. This is the
    only third-party fetch in the app; the service worker already ignores
    cross-origin requests, so nothing needed to change there.
  - **The pin never moves, the world moves under it.** Same as every ride app, and it
    avoids dragging a marker under the fingertip covering it.
  - **The radius ring is drawn at its real ground size**, so zooming halves it. That
    is the point: it shows how close counts as being there.
  - The tests assert nothing about tiles — a suite that goes red because someone
    else's CDN is slow is a suite you learn to ignore. The Mercator maths, the drag
    and the saved coordinates are all checked through the coordinate readout.

## What is left

From §11: **7** weekly digest, **8** in-app chat (the usage bars are done), **9**
reference tools, **10** export and Synology backup.

Also outstanding:

- **Photos attached via the paperclip are not compressed.** The in-app camera does
  1600px/q80 per §5; the file-attach path uploads the original. A phone photo is
  ~1.5 MB against a 10 GB bucket.
- **EXIF from attached photos.** A photo taken on site and written up later carries the
  right coordinates and time while the capture carries the wrong ones. The plumbing
  works — EXIF survives the attach path intact — but JP's camera currently writes the
  GPS tags as zeros, so location tagging has to be turned on first.
- **Quick-phrase row for capture.** Asked for repeatedly, never answered; still blocked
  on five phrases JP actually types.
- **Theme and font do not sync between devices.** Stored per browser. Needs one column
  on `users`.
- `actions/checkout@v4` and `setup-node@v4` are on a deprecated Node.

## Known defects

The four places-layer defects found on 7 Sep are **fixed in 1.22.0** — that was
section 1 of the plan. What shipped, and the parts worth not re-deriving:

- **Creating a place failed silently with no signal.** Both `addPlaceHere` and the
  map picker's `mapSave` did a bare `fetch` with no `try`/`catch`; offline a fetch
  *rejects* rather than answering, so `if (!r.ok)` was unreachable and the handler
  died on an unhandled rejection. Both now go through one `savePlace()` helper that
  returns `{ok, why}` and never throws. **Keep every caller on it** — this failure
  is invisible in review and silent in use, which is exactly how it survived to 1.21.
- **A place can be renamed and re-pinned.** The pencil on a row opens the *same* map
  picker in edit mode (`mapEditing`), prefilled with the name and radius and centred
  on the place. One screen, because dropping a pin and moving one are the same act.
  `renamePlace` became `updatePlace(id, patch)` and `PATCH /api/places/:id` now takes
  name, coordinates and radius. Two rules worth keeping: **lat and lng move together
  or not at all** (half a move is a pin somewhere neither place has ever been), and
  **editing deliberately does not re-run `claimEntriesForPlace`** — naming a spot
  explains the captures already made there, but nudging the pin afterwards is a
  correction, not a fresh claim on whatever is now nearby.
- **The delete confirm counts what it unfiles.** `listPlaces` returns a `things`
  count per place and the confirm names it before asking. The rule from the hierarchy
  work holds: a confirm that names one thing must not quietly change four.
- **The map admits when it cannot work.** `openMapPick` refuses offline and explains
  itself in the places list, and the "Pick on a map" button re-renders on the
  `online`/`offline` events rather than going stale. There is a second signal beyond
  `navigator.onLine`: a **tile `onerror`** shows a banner, because a phone on a metal
  building's wifi with no route out still reports online, and whether the tiles
  actually arrive is the honest test. The first tile that loads clears it.

`tests/placesedit.mjs` covers all four, and its centre of gravity is the data-loss
path: a thing rooted at a place and a note naming it both survive a rename plus a
re-pin. It also drives the offline branches through `context.setOffline`.

## The plan, in order

Agreed with JP on 7 Sep, after v1.21.0. Reasons are written down so this is not
re-argued from scratch.

### 1. The places layer — done in 1.22.0

The defects above. First not because it was the most valuable work but because the
delete-and-recreate path was destroying data. See **Known defects** for what shipped.

### 2. Things offline — the real job

**JP loses signal at the rental. Confirmed, not hypothetical.** §6 says offline is
not optional, and §8d's entire justification for the thing page is standing in front
of the machine reading what you did last time — which is exactly when there are no
bars. Today the Things tab answers "Offline — things need a connection" and a thing's
page answers "Could not load that", so the app fails at its own stated purpose in the
one place that matters most.

- **One bounded sync endpoint**, `GET /api/sync`: every subject, their attributes,
  all places, and the most recent ~500 entry-to-thing links with their bodies. Not
  per-thing fetching. **The cap is the point** — since 1 September, D1 queries on the
  free plan fail outright past the daily row limit rather than throttling (which is
  why the usage bars exist), so an unbounded pre-fetch is a cliff, not a slow page.
- **Cached in IndexedDB**, beside the existing queued-entry and queued-link stores;
  refreshed on app open when online and after a write. `loadPlaces` already caches to
  localStorage and falls back to it, so the pattern is established — this extends it.
- **Reads offline, writes online, with one exception.** Moving things about the tree,
  editing attributes and attaching files are desk jobs; keeping them online-only
  avoids conflict resolution on the tree entirely. The exception is **naming the
  place you are standing in**, which is a field action of the same shape as capture.
  GPS works offline — it is satellites, not signal — so "Add where I am now" must
  queue rather than fail. The map picker stays online-only and says so.
- **A queued place needs a device-generated id**, the way entries already do (§4:
  "generated on the device at capture time"). Places take a server id today. And
  **flush order matters**: a note captured at a queued place must sync *after* the
  place it points at, or its `place_id` lands on nothing. This is the trap in this
  piece of work — invisible in review, silent when it fails.
- **The page must admit it is a snapshot.** `sw.js` already argues that a capture
  tool which lies about what synced is worse than one that says "offline". Same rule
  here: offline, a thing's page says what it is showing and when it last synced.
- **Photos are out of scope for round one.** Covers come from `img.jpsapps.com`, a
  different origin the service worker deliberately ignores. Text and attributes work;
  images fall back to their placeholder.

### 3. The tree is the spine

JP, 7 Sep: *"the tree is likely key to organizing everything."* Two things ranked low
before that move up once it is true:

- **You cannot find a thing.** Search searches notes; the Things list has no filter.
  At a shop's worth of equipment the tree is unusable without one.
- **Places are administered from a chip on the capture screen**, but they have been
  the roots of the tree since 1.19. Managing them belongs with the thing they root.

### 4. Carried over

The uncompressed paperclip photos, theme and font not syncing, the deprecated Actions
runners. Then §11's remaining phases — digest, in-app chat, reference tools, export.
Those wait until the tree and places feel finished; half-built foundations under new
features is how this gets messy.

## Things that cost time, so they are written down

- **The tests are the reason most bugs were found.** `npm run test:ui` — 254
  assertions, twelve files, all honouring `NOTE_URL`. They are not in CI because they
  need a live dev server. Almost every bug this session was invisible from reading the
  code: a `history.back()` race, delegated listeners stacking on a container that
  outlives its render, an `onerror` handler quietly removing the photos a test was
  asserting about.
- **A fixed nav over a perfectly good element.** `nav` is fixed across the bottom and
  the header is sticky at the top, so a row underneath either is not hidden — it is
  covered. It reports a normal bounding box and every click lands on the nav instead.
  Leftover rows from earlier runs pushed a passing drag test under the nav and turned
  it red with nothing wrong in the app. `tests/treedrag.mjs` centres both ends of
  every drag and asserts they clear both bars.
- **Dragging needs two points on one screen**, which "do not assume an empty
  database" does not cover on its own. `treedrag.mjs` names its places with a `zz`
  prefix so they sort last, directly above "Not in a place", keeping every drag
  local however much junk an earlier run left behind. It also deletes what it made.
- **The tests must not assume an empty database.** Anything counted or matched by text
  is tagged unique to the run and subjects are addressed by id. Several hours went into
  chasing failures that were leftover rows making a correct app look broken.
- **Never blanket find-and-replace across a file.** It has bitten twice: once rewriting
  a CSS custom property into a cycle, once adding a column to an `INSERT` that already
  had it. Exclude what you are adding to.
- **`SELECT` lists are not audited by TypeScript.** `activity_id` and `place_id` were
  both stored correctly and never selected back, so the client could not show them.
  When adding a column, check every query that reads the table.
- **The sandbox cannot reach `note.jpsapps.com`.** The egress proxy allows
  `api.cloudflare.com` and GitHub, not the app. Verify live behaviour through the MCP
  connector, the Cloudflare API, or ask JP.

## Spec issues found — decided, not open

- **"Thing" is the right word. Decided, keep it.** Questioned on 7 Sep. That tab now
  holds a Yard, a Front sprinkler, an air conditioner and a truck, and no more
  specific noun covers all four: Equipment excludes the yard, Assets is the right
  register at the wrong temperature, Inventory implies counting. It is deliberately
  empty because the category is deliberately broad — the same argument §4 makes for
  key-value attributes and only three templates. It is also the word JP says out loud
  and four characters wide on a five-tab nav. The SQL still says `subjects` and the
  MCP tools say `things`; that split is not worth a migration.
- Names that are genuinely weaker, none urgent: **"Not in a place"** names an absence
  and reads like an error state, and **"Open"** does not say open what (it is
  unresolved follow-ups).
- §4's schema omitted `user_id` on `entry_subjects` and `subject_attributes`,
  contradicting its own rule. Added.
- §4 has no hierarchy for subjects at all — only `activities.parent_id`. Added in
  0004 along the lines this file proposed, and for the same reason §4 gives for
  activities: the column permits any depth for free. Unlike activities, the interface
  here does surface every level, because "which yard is this sprinkler in" is the
  question a flat list of forty things cannot answer.
- §4 lists `'work' | 'home' | 'vehicles'` as contexts, but §7 makes context the
  *sharing* boundary — and vehicles is not one. Contexts are **work and home**; a work
  truck is Work and a personal car is Home. Filtering to vehicles is answered by
  `type = 'vehicle'` on the thing.
- §7 wants passkeys "on top of" Access. Access has no WebAuthn login method; the route
  to biometric is the Cloudflare IdP with a passkey on the Cloudflare account.
- §8a assumed Cloudflare's MCP Portals. That fronts an MCP server *with* Access, which
  is the one thing that cannot work — Anthropic's cloud cannot complete an Access
  login. Access gates the consent screen instead.
- §12's Base44 log is half-solved: pasting an HTML or text log works. The
  auto-fetch-from-repo half may not need building now that the connector exists.
