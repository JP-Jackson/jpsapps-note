# Note — handoff

Written 7 Sep 2026, at **v1.20.0**. `NOTE_SPEC.md` is the authority: where it states a
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

## Things that cost time, so they are written down

- **The tests are the reason most bugs were found.** `npm run test:ui` — 199
  assertions, ten files, all honouring `NOTE_URL`. They are not in CI because they
  need a live dev server. Almost every bug this session was invisible from reading the
  code: a `history.back()` race, delegated listeners stacking on a container that
  outlives its render, an `onerror` handler quietly removing the photos a test was
  asserting about.
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
