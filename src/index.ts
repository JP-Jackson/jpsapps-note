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

/** Ends the Cloudflare Access session, not just the app session. */
app.get("/logout", (c) => c.redirect("/cdn-cgi/access/logout"));

// Static shell. Anything not matched above is served from public/.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
