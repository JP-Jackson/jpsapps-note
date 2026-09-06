/**
 * The data module.
 *
 * This is the ONLY file in the codebase that touches D1. Nothing else imports
 * D1Database, prepares a statement, or writes SQL. NOTE_SPEC.md §3 calls for this
 * as portability discipline — SQLite is the most portable database format there is,
 * and if a port is ever needed it touches one place. It is also the mechanism that
 * enforces user scoping: `Db` is constructed with a user_id and every instance
 * method scopes to it, so a route handler has no way to forget it.
 *
 * Deliberately NOT a database-agnostic abstraction layer (§3) — that is real cost
 * for a hypothetical. This is one file with SQL in it.
 */

import { newId, utcDay } from "./ids";

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  created_at: number;
}

/**
 * Row cost of the pre-session lookups, which run before a user_id exists and so
 * cannot tally into an instance meter. Returned to the caller and handed back with
 * `absorb()` once the Db is built, so the auth query is counted like any other.
 * Deliberately plain numbers, not a D1 type — nothing D1-shaped leaves this file.
 */
export interface QueryCost {
  rows_read: number;
  rows_written: number;
}

/** A capture from the device. `id` is generated there, at capture time (§6). */
export interface NewEntry {
  id: string;
  created_at: number;
  context: string;
  body: string | null;
  lat: number | null;
  lng: number | null;
  is_open: boolean;
}

export interface EntryRow {
  id: string;
  created_at: number;
  synced_at: number | null;
  context: string;
  body: string | null;
  body_raw: string | null;
  lat: number | null;
  lng: number | null;
  is_open: number;
}

export interface NewAttachment {
  entry_id: string;
  kind: string;
  r2_key: string;
  mime: string;
  bytes: number;
}

export interface UsageTotals {
  rows_read: number;
  rows_written: number;
  neurons: number;
}

/** Per-request usage tally, flushed once at the end of the request. */
interface Meter {
  rows_read: number;
  rows_written: number;
  neurons: number;
}

/**
 * Every D1 result carries a meta object with rows_read and rows_written. We tally
 * them here rather than polling Cloudflare's analytics API (§4) — accurate, instant,
 * no external dependency. It matters: since 1 September 2026 D1 queries on the free
 * plan fail outright past the daily row limits, so this is a cliff, not a throttle.
 */
function readMeta(meter: Meter | QueryCost, meta: D1Meta | undefined): void {
  if (!meta) return;
  meter.rows_read += meta.rows_read ?? 0;
  meter.rows_written += meta.rows_written ?? 0;
}

function noCost(): QueryCost {
  return { rows_read: 0, rows_written: 0 };
}

export class Db {
  private readonly d1: D1Database;
  readonly userId: string;
  private readonly meter: Meter = { rows_read: 0, rows_written: 0, neurons: 0 };

  constructor(d1: D1Database, userId: string) {
    this.d1 = d1;
    this.userId = userId;
  }

  // ---------------------------------------------------------------- internals

  private async first<T>(stmt: D1PreparedStatement): Promise<T | null> {
    const res = await stmt.all<T>();
    readMeta(this.meter, res.meta);
    return res.results[0] ?? null;
  }

  private async all<T>(stmt: D1PreparedStatement): Promise<T[]> {
    const res = await stmt.all<T>();
    readMeta(this.meter, res.meta);
    return res.results;
  }

  private async run(stmt: D1PreparedStatement): Promise<void> {
    const res = await stmt.run();
    readMeta(this.meter, res.meta);
  }

  // ------------------------------------------------------- pre-session lookups
  // Static because they run before a user_id exists. Still in this file, so the
  // "all database access lives in one module" rule holds.

  /** Cheap liveness probe: does the schema exist and answer? */
  static async health(d1: D1Database): Promise<{ ok: boolean; tables: number }> {
    const res = await d1
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")
      .all<{ n: number }>();
    const n = res.results[0]?.n ?? 0;
    return { ok: n > 0, tables: n };
  }

  static async findUserByEmail(
    d1: D1Database,
    email: string,
    cost: QueryCost = noCost(),
  ): Promise<UserRow | null> {
    const res = await d1
      .prepare("SELECT id, email, display_name, created_at FROM users WHERE email = ?")
      .bind(email.toLowerCase())
      .all<UserRow>();
    readMeta(cost, res.meta);
    return res.results[0] ?? null;
  }

  static async createUser(
    d1: D1Database,
    email: string,
    displayName: string | null = null,
    cost: QueryCost = noCost(),
  ): Promise<UserRow> {
    const row: UserRow = {
      id: newId(),
      email: email.toLowerCase(),
      display_name: displayName,
      created_at: Date.now(),
    };
    const res = await d1
      .prepare(
        "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(row.id, row.email, row.display_name, row.created_at)
      .run();
    readMeta(cost, res.meta);
    return row;
  }

  /**
   * Resolve a verified email to a user row, creating it on first login.
   *
   * Provisioning is gated on an explicit allowlist so that a misconfigured Access
   * policy cannot silently mint accounts. The spec defines what Access does but not
   * how an Access identity becomes an app user; this is that rule.
   */
  static async resolveUser(
    d1: D1Database,
    email: string,
    allowedEmails: string[],
  ): Promise<{ user: UserRow | null; cost: QueryCost }> {
    const cost = noCost();

    const existing = await Db.findUserByEmail(d1, email, cost);
    if (existing) return { user: existing, cost };

    const allowed = allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(email.toLowerCase())) return { user: null, cost };

    return { user: await Db.createUser(d1, email, null, cost), cost };
  }

  // -------------------------------------------------------------- user-scoped

  async getUser(): Promise<UserRow | null> {
    return this.first<UserRow>(
      this.d1
        .prepare("SELECT id, email, display_name, created_at FROM users WHERE id = ?")
        .bind(this.userId),
    );
  }

  /** Today's self-metered usage, for the quota bars (§8b). */
  async usageToday(): Promise<UsageTotals> {
    const rows = await this.all<{ metric: string; amount: number }>(
      this.d1
        .prepare("SELECT metric, amount FROM usage_log WHERE user_id = ? AND day = ?")
        .bind(this.userId, utcDay()),
    );
    const totals: UsageTotals = { rows_read: 0, rows_written: 0, neurons: 0 };
    for (const r of rows) {
      if (r.metric in totals) totals[r.metric as keyof UsageTotals] = r.amount;
    }
    return totals;
  }

  // ------------------------------------------------------------------ entries

  /**
   * Land a captured entry.
   *
   * Idempotent on the client-generated id: a queued entry that gets retried after a
   * flaky sync must not duplicate or overwrite. §6 makes the device the source of
   * ids precisely so two captures can never collide and a replay is a no-op.
   *
   * `body_raw` is written once, here, from the same text as `body`. §4 keeps the
   * original wording forever even after an edit rewrites `body`, so it is set at
   * insert and never touched again.
   */
  async createEntry(e: NewEntry): Promise<{ created: boolean }> {
    const res = await this.d1
      .prepare(
        `INSERT INTO entries
           (id, user_id, created_at, synced_at, context, body, body_raw, lat, lng, is_open)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        e.id,
        this.userId,
        e.created_at,
        Date.now(),
        e.context,
        e.body,
        e.body,
        e.lat,
        e.lng,
        e.is_open ? 1 : 0,
      )
      .run();
    readMeta(this.meter, res.meta);
    return { created: (res.meta?.changes ?? 0) > 0 };
  }

  /** Today's captures, newest first. Rides the (user_id, created_at DESC) index. */
  async recentEntries(limit = 20): Promise<EntryRow[]> {
    return this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT id, created_at, synced_at, context, body, body_raw, lat, lng, is_open
             FROM entries
            WHERE user_id = ? AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .bind(this.userId, limit),
    );
  }

  /** Does this entry belong to the current user? Guards photo attachment. */
  async ownsEntry(entryId: string): Promise<boolean> {
    const row = await this.first<{ id: string }>(
      this.d1
        .prepare("SELECT id FROM entries WHERE id = ? AND user_id = ?")
        .bind(entryId, this.userId),
    );
    return row !== null;
  }

  async addAttachment(a: NewAttachment): Promise<string> {
    const id = newId();
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO attachments
             (id, user_id, entry_id, kind, r2_key, mime, bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, this.userId, a.entry_id, a.kind, a.r2_key, a.mime, a.bytes, Date.now()),
    );
    return id;
  }

  /**
   * Fold in the cost of queries that ran before this Db existed — the auth lookup
   * on every request. Without this the meter undercounts by the one query that
   * runs most often, and §4's row-limit cliff is exactly what it must not miss.
   */
  absorb(cost: QueryCost): void {
    this.meter.rows_read += cost.rows_read;
    this.meter.rows_written += cost.rows_written;
  }

  /** Record Workers AI spend. Added to the tally, flushed with everything else. */
  addNeurons(n: number): void {
    this.meter.neurons += n;
  }

  /**
   * Write this request's tally to usage_log. One write per request, not per query —
   * metering must not cost more than it measures. Call via ctx.waitUntil so it never
   * delays the response.
   */
  async flushUsage(): Promise<void> {
    const day = utcDay();
    const entries = Object.entries(this.meter).filter(([, v]) => v > 0);
    if (entries.length === 0) return;

    await this.d1.batch(
      entries.map(([metric, amount]) =>
        this.d1
          .prepare(
            `INSERT INTO usage_log (user_id, day, metric, amount) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id, day, metric)
             DO UPDATE SET amount = amount + excluded.amount`,
          )
          .bind(this.userId, day, metric, amount),
      ),
    );
  }
}
