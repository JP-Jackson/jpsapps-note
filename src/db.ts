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
function readMeta(meter: Meter, meta: D1Meta | undefined): void {
  if (!meta) return;
  meter.rows_read += meta.rows_read ?? 0;
  meter.rows_written += meta.rows_written ?? 0;
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

  static async findUserByEmail(d1: D1Database, email: string): Promise<UserRow | null> {
    const res = await d1
      .prepare("SELECT id, email, display_name, created_at FROM users WHERE email = ?")
      .bind(email.toLowerCase())
      .all<UserRow>();
    return res.results[0] ?? null;
  }

  static async createUser(
    d1: D1Database,
    email: string,
    displayName: string | null = null,
  ): Promise<UserRow> {
    const row: UserRow = {
      id: newId(),
      email: email.toLowerCase(),
      display_name: displayName,
      created_at: Date.now(),
    };
    await d1
      .prepare(
        "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(row.id, row.email, row.display_name, row.created_at)
      .run();
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
  ): Promise<UserRow | null> {
    const existing = await Db.findUserByEmail(d1, email);
    if (existing) return existing;

    const allowed = allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(email.toLowerCase())) return null;

    return Db.createUser(d1, email);
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
