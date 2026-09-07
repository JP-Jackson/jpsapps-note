# Note

**note.jpsapps.com** — a capture-first day log for work and home.

Built to `NOTE_SPEC.md`, which is the authority. Where the spec states a decision
and a reason, follow it.

## Status: phase 1 (foundation)

Worker, D1 schema, R2 bucket, `img.jpsapps.com`, auth. The capture screen, views,
subjects and everything else land in phases 2+. See spec §11.

## Two rules this phase exists to establish

**1. `user_id` is on every table from day one.** Spec §4: this is the one thing in
the design that is genuinely painful to retrofit. The only tables without it are
`users` (its `id` *is* the user id) and `subject_templates` (global reference data —
what to ask when adding a subject of a given type, not user data).

**2. All database access lives in `src/db.ts`.** Nothing else imports `D1Database`,
prepares a statement, or writes SQL. Beyond the portability discipline in spec §3,
this is what enforces rule 1: `Db` is constructed with a user id and every instance
method scopes to it, so a route handler cannot forget it.

```ts
const db = new Db(env.DB, session.userId);  // built once, in middleware
await db.usageToday();                       // handlers never pass a user_id
```

## Versioning

`package.json` holds the version, `MAJOR.MINOR.PATCH`. It is stamped into three
places that cannot import it — the Worker (`src/version.ts`), the page
(`<meta name="app-version">`) and the service worker cache name:

```bash
npm version minor --no-git-tag-version   # or edit package.json
npm run version:sync
```

The page carries its own copy rather than just displaying what `/api/health`
returns. The service worker caches the shell, so an old page can be paired with a
new Worker; showing the server's number there would report "current" for a page that
is not. When the two disagree the app says so and offers a reload that clears the
cache first.

CI re-runs the sync and fails if anything changes, so a bump can never be half
applied. `npm run deploy` syncs first via `predeploy`.

## Deploying

**Pushing to GitHub does not publish the app.** GitHub holds the source; Cloudflare
runs it. Merging to `main` triggers `.github/workflows/deploy.yml`, which typechecks
and then uploads the Worker — that upload is what publishes. Roughly 40 seconds.

Deploy by hand when you need to:

```bash
npm run deploy
```

Migrations are **not** part of the deploy. Run them from the Actions tab
(*Migrate (remote D1)*, type `migrate` to confirm) or locally with `npm run db:migrate`.
A deploy is undone by redeploying the previous version; a dropped column is not, so
migrating is a decision rather than a side effect of merging.

### Required repository secrets

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with the permissions below |
| `CLOUDFLARE_ACCOUNT_ID` | `bf9f771dae485c448a5740c54ca5771d` |

Token permissions (Account resource = the jpsappshq account, Zone = `jpsapps.com`):

- Account → **Workers Scripts** → Edit
- Account → **D1** → Edit
- Account → **Workers R2 Storage** → Edit
- Zone → **Workers Routes** → Edit

Scope it to deploying. The token used to build phase 1 also carries DNS and
Access: Apps and Policies, which a CI job has no business holding.

## Layout

```
migrations/0001_init.sql   full schema — all 11 tables, phases 1-9
src/index.ts               routing only, no SQL
src/db.ts                  the data module — the only file that touches D1
src/auth.ts                Access JWT verification -> Session
src/ids.ts                 id + R2 key generation
src/env.ts                 binding types
public/index.html          static shell (status page for now)
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

There is no Cloudflare Access in front of `wrangler dev`, so `DEV_EMAIL` in
`.dev.vars` stands in for the verified identity. That path is gated on
`ENVIRONMENT=development` and is unreachable in production.

Local D1 does not report `rows_read` / `rows_written` in query metadata, so the
usage meter reads zero locally. It populates against remote D1.

## Deployment checklist

1. `wrangler d1 create note` → put the id in `wrangler.jsonc` (`database_id`)
2. `wrangler r2 bucket create note-photos`
3. `npm run db:migrate`
4. Create the Access application (below), fill in `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
5. `npm run deploy`
6. Bind `note.jpsapps.com` as a custom domain (uncomment `routes` in `wrangler.jsonc`)
7. Bind `img.jpsapps.com` to the `note-photos` bucket in the R2 dashboard

## Auth

Cloudflare Access sits in front of the app (spec §7). It verifies identity and
attaches a signed JWT; this Worker verifies that signature against the team's JWKS
and checks `aud`, `iss` and `exp`. The header is never trusted unverified — the
Worker is reachable on workers.dev, so an unchecked header would be an open door.

Access identities become app users via an allowlist (`ALLOWED_EMAILS`), so a
misconfigured Access policy cannot silently create accounts.

### On passkeys

The spec says "passkeys on top" of Access. **Access has no WebAuthn login method** —
its options are the Cloudflare identity provider, one-time PIN, or a third-party IdP.
The route to biometric unlock with no code is to use the **Cloudflare IdP** login
method and put a passkey on the Cloudflare account itself; Access then delegates to
Cloudflare's own auth, and the biometric still never leaves the device, which is the
property §7 actually wants. A true in-app WebAuthn unlock would mean hand-rolling
WebAuthn in the Worker, contradicting "Access handles login."

### Two auth regimes, and why the Access application has holes in it

Everything under `/api` is a browser and is authenticated by Cloudflare Access.
`/mcp` is Claude, connecting from Anthropic's cloud with no way to complete an Access
login, so it is authenticated by an OAuth bearer token instead (spec §8a).

Six paths are therefore **excluded from the Access application** by their own
bypass applications — a more specific path wins over the hostname-wide one:

    /mcp
    /oauth/token
    /oauth/register
    /oauth/revoke
    /.well-known/oauth-authorization-server
    /.well-known/oauth-protected-resource

`/oauth/authorize` is deliberately **not** in that list. It stays inside Access, so
the consent screen is only ever reachable by someone Access has already logged in.
That is the whole security model: Access decides who may grant a token, and the token
is what a server can carry.

The OAuth server is hand-written (`src/oauth.ts`) rather than taken from
`@cloudflare/workers-oauth-provider`, which stores its state in Workers KV. That
would put authorisation outside `src/db.ts`, and one module for all database access
is worth more than the code it saves. Two D1 tables (migration `0003_oauth.sql`) hold
authorisation codes and token hashes; registered clients are signed into their own
`client_id` and stored nowhere.

Requires the `OAUTH_SECRET` secret:

    npx wrangler secret put OAUTH_SECRET

Without it, every OAuth route fails loudly. A fallback would quietly issue client ids
anyone could forge.

## Two buckets, and which one a file lands in

`note-photos` is served publicly by `img.jpsapps.com`. `note-files` has no custom
domain, so the only route to an object in it is through the Worker — which is to say
through Access.

The destination is chosen by the bytes, not by which button was pressed: anything
with an `image/` MIME type goes to the public bucket, everything else to the private
one. Photos are the high-volume case where §3's "serving from cache bypasses the
Worker" argument actually applies. A site drawing or a config export is not, and it
should stop being reachable when sharing is revoked — a public URL never does,
because revocation lives in the app and the CDN was never asked who was calling.

Documents come back through `GET /api/files/:id` as **downloads**, with
`Content-Disposition: attachment`, `nosniff` and a `default-src 'none'; sandbox` CSP.
An uploaded HTML file rendered inline from this origin would run its scripts as the
app, with reach into the Access session and the offline queue. Downloading costs one
click and removes the whole class of problem.

Deleting an attachment deletes the R2 object too. The row is what the app can see,
but the object is what exists — dropping only the row leaves a photo sitting at its
public URL with nothing recording that it is there.

## Photos and `img.jpsapps.com`

An R2 custom domain means the bucket is **publicly readable**. That is deliberate
(§3: serving from cache bypasses the Worker and does not consume request quota), but
it means the URL *is* the capability. Photo keys are therefore unguessable —
`u/{user_id}/{yyyy}/{mm}/{random-uuid}.jpg`, never sequential or derived. See
`src/ids.ts`.
