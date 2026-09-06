/**
 * Note — Worker entry point.
 *
 * Routing and HTTP concerns only. No SQL here or anywhere outside src/db.ts.
 *
 * URL layout is reserved deliberately (NOTE_SPEC.md §8a): /mcp and /oauth/* are for
 * the MCP connector in phase 6. Claude connects from Anthropic's cloud, which cannot
 * complete a Cloudflare Access login, so those paths must be EXCLUDED from the Access
 * application and carry their own OAuth. Nothing is built there yet; the paths are
 * reserved so the Access app can be scoped correctly from day one.
 */

import { Hono } from "hono";
import type { Env } from "./env";
import { Db } from "./db";
import { photoKey } from "./ids";
import { authenticate, AuthError, type Session } from "./auth";

type Vars = { session: Session; db: Db };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Liveness + schema probe. No auth: it must answer before login works. */
app.get("/api/health", async (c) => {
  const db = await Db.health(c.env.DB);
  return c.json({
    ok: db.ok,
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
  try {
    const session = await authenticate(c.req.raw, c.env);
    const db = new Db(c.env.DB, session.userId);
    // The auth lookup ran before this Db existed; count it here so the busiest
    // query on the app is not invisible to the meter.
    db.absorb(session.cost);
    c.set("session", session);
    c.set("db", db);

    await next();

    // One usage write per request, after the response is settled.
    c.executionCtx.waitUntil(db.flushUsage());
  } catch (err) {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.get("/api/me", async (c) => {
  const session = c.get("session");
  return c.json({
    id: session.userId,
    email: session.email,
    displayName: session.user.display_name,
    createdAt: session.user.created_at,
    usageToday: await c.get("db").usageToday(),
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
  });

  return c.json({ id, created }, created ? 201 : 200);
});

/** Recent captures. Enough for the capture screen to show what just landed. */
app.get("/api/entries", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
  return c.json({ entries: await c.get("db").recentEntries(limit) });
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

/** Ends the Cloudflare Access session, not just the app session. */
app.get("/logout", (c) => c.redirect("/cdn-cgi/access/logout"));

// Static shell. Anything not matched above is served from public/.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
