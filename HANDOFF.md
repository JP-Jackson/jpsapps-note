# Note — phase 1 handoff

Written 6 Sep 2026. Delete this once phase 1 is closed out.

## Where things stand

Phase 1 **code** is complete, verified locally, committed and pushed to
`claude/note-phase-1-foundation-ifovxo`. Nothing has been created in Cloudflare yet.

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
   querying `pragma_table_info` on every table.
2. **All D1 access lives in `src/db.ts`.** Nothing else imports `D1Database` or writes
   SQL. `Db` is constructed with a user id in middleware; handlers never see one.

## Verified working locally

- 11 tables, 11 indexes, migration applies cleanly
- `/api/health` → `{ok:true, tables:12}`
- `/api/me` auto-provisions the user and returns a real `user_id`
- Unlisted email → 403, and **no** user row created
- `tsc --noEmit` clean

Unverified: the usage meter. Local D1 doesn't report `rows_read`/`rows_written` in
query metadata, so it reads zero locally. **Confirm it populates against remote D1.**

## What is left

```bash
npx wrangler d1 create note              # write the id into wrangler.jsonc
npx wrangler r2 bucket create note-photos
npm run db:migrate                       # remote
npm run deploy
```

Then:
- Zero Trust team name (needs JP — account onboarding, a token likely can't bootstrap it)
- Access application on `note.jpsapps.com`, login method **Cloudflare IdP** + one-time
  PIN fallback, policy allowing `jpsappshq@gmail.com`, session duration 1 month
- Copy the **AUD tag** into `ACCESS_AUD`, team domain into `ACCESS_TEAM_DOMAIN`
- Uncomment the `routes` block in `wrangler.jsonc`, redeploy
- Bind `img.jpsapps.com` to the `note-photos` bucket in the R2 dashboard

Phase 1 is done when: the Worker deploys, the D1 tables exist and are queryable with
wrangler, the R2 bucket exists, and JP can log in.

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
