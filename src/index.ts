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
import { Db, VersionConflict } from "./db";
import { photoKey } from "./ids";
import { VERSION } from "./version";
import { authenticate, AuthError, type Session } from "./auth";

type Vars = { session: Session; db: Db };
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
    photos: detail.attachments
      .filter((a) => a.kind === "photo" && a.r2_key)
      .map((a) => ({ id: a.id, url: `${c.env.IMG_BASE}/${a.r2_key}` })),
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

/* ------------------------------------------------------------------- subjects */

/** What to ask when adding each type of subject (§4). */
app.get("/api/templates", async (c) => {
  return c.json({ templates: await c.get("db").templates() });
});

app.get("/api/subjects", async (c) => {
  const includeArchived = c.req.query("archived") === "1";
  return c.json({ subjects: await c.get("db").listSubjects(includeArchived) });
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
  const id = await db.createSubject({ name, type, context });
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
      const id = await db.createSubject({
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
  return c.json({
    ...detail,
    photos: detail.attachments
      .filter((a) => a.kind === "photo" && a.r2_key)
      .map((a) => ({ id: a.id, url: `${c.env.IMG_BASE}/${a.r2_key}` })),
  });
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
  for (const k of ["name", "context", "visibility", "hero_photo_id"]) {
    if (typeof body[k] === "string") patch[k] = body[k];
  }
  if (Object.keys(patch).length) await db.updateSubject(id, patch);

  const detail = await db.subjectDetail(id);
  if (!detail) return c.json({ error: "No such subject" }, 404);
  return c.json(detail);
});

/** Ends the Cloudflare Access session, not just the app session. */
app.get("/logout", (c) => c.redirect("/cdn-cgi/access/logout"));

// Static shell. Anything not matched above is served from public/.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
