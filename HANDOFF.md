# Note — phase 1 handoff

Written 6 Sep 2026. Updated 6 Sep 2026 after the deploy. Delete this once phase 1 is
closed out.

## Where things stand

Phase 1 code is complete and **deployed**. The Cloudflare resources exist.

| Thing | Value |
|---|---|
| Worker | `https://note.jpsapps.com` (custom domain, **not resolving yet**) |
| Worker (fallback) | `https://note.jpsapps.workers.dev` — live and verified |
| D1 database | `note` — `416aa6a6-0c76-4f21-88eb-56a73c3d25bc` (ENAM) |
| R2 bucket | `note-photos` |
| Account | jpsappshq@gmail.com — `bf9f771dae485c448a5740c54ca5771d` |

Verified live on workers.dev before the custom domain was added: `/api/health` →
`{ok:true, tables:14}` (11 app tables + `d1_migrations` + two `_cf_*` internals; remote
reports more than local's 12). `/api/me` → 401 with no token, 403 with a junk token.
Static shell → 200.

**Not verified on `note.jpsapps.com`.** The build sandbox's egress proxy allowlists
`workers.dev` and `api.cloudflare.com` but not `jpsapps.com`, so the hostname cannot be
reached from there at all — and adding the route retired the workers.dev URL that could
be. The Cloudflare API confirms the domain is configured; the browser check is JP's.

`NOTE_SPEC.md` is the authority. Where it states a decision and a reason, follow it
rather than substituting a different approach. Build **phase 1 only** — no capture
screen, views, or subjects.

## Cloudflare account situation (important)

- Everything belongs in the **jpsappshq@gmail.com** account.
  Account ID: `bf9f771dae485c448a5740c54ca5771d`
- `jpsapps.com` was moved here from the older ftmtit51@gmail.com account via a
  Cloudflare Registrar inter-account transfer, completed 6 Sep 2026.
  The domain is **transfer-locked for 30 days**.
- The move wiped the zone's config. One DNS record was lost: a Worker custom domain
  binding for `footballplays.jpsapps.com` → Worker `football-plays`. That Worker is
  still in the old account and **that subdomain is currently down**. Source is in a
  GitHub repo; redeploying it into jpsappshq and re-adding the custom domain fixes it.
  Not part of phase 1.
- Do **not** create anything in the account holding `polk-*` resources — that is
  work-related and separate.

## Two rules that must not be relaxed

1. **`user_id` on every table from day one** (spec §4). Only `users` (its `id` is the
   user id) and `subject_templates` (global reference data) are exempt. Verified by
   querying `pragma_table_info` on every table — re-verified against **remote** D1
   after the migration applied.
2. **All D1 access lives in `src/db.ts`.** Nothing else imports `D1Database` or writes
   SQL. `Db` is constructed with a user id in middleware; handlers never see one.

## Verified working locally

- 11 tables, 11 indexes, migration applies cleanly
- `/api/health` → `{ok:true, tables:12}`
- `/api/me` auto-provisions the user and returns a real `user_id`
- Unlisted email → 403, and **no** user row created
- `tsc --noEmit` clean

## The usage meter — resolved, and it needed a fix

Remote D1 **does** report `rows_read`/`rows_written` in query metadata; local D1 does
not, which is why this could not be checked before deploying. Verified against the real
remote database with `wrangler dev --remote`.

Two defects turned up in the wiring, both now fixed:

1. The pre-session lookups (`findUserByEmail`, `createUser`, via `resolveUser`) are
   static — they run before a `user_id` exists — and never tallied. That is the one
   query on **every** authenticated request, so the meter was blind to its busiest
   caller. §4 calls the row limit a cliff, not a throttle; undercounting it is the
   failure mode that matters.
2. As a consequence the meter never wrote anything at all. On `/api/me` the only
   metered query was `usageToday()`, which reads an empty `usage_log` and so reports
   `rows_read: 0` — the tally stayed empty, `flushUsage()` early-returned, and the
   table stayed empty. Self-sustaining.

The fix: `resolveUser` returns `{ user, cost }` where `cost` is a plain
`{rows_read, rows_written}` — no D1 type escapes `db.ts` — and the middleware folds it
into the request's meter with `db.absorb()`. Confirmed accumulating across successive
requests against remote D1: `0 → 1 → 3 → 5`, with the matching `usage_log` row.

**Known small undercount, deliberate:** `flushUsage()` does not meter its own write, so
`rows_written` sits at 0 until phase 2 adds real write endpoints (those go through
`Db.run()` and are counted). Counting the meter's own write means carrying it into the
next request; not worth the complexity for one row per request. Revisit if the write
bar ever needs to be exact.

## What is left

Everything below needs JP — the team name is account onboarding a token cannot
bootstrap, and the rest follows from it.

- **Zero Trust team name** — blocks the Access application
- Access application on `note.jpsapps.com`, login method **Cloudflare IdP** + one-time
  PIN fallback, policy allowing `jpsappshq@gmail.com`, session duration 1 month
- Copy the **AUD tag** into `ACCESS_AUD`, team domain into `ACCESS_TEAM_DOMAIN`, redeploy
- Bind `img.jpsapps.com` to the `note-photos` bucket in the R2 dashboard

Team name chosen: **`jpsapps`** → `jpsapps.cloudflareaccess.com`.

The `Note-JpsApps` token has **no Zero Trust or SSL permission** (`Authentication
error` on `/access/organizations`, `9109` on certificate packs). The Access work is
dashboard-only unless the token is widened.

## note.jpsapps.com

Created as a Worker **custom domain**, not a hand-made DNS record — Cloudflare owns the
AAAA record and the certificate. Confirmed via the API: hostname registered against
service `note`, `enabled: true`, cert issued.

Adding the route disabled the workers.dev URL (wrangler's default once a route exists).
It has been **re-enabled** via `"workers_dev": true` because the hostname does not
resolve yet — see below. Not an Access bypass: `auth.ts` verifies the Access JWT
signature itself rather than trusting a header, precisely because the Worker is
reachable off-Access, so an off-Access hostname returns 401 rather than letting anyone
through. **Turn it off once `note.jpsapps.com` resolves and Access is live.**

### note.jpsapps.com does not resolve — DNS delegation, not config

`ERR_NAME_NOT_RESOLVED` in the browser. The Cloudflare side is confirmed correct: the
record is `AAAA → 100::`, proxied, auto TTL — the textbook Workers custom domain — and
the dashboard shows it as a Worker record under a Full DNS setup.

The diagnostic was `footballplays.jpsapps.com`, which does not resolve either:

- Hitting the **new** nameservers → `note` resolves, `footballplays` does not (lost in the move)
- Hitting the **old** ones → `footballplays` resolves, `note` does not
- **Neither resolves** → nothing under `jpsapps.com` is served at all ← this is the case

So the `.com` registry is almost certainly still delegating to `osmar`/`raphaela` (the
old ftmtit51 account's pair) while the zone now lives on `byron`/`cortney`. Cloudflare
marked the zone active at 18:00:41 UTC on 6 Sep, but for a Registrar domain that
reflects the account move, not global propagation.

Decisive test, bypassing every cache:

```
nslookup -type=ns jpsapps.com a.gtld-servers.net
```

- **byron/cortney** → delegation is right, just propagating. `.com` NS carries a 48h
  TTL, so a resolver holding the old pair keeps it. Wait.
- **osmar/raphaela** → the registry was never updated. A Cloudflare Registrar problem,
  needing support; the `Note-JpsApps` token has no registrar permission either
  (`Authentication error` on `/registrar/domains`).

This is fallout from the 6 Sep inter-account transfer, not from the phase 1 build.

**Get DNS resolving before creating the Access application** — Access validates against
the hostname, so building it first risks a second failure that is really this one.

Until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, the Worker is deployed but closed:
every `/api/*` call except `/api/health` is refused. That is the correct state, not a
half-finished one — the Worker is reachable on workers.dev and must not trust an
unverified header.

Phase 1 is done when: the Worker deploys, the D1 tables exist and are queryable with
wrangler, the R2 bucket exists, and JP can log in. **Only the last is outstanding.**

## Spec issues found — decided, not open

- **Access has no passkey login method.** Spec §7 says "passkeys on top" of Access;
  Access only offers the Cloudflare IdP, one-time PIN, or a third-party IdP. Route to
  biometric with no code: Cloudflare IdP login method + a passkey on the Cloudflare
  account. Do not hand-roll WebAuthn in phase 1.
- **Access would break the MCP connector.** Anthropic's cloud cannot complete an Access
  login, so `/mcp` and `/oauth/*` must be **excluded** from the Access application.
  Paths are reserved; nothing built there yet.
- **`img.jpsapps.com` makes the bucket world-readable.** Deliberate per §3, mitigated
  with unguessable keys (`src/ids.ts`).
- **Spec omitted `user_id` on `entry_subjects` and `subject_attributes`**, contradicting
  its own §4 rule. Added.
- **Missing: context-sharing schema.** §7 describes sharing Home with JP's wife, but
  `subjects.visibility` has no grant table saying *with whom*. Future work.

## Open, JP's call

- Hono was chosen for routing (defaulted, easily reversed)
- Whether the MCP endpoint gets path-exclusion or its own `mcp.jpsapps.com`
- Revoke the `Note-JpsApps` API token when phase 1 closes
