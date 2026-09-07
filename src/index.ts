/**
 * Note — Worker entry point.
 *
 * Routing and HTTP concerns only. No SQL here or anywhere outside src/db.ts.
 *
 * Two auth regimes live here (NOTE_SPEC.md §8a). Everything under /api is a browser
 * and is authenticated by Cloudflare Access. /mcp is Claude, connecting from
 * Anthropic's cloud with no way to complete an Access login, and is authenticated by
 * an OAuth bearer token instead — so /mcp, /oauth/token, /oauth/register and the
 * two .well-known documents must be EXCLUDED from the Access application, while
 * /oauth/authorize stays inside it. Access is what decides who may grant a token.
 */

import { Hono } from "hono";
import type { Env } from "./env";
import { BadContext, BadParent, Db, VersionConflict, type PlacePatch } from "./db";
import { fileKey, photoKey } from "./ids";
import { VERSION } from "./version";
import { authenticate, AuthError, type Session } from "./auth";
import { handleMcp } from "./mcp";
import {
  CORS,
  authServerMetadata,
  bearerUser,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
  unauthorized,
} from "./oauth";

type Vars = { session: Session; db: Db };

/** Great-circle distance in metres. Good to a few metres at these ranges. */
function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/**
 * The MCP signing key.
 *
 * Missing means the secret was never set, and a fixed fallback would quietly issue
 * client ids anyone could forge. Failing loudly is the only safe reading.
 */
function secretOf(env: Env): string {
  if (!env.OAUTH_SECRET) throw new Error("OAUTH_SECRET is not set; run wrangler secret put");
  return env.OAUTH_SECRET;
}

/**
 * Split attachments into what the client renders inline and what it links to.
 *
 * Photos carry an absolute CDN URL; files carry a Worker path, because that is the
 * only route to them. Written once and shared by both detail endpoints so the two
 * cannot drift into disagreeing about what an attachment looks like.
 */
function shapeAttachments(
  rows: { id: string; kind: string; r2_key: string | null; mime?: string | null; bytes?: number | null; title?: string | null }[],
  imgBase: string,
) {
  return {
    photos: rows
      .filter((a) => a.kind === "photo" && a.r2_key)
      .map((a) => ({ id: a.id, url: `${imgBase}/${a.r2_key}` })),
    files: rows
      .filter((a) => a.kind === "file")
      .map((a) => ({
        id: a.id,
        title: a.title ?? "attachment",
        mime: a.mime ?? null,
        bytes: a.bytes ?? null,
        url: `/api/files/${a.id}`,
      })),
  };
}

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Liveness + schema probe. No auth: it must answer before login works. */
app.get("/api/health", async (c) => {
  const db = await Db.health(c.env.DB);
  return c.json({
    ok: db.ok,
    version: VERSION,
    tables: db.tables,
    environment: c.env.ENVIRONMENT,
    accessConfigured: Boolean(c.env.ACCESS_TEAM_DOMAIN && c.env.ACCESS_AUD),
  });
});

/**
 * Everything under /api past this point requires a verified identity.
 *
 * The Db instance is built here, bound to the authenticated user_id, and handed to
 * handlers through context. Handlers never construct a Db and never see a user_id,
 * so a query cannot be written that forgets to scope to the current user.
 */
app.use("/api/*", async (c, next) => {
  const session = await authenticate(c.req.raw, c.env);
  const db = new Db(c.env.DB, session.userId);
  // The auth lookup ran before this Db existed; count it here so the busiest
  // query on the app is not invisible to the meter.
  db.absorb(session.cost);
  c.set("session", session);
  c.set("db", db);

  await next();

  // One usage write per request, after the response is settled. Runs even if the
  // handler threw: the queries it made still cost what they cost.
  c.executionCtx.waitUntil(db.flushUsage());
});

/**
 * The one place a thrown error becomes a response.
 *
 * Not a try/catch around `next()`, which is the obvious-looking version and does not
 * work: Hono does not re-throw a handler's error into the middleware awaiting it, it
 * stores the error on the context and unwinds. A catch there sees only what the
 * middleware itself threw, so route errors were arriving as bare 500s.
 */
app.onError((err, c) => {
  if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
  // Caller's mistake, not a fault — and answered the same way whichever route,
  // import row or MCP tool set it.
  if (err instanceof BadContext) return c.json({ error: err.message }, 400);
  // Same shape: asking to put a thing inside itself, or inside something that is
  // not there, is a bad request rather than a broken server.
  if (err instanceof BadParent) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

/**
 * The free-tier ceilings the usage bars are drawn against (§8).
 *
 * Kept here beside the endpoint rather than in the client, because the client is
 * cached and these are Cloudflare's numbers, not ours — if a plan changes, a deploy
 * should be enough to correct what the bars say.
 */
const LIMITS = {
  neurons: 10_000,          // Workers AI, per day
  rows_read: 5_000_000,     // D1, per day
  rows_written: 100_000,    // D1, per day
  storage_bytes: 10 * 1024 * 1024 * 1024,   // R2, total rather than per day
};

app.get("/api/me", async (c) => {
  const session = c.get("session");
  const db = c.get("db");
  const [usage, storage] = await Promise.all([db.usageToday(), db.storageUsed()]);
  return c.json({
    id: session.userId,
    email: session.email,
    displayName: session.user.display_name,
    createdAt: session.user.created_at,
    usageToday: usage,
    storageBytes: storage,
    limits: LIMITS,
  });
});

/**
 * Land a capture.
 *
 * The device generates the id and the timestamp (§6), so this is idempotent: a queue
 * flush that half-succeeded and gets retried replays harmlessly. The response says
 * whether the row was new so the client can drop it from the queue either way.
 */
app.post("/api/entries", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const e = body as Record<string, unknown>;
  const id = typeof e.id === "string" ? e.id : "";
  const context = typeof e.context === "string" ? e.context : "";
  if (!id) return c.json({ error: "id is required — the device generates it" }, 400);
  if (!context) return c.json({ error: "context is required" }, 400);

  const text = typeof e.body === "string" ? e.body.trim() : "";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const { created } = await c.get("db").createEntry({
    id,
    // Trust the device clock for when it happened, but never the future or the epoch.
    created_at: num(e.created_at) ?? Date.now(),
    context,
    body: text || null,
    lat: num(e.lat),
    lng: num(e.lng),
    is_open: e.is_open === true,
    place_id: typeof e.place_id === "string" ? e.place_id : null,
    // Stamped by the device, not looked up here: an entry captured offline belongs
    // to whatever was running when it happened, not to whatever is running by the
    // time the queue drains (§6).
    activity_id: typeof e.activity_id === "string" ? e.activity_id : null,
  });

  // §4: one capture can touch a site, a panel and the device on it, so this is a
  // list rather than a column on entries.
  if (Array.isArray(e.subject_ids) && e.subject_ids.length) {
    await c.get("db").linkEntrySubjects(
      id,
      (e.subject_ids as unknown[]).filter((v): v is string => typeof v === "string"),
    );
  }

  return c.json({ id, created }, created ? 201 : 200);
});

/**
 * The views (§11 phase 3), chosen by ?view=:
 *   (none)  recent captures, for the capture screen
 *   day     one local day — the client sends its own bounds, see below
 *   open    unresolved follow-ups, oldest first
 *   search  substring over body and body_raw
 */
app.get("/api/entries", async (c) => {
  const db = c.get("db");
  const limit = Math.min(Number(c.req.query("limit")) || 20, 100);

  switch (c.req.query("view")) {
    case "day": {
      // Day bounds come from the device. "Today" means the user's today, and the
      // server has no reliable way to know their timezone.
      const from = Number(c.req.query("from"));
      const to = Number(c.req.query("to"));
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        return c.json({ error: "from and to (epoch ms) are required" }, 400);
      }
      return c.json({ entries: await db.entriesForDay(from, to) });
    }
    case "open":
      return c.json({ entries: await db.openEntries(Math.min(limit, 100)) });
    case "search": {
      const q = (c.req.query("q") ?? "").trim();
      if (q.length < 2) return c.json({ entries: [], error: "Search needs 2+ characters" });
      return c.json({ entries: await db.searchEntries(q, Math.min(limit, 50)) });
    }
    default:
      return c.json({ entries: await db.recentEntries(limit) });
  }
});

/** One entry with its photos and both ends of its follow-up thread. */
app.get("/api/entries/:id", async (c) => {
  const detail = await c.get("db").entryDetail(c.req.param("id"));
  if (!detail) return c.json({ error: "No such entry" }, 404);
  return c.json({
    ...detail,
    subjects: await c.get("db").entrySubjects(c.req.param("id")),
    ...shapeAttachments(detail.attachments, c.env.IMG_BASE),
    // Sent rather than recomputed on the client: the device clock is what made the
    // timestamp, and it is not necessarily the clock this was judged against.
    deletable_for_ms: Math.max(0, DELETE_WINDOW_MS - (Date.now() - detail.created_at)),
  });
});

/**
 * Edit the note, or open/close a follow-up.
 *
 * An edit carries the version it started from. If the server has moved on we return
 * 409 WITH the current row, so the client can show both and let the user choose —
 * §6 is explicit that a rejected edit is never silently dropped.
 */
app.patch("/api/entries/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.get("db");

  let payload: Record<string, unknown>;
  try {
    payload = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  if (payload.is_open === false) {
    const resolver = typeof payload.resolved_by === "string" ? payload.resolved_by : null;
    if (resolver && !(await db.ownsEntry(resolver))) {
      return c.json({ error: "resolved_by is not one of your entries" }, 400);
    }
    await db.resolveEntry(id, resolver);
  } else if (payload.is_open === true) {
    await db.reopenEntry(id);
  }

  if (typeof payload.body === "string") {
    const version = Number(payload.version);
    if (!Number.isFinite(version)) {
      return c.json({ error: "version is required to edit — it is how a lost update is caught" }, 400);
    }
    try {
      return c.json(await db.editEntry(id, payload.body.trim() || null, version));
    } catch (err) {
      if (err instanceof VersionConflict) {
        return c.json({ error: err.message, conflict: true, current: err.current }, 409);
      }
      throw err;
    }
  }

  const detail = await db.entryDetail(id);
  if (!detail) return c.json({ error: "No such entry" }, 404);
  return c.json(detail);
});

/**
 * Photo upload. Raw bytes in, R2 key out.
 *
 * Compression happens on the device (§5: 1600px, q80) so what arrives is already
 * small — a photo queued offline is small on the phone too, which is the point.
 * Reads go through img.jpsapps.com, never this Worker (§3), so the object key is
 * a random UUID: the URL is the capability.
 */
app.post("/api/photos", async (c) => {
  const entryId = c.req.query("entry_id") ?? "";
  if (!entryId) return c.json({ error: "entry_id is required" }, 400);

  const db = c.get("db");
  if (!(await db.ownsEntry(entryId))) {
    return c.json({ error: "No such entry" }, 404);
  }

  const mime = c.req.header("content-type") ?? "image/jpeg";
  if (!mime.startsWith("image/")) return c.json({ error: "Expected an image" }, 415);

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "Empty upload" }, 400);
  if (bytes.byteLength > 10_000_000) return c.json({ error: "Too large" }, 413);

  // The client always sends JPEG (§5), but key off the real type so the extension
  // never disagrees with the bytes — img.jpsapps.com serves these directly.
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const key = photoKey(db.userId, new Date(), ext);
  await c.env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: mime } });

  const id = await db.addAttachment({
    entry_id: entryId,
    kind: "photo",
    r2_key: key,
    mime,
    bytes: bytes.byteLength,
  });

  return c.json({ id, key, url: `${c.env.IMG_BASE}/${key}` }, 201);
});

/* --------------------------------------------------------------------- places */

/** Named places, each with the context most often used there. */
app.get("/api/places", async (c) => {
  return c.json({ places: await c.get("db").listPlaces() });
});

/**
 * Is this spot worth naming yet?
 *
 * §4: offer after the second or third capture at an unnamed spot. Returns how many
 * past captures are nearby so the client can decide whether to ask — asking on the
 * first visit to every customer site would be noise.
 */
app.delete("/api/places/:id", async (c) => {
  const gone = await c.get("db").deletePlace(c.req.param("id"));
  return gone ? c.json({ deleted: true }) : c.json({ error: "No such place" }, 404);
});

/**
 * Correct a place: its name, its pin, or its radius.
 *
 * All three matter, and only the name was ever reachable. Without this the way to
 * move a pin dropped on the wrong building is to delete the place and add it again,
 * which unfiles every thing rooted there and strips `place_id` off every entry that
 * named it. That is data loss dressed up as an edit.
 */
app.patch("/api/places/:id", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const patch: PlacePatch = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    patch.name = name;
  }
  // Coordinates move together or not at all. Half a move is a pin somewhere neither
  // the old nor the new place has ever been.
  if (body.lat !== undefined || body.lng !== undefined) {
    const lat = Number(body.lat), lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return c.json({ error: "lat and lng must be sent together" }, 400);
    }
    patch.lat = lat;
    patch.lng = lng;
  }
  if (body.radius_m !== undefined) {
    const r = Number(body.radius_m);
    if (!Number.isFinite(r) || r <= 0) return c.json({ error: "radius_m must be positive" }, 400);
    patch.radius_m = Math.round(r);
  }
  if (!Object.keys(patch).length) return c.json({ error: "Nothing to change" }, 400);

  const ok = await c.get("db").updatePlace(c.req.param("id"), patch);
  return ok ? c.json({ updated: true }) : c.json({ error: "No such place" }, 404);
});

app.get("/api/places/nearby", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ error: "lat and lng are required" }, 400);
  }
  const near = await c.get("db").unnamedNearby(lat, lng);
  const within = near.filter((p) => haversine(lat, lng, p.lat, p.lng) <= 150);
  return c.json({ unnamedVisits: within.length });
});

app.post("/api/places", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!name) return c.json({ error: "name is required" }, 400);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ error: "lat and lng are required" }, 400);
  }
  const db = c.get("db");
  const id = await db.createPlace(name, lat, lng, Number(body.radius_m) || 150);
  // Past captures made here belong to it — naming a place should explain history,
  // not just label the future.
  const claimed = await db.claimEntriesForPlace(id, lat, lng);
  return c.json({ id, claimed }, 201);
});

/* ------------------------------------------------------------------- subjects */

/** What to ask when adding each type of subject (§4). */
app.get("/api/templates", async (c) => {
  return c.json({ templates: await c.get("db").templates() });
});

app.get("/api/subjects", async (c) => {
  const includeArchived = c.req.query("archived") === "1";
  const rows = await c.get("db").listSubjects(includeArchived);
  return c.json({
    subjects: rows.map(({ hero_key, ...s }) => ({
      ...s,
      hero_url: hero_key ? `${c.env.IMG_BASE}/${hero_key}` : null,
    })),
  });
});

app.post("/api/subjects", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const type = typeof body.type === "string" ? body.type : "generic";
  const context = typeof body.context === "string" ? body.context : "";
  if (!name) return c.json({ error: "name is required" }, 400);
  if (!context) return c.json({ error: "context is required" }, 400);

  const db = c.get("db");
  const { id } = await db.createSubject({
    name, type, context,
    // Where it lives. At most one is kept; db.ts decides which and refuses a
    // parent that is missing, someone else's, or the thing itself.
    parent_id: typeof body.parent_id === "string" && body.parent_id ? body.parent_id : null,
    place_id: typeof body.place_id === "string" && body.place_id ? body.place_id : null,
  });
  if (Array.isArray(body.attributes)) {
    await db.setAttributes(id, body.attributes as never);
  }
  return c.json({ id }, 201);
});

/**
 * Bulk import (§11 phase 4): paste a Claude-structured list and get subjects.
 *
 * Day one means typing in a shop full of equipment, which is exactly the chore that
 * stops a tool being adopted. Anything that fails is reported per row rather than
 * failing the batch — a typo in item nine should not discard the other eleven.
 */
app.post("/api/subjects/import", async (c) => {
  let body: { subjects?: unknown };
  try {
    body = (await c.req.json()) as { subjects?: unknown };
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  if (!Array.isArray(body.subjects)) {
    return c.json({ error: "Expected { subjects: [...] }" }, 400);
  }
  if (body.subjects.length > 200) {
    return c.json({ error: "Import at most 200 at a time" }, 413);
  }

  const db = c.get("db");
  const created: string[] = [];
  const failed: { row: number; error: string }[] = [];

  for (const [i, raw] of body.subjects.entries()) {
    const item = raw as Record<string, unknown>;
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const context = typeof item?.context === "string" ? item.context : "";
    if (!name || !context) {
      failed.push({ row: i, error: "name and context are required" });
      continue;
    }
    try {
      const { id } = await db.createSubject({
        name,
        type: typeof item.type === "string" ? item.type : "generic",
        context,
      });
      if (item.attributes && typeof item.attributes === "object") {
        const attrs = Object.entries(item.attributes as Record<string, unknown>)
          .map(([key, value], n) => ({ key, value: value == null ? null : String(value), sort_order: n }));
        if (attrs.length) await db.setAttributes(id, attrs);
      }
      created.push(id);
    } catch (e) {
      failed.push({ row: i, error: e instanceof Error ? e.message : "failed" });
    }
  }
  return c.json({ created: created.length, failed }, created.length ? 201 : 400);
});

app.get("/api/subjects/:id", async (c) => {
  const detail = await c.get("db").subjectDetail(c.req.param("id"));
  if (!detail) return c.json({ error: "No such subject" }, 404);
  return c.json({ ...detail, ...shapeAttachments(detail.attachments, c.env.IMG_BASE) });
});

app.patch("/api/subjects/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.get("db");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  if (typeof body.archived === "boolean") await db.archiveSubject(id, body.archived);
  if (Array.isArray(body.attributes)) await db.setAttributes(id, body.attributes as never);

  const patch: Record<string, unknown> = {};
  for (const k of ["name", "context", "visibility"]) {
    if (typeof body[k] === "string") patch[k] = body[k];
  }
  // hero_photo_id is the one field whose null is meaningful: it is how a cover is
  // cleared. A string-only check would drop that silently, leaving a button that
  // looks like a toggle and only works one way.
  if (body.hero_photo_id === null || typeof body.hero_photo_id === "string") {
    patch.hero_photo_id = body.hero_photo_id;
  }
  if (Object.keys(patch).length) await db.updateSubject(id, patch);

  // Moving a thing goes through setHome rather than the patch loop above: the two
  // columns are mutually exclusive and a parent has to be checked for cycles, and
  // neither rule survives being expressed as "UPDATE whatever was sent". null is
  // meaningful here too — it is how a thing is moved back out to the top level.
  const movingParent = body.parent_id === null || typeof body.parent_id === "string";
  const movingPlace = body.place_id === null || typeof body.place_id === "string";
  if (movingParent || movingPlace) {
    await db.setHome(id, {
      parent_id: movingParent ? (body.parent_id as string | null) || null : null,
      place_id: movingPlace ? (body.place_id as string | null) || null : null,
    });
  }

  const detail = await db.subjectDetail(id);
  if (!detail) return c.json({ error: "No such subject" }, 404);
  return c.json(detail);
});


// ---------------------------------------------------------------------- MCP
// Public paths. These must be excluded from the Access application (see the note
// at the top of this file); Access would answer them with a login page, and a
// login page is not something a server can fill in.

// Discovery. Some clients probe the endpoint-suffixed form (RFC 8414 §3.1) before
// the plain one, so both are answered rather than making the client guess twice.
// Cloudflare terminates TLS ahead of the Worker, so the inbound URL can read as
// http even though every real caller arrived over https. The issuer in these
// documents has to match what the client actually dialled, or discovery fails.
const origin = (c: { req: { url: string } }) => {
  const u = new URL(c.req.url);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  return `${local ? u.protocol : "https:"}//${u.host}`;
};

app.get("/.well-known/oauth-authorization-server", (c) => authServerMetadata(origin(c)));
app.get("/.well-known/oauth-authorization-server/mcp", (c) => authServerMetadata(origin(c)));
app.get("/.well-known/oauth-protected-resource", (c) => protectedResourceMetadata(origin(c)));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => protectedResourceMetadata(origin(c)));

app.options("/oauth/*", (c) => c.body(null, 204, CORS));
app.options("/mcp", (c) => c.body(null, 204, CORS));

app.post("/oauth/register", (c) => handleRegister(c.req.raw, secretOf(c.env)));
app.post("/oauth/token", (c) => handleToken(c.req.raw, c.env.DB, secretOf(c.env)));
app.post("/oauth/revoke", (c) => handleRevoke(c.req.raw, c.env.DB));

/**
 * Consent. Inside the Access application on purpose: Access has already proved who
 * is looking at this page, so pressing Connect is JP granting the token and nobody
 * else can reach the button.
 */
app.on(["GET", "POST"], "/oauth/authorize", async (c) => {
  let session: Session;
  try {
    session = await authenticate(c.req.raw, c.env);
  } catch (err) {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  const secret = secretOf(c.env);
  if (c.req.method === "GET") {
    return handleAuthorizeGet(c.req.raw, secret, session.email);
  }
  const db = new Db(c.env.DB, session.userId);
  db.absorb(session.cost);
  const res = await handleAuthorizePost(c.req.raw, secret, db);
  c.executionCtx.waitUntil(db.flushUsage());
  return res;
});

/** The connector itself. The bearer token is the only thing standing in front. */
app.all("/mcp", async (c) => {
  const userId = await bearerUser(c.req.raw, c.env.DB);
  if (!userId) return unauthorized(origin(c));
  return handleMcp(c.req.raw, c.env.DB, userId);
});

/**
 * How long a capture stays deletable.
 *
 * Long enough to walk back to the truck and notice the mis-tap; short enough that
 * the log cannot be quietly rewritten after the fact. A log whose past can be edited
 * at will is not much of a record, and the value of this one is that it says what
 * actually happened.
 */
const DELETE_WINDOW_MS = 15 * 60 * 1000;

/** Objects, once their rows are gone. Best effort — a row without an object is a
 *  dead link, but an object without a row is invisible and permanent. */
async function dropObjects(env: Env, rows: { kind: string; r2_key: string | null }[]) {
  for (const a of rows) {
    if (!a.r2_key) continue;
    const bucket = a.kind === "photo" ? env.PHOTOS : env.FILES;
    await bucket.delete(a.r2_key);
  }
}

app.delete("/api/entries/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.get("db");

  const entry = await db.entryDetail(id);
  if (!entry) return c.json({ error: "No such entry" }, 404);

  const age = Date.now() - entry.created_at;
  if (age > DELETE_WINDOW_MS) {
    return c.json(
      {
        error: "Too late to delete this one — the window has passed.",
        window_ms: DELETE_WINDOW_MS,
      },
      403,
    );
  }

  const attachments = await db.deleteEntry(id);
  if (!attachments) return c.json({ error: "No such entry" }, 404);
  await dropObjects(c.env, attachments);
  return c.json({ deleted: true });
});

/** No window on a thing: it is a record you keep, not a log of what happened. */
app.delete("/api/subjects/:id", async (c) => {
  const db = c.get("db");
  const attachments = await db.deleteSubject(c.req.param("id"));
  if (!attachments) return c.json({ error: "No such subject" }, 404);
  await dropObjects(c.env, attachments);
  return c.json({ deleted: true });
});

/* -------------------------------------------------------------- activities
 *
 * §4: time as a stack, not a clock. JP is salaried, so nothing here clocks in or
 * out — something is simply always running, and it nests one level deep in
 * practice: "At the shop" over "Compressor 2 — contactor swap".
 */

/** The running chain, leaf first, with what the interface needs to draw it. */
app.get("/api/activities/current", async (c) => {
  const stack = await c.get("db").openStack();
  return c.json({
    current: stack[0] ?? null,
    parent: stack[1] ?? null,
    depth: stack.length,
    now: Date.now(),
  });
});

app.get("/api/activities", async (c) => {
  const from = Number(c.req.query("from"));
  const to = Number(c.req.query("to"));
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return c.json({ error: "from and to (epoch ms) are required" }, 400);
  }
  return c.json({ activities: await c.get("db").activitiesBetween(from, to), now: Date.now() });
});

/**
 * Start something.
 *
 * `nest` decides what happens to what is already running: nested puts the new one
 * underneath, otherwise the running stack is closed first. That is the whole
 * grammar — "I'm now doing this as part of that" versus "I've moved on".
 */
app.post("/api/activities", async (c) => {
  const db = c.get("db");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return c.json({ error: "label is required" }, 400);

  const startedAt = typeof body.started_at === "number" && Number.isFinite(body.started_at)
    ? body.started_at
    : Date.now();

  const stack = await db.openStack();
  const nest = body.nest === true && stack.length > 0;

  if (!nest && stack.length) {
    // Closing the root closes the subtree with it. The new one starts where the old
    // one stopped, so a backdated start does not leave a gap or an overlap.
    const root = stack[stack.length - 1]!;
    await db.endActivity(root.id, Math.max(startedAt, root.started_at));
  }

  const parent = nest ? stack[0]! : null;
  const started = await db.startActivity({
    label,
    context: typeof body.context === "string" ? body.context : (parent?.context ?? "work"),
    parent_id: parent?.id ?? null,
    subject_id: typeof body.subject_id === "string" ? body.subject_id : null,
    // A child cannot start before its parent did; clamping beats rejecting, since
    // the number came from a picker and the intent is obvious either way.
    started_at: parent ? Math.max(startedAt, parent.started_at) : startedAt,
  });
  return c.json(started, 201);
});

/** Stop this one and anything under it. Its parent, if any, becomes current again. */
app.post("/api/activities/:id/end", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const row = await db.activity(id);
  if (!row) return c.json({ error: "No such activity" }, 404);

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    // An end with no body means "now", which is the common case.
  }
  const at = typeof body.ended_at === "number" && Number.isFinite(body.ended_at)
    ? Math.max(body.ended_at, row.started_at)
    : Date.now();

  const closed = await db.endActivity(id, at);
  return c.json({ ended: closed, ended_at: at });
});

/** No window here, unlike a note. An activity is a claim about time, not a record
 *  of something that happened, so removing a wrong one is only ever a correction. */
app.delete("/api/activities/:id", async (c) => {
  const gone = await c.get("db").deleteActivity(c.req.param("id"));
  return gone ? c.json({ deleted: true }) : c.json({ error: "No such activity" }, 404);
});

/** Corrections, which §11 asks for by name: "always manually correctable". */
app.patch("/api/activities/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const patch: { label?: string; started_at?: number; ended_at?: number | null } = {};
  if (typeof body.label === "string" && body.label.trim()) patch.label = body.label;
  if (typeof body.started_at === "number" && Number.isFinite(body.started_at)) {
    patch.started_at = body.started_at;
  }
  // null reopens it — the way to undo an end that was recorded too early.
  if (body.ended_at === null) patch.ended_at = null;
  else if (typeof body.ended_at === "number" && Number.isFinite(body.ended_at)) {
    patch.ended_at = body.ended_at;
  }

  if (patch.started_at != null && patch.ended_at != null && patch.ended_at < patch.started_at) {
    return c.json({ error: "That would end it before it started." }, 400);
  }

  const row = await db.updateActivity(id, patch);
  if (!row) return c.json({ error: "No such activity" }, 404);
  if (row.ended_at != null && row.ended_at < row.started_at) {
    return c.json({ error: "That would end it before it started." }, 400);
  }
  return c.json(row);
});

/* ------------------------------------------------------------------- files
 *
 * Two destinations, chosen by the bytes rather than by which button was pressed.
 *
 * Images go to the photo bucket, which img.jpsapps.com serves publicly. §3 chose
 * that so serving bypasses the Worker and does not consume request quota, and
 * photos are the high-volume, bandwidth-heavy case where that actually matters.
 *
 * Everything else goes to the file bucket, which has no custom domain and is
 * therefore reachable only through the Worker — which is to say only through
 * Access. A site drawing or a config export should stop being reachable when
 * sharing is revoked, and a public URL never does: revocation lives in the app and
 * the CDN was never asked who was calling.
 */

/** 25 MB. R2's free tier is 10 GB in total; one file should not be a slice of it. */
const MAX_UPLOAD = 25_000_000;

/**
 * A filename off the wire, made safe to store and to echo back in a header.
 *
 * Arrives percent-encoded because a header cannot carry arbitrary UTF-8, and a
 * filename is user input either way: quotes and newlines would let it break out of
 * the Content-Disposition header it ends up in, and path separators would let it
 * suggest a directory.
 */
function safeName(raw: string, fallback: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not valid percent-encoding; take it literally rather than losing the name.
  }
  const cleaned = decoded.replace(/[\r\n"\\]/g, "").replace(/[/\\]/g, "-").trim();
  return cleaned.slice(0, 120) || fallback;
}

app.post("/api/files", async (c) => {
  const db = c.get("db");
  const entryId = c.req.query("entry_id") ?? "";
  const subjectId = c.req.query("subject_id") ?? "";

  if (!entryId && !subjectId) {
    return c.json({ error: "entry_id or subject_id is required" }, 400);
  }
  if (entryId && !(await db.ownsEntry(entryId))) return c.json({ error: "No such entry" }, 404);
  if (subjectId && !(await db.ownsSubject(subjectId))) {
    return c.json({ error: "No such subject" }, 404);
  }

  const mime = (c.req.header("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "Empty upload" }, 400);
  if (bytes.byteLength > MAX_UPLOAD) return c.json({ error: "Too large — 25 MB maximum" }, 413);

  const title = safeName(c.req.header("x-filename") ?? "", "attachment");
  const isImage = mime.startsWith("image/");

  if (isImage) {
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    const key = photoKey(db.userId, new Date(), ext);
    await c.env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: mime } });
    const id = await db.addAttachment({
      entry_id: entryId || null,
      subject_id: subjectId || null,
      kind: "photo",
      r2_key: key,
      mime,
      bytes: bytes.byteLength,
      title,
    });
    return c.json({ id, kind: "photo", title, url: `${c.env.IMG_BASE}/${key}` }, 201);
  }

  const key = fileKey(db.userId);
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
  const id = await db.addAttachment({
    entry_id: entryId || null,
    subject_id: subjectId || null,
    kind: "file",
    r2_key: key,
    mime,
    bytes: bytes.byteLength,
    title,
  });
  // A relative URL, because this one has to come back through the Worker.
  return c.json({ id, kind: "file", title, url: `/api/files/${id}`, bytes: bytes.byteLength }, 201);
});

/**
 * Serve a document. Access has already run; the row lookup is scoped to the user,
 * so a file cannot be fetched by guessing an id.
 *
 * Always a download, never a render. An uploaded HTML file served inline from this
 * origin would run its scripts as the app — same origin, so with reach into the
 * Access session and the offline queue. Downloading costs one click and removes the
 * whole class of problem, and nosniff stops the browser reinterpreting the bytes.
 */
app.get("/api/files/:id", async (c) => {
  const db = c.get("db");
  const row = await db.attachment(c.req.param("id"));
  if (!row || !row.r2_key) return c.json({ error: "No such file" }, 404);

  const bucket = row.kind === "photo" ? c.env.PHOTOS : c.env.FILES;
  const obj = await bucket.get(row.r2_key);
  if (!obj) return c.json({ error: "The file is gone" }, 404);

  const name = safeName(row.title ?? "", "attachment");
  return new Response(obj.body, {
    headers: {
      "content-type": row.mime ?? "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=3600",
    },
  });
});

app.delete("/api/files/:id", async (c) => {
  const db = c.get("db");
  const row = await db.removeAttachment(c.req.param("id"));
  if (!row) return c.json({ error: "No such file" }, 404);
  if (row.r2_key) {
    // The row is what the app can see, but the object is what exists. Deleting only
    // the row would leave a photo sitting at its public URL with nothing recording
    // that it is there.
    const bucket = row.kind === "photo" ? c.env.PHOTOS : c.env.FILES;
    await bucket.delete(row.r2_key);
  }
  return c.json({ deleted: true });
});

/**
 * Attach a thing to an entry that already exists.
 *
 * Linking used to be possible only at capture, as chips you had to clear before
 * saving — taxonomy before the thought was finished, which is friction at the one
 * moment §1 says must have none. The link happens after the note is safe instead,
 * so this endpoint is what that taps land on. It is also the only way to attach
 * something to a note captured weeks ago.
 *
 * Idempotent: linkEntrySubjects ignores a pair that already exists, so a retry from
 * the offline queue cannot double-write and the client never has to track whether
 * its tap got through.
 */
app.post("/api/entries/:id/subjects", async (c) => {
  const id = c.req.param("id");
  const db = c.get("db");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const ids = Array.isArray(body.subject_ids)
    ? body.subject_ids.filter((v): v is string => typeof v === "string")
    : [];
  if (!ids.length) return c.json({ error: "subject_ids is required" }, 400);

  // Checked explicitly: entry_subjects carries its own user_id, so writing a row
  // here without asking would let a link be made against an entry that is not the
  // caller's — the row would look perfectly valid.
  if (!(await db.ownsEntry(id))) return c.json({ error: "No such entry" }, 404);

  await db.linkEntrySubjects(id, ids);
  return c.json({ subjects: await db.entrySubjects(id) });
});

/** What Claude is connected to, and the switch that cuts it off. */
app.get("/api/connections", async (c) => {
  return c.json({ connections: await c.get("db").connections() });
});

app.delete("/api/connections/:hash", async (c) => {
  const gone = await c.get("db").revokeConnection(decodeURIComponent(c.req.param("hash")));
  return gone ? c.json({ revoked: true }) : c.json({ error: "No such connection" }, 404);
});

/** Ends the Cloudflare Access session, not just the app session. */
app.get("/logout", (c) => c.redirect("/cdn-cgi/access/logout"));

// Static shell. Anything not matched above is served from public/.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
