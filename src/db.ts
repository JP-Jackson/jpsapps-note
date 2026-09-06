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

export interface AttachmentRow {
  id: string;
  kind: string;
  r2_key: string | null;
  mime: string | null;
  bytes: number | null;
  created_at: number;
}

/** An entry plus everything the detail view needs in one round trip. */
export interface EntryDetail extends EntryRow {
  version: number;
  edited_at: number | null;
  attachments: AttachmentRow[];
  /** The entry that closed this one out, if any (§4 resolved_by). */
  resolved_by: EntryRow | null;
  /** The open entry this one closed out, if any — the other end of the thread. */
  resolves: EntryRow | null;
}

/** Raised when an edit is based on a version the server has already moved past. */
export class VersionConflict extends Error {
  constructor(readonly current: EntryDetail) {
    super("This entry changed since you started editing");
  }
}

export interface NewAttachment {
  entry_id: string;
  kind: string;
  r2_key: string;
  mime: string;
  bytes: number;
}

export interface SubjectRow {
  id: string;
  name: string;
  type: string;
  context: string;
  visibility: string;
  hero_photo_id: string | null;
  created_at: number;
  archived_at: number | null;
}

export interface AttributeRow {
  key: string;
  value: string | null;
  sort_order: number;
}

export interface TemplateField {
  type: string;
  key: string;
  label: string;
  sort_order: number;
}

export interface SubjectDetail extends SubjectRow {
  attributes: AttributeRow[];
  entries: EntryRow[];
  attachments: AttachmentRow[];
}

export interface NewSubject {
  name: string;
  type: string;
  context: string;
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

  /**
   * One day's captures, newest first. The client sends the local day bounds rather
   * than a date string: "today" is the user's day, and the server has no business
   * guessing their timezone.
   */
  async entriesForDay(fromMs: number, toMs: number): Promise<EntryRow[]> {
    return this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT id, created_at, synced_at, context, body, body_raw, lat, lng, is_open
             FROM entries
            WHERE user_id = ? AND deleted_at IS NULL
              AND created_at >= ? AND created_at < ?
            ORDER BY created_at DESC`,
        )
        .bind(this.userId, fromMs, toMs),
    );
  }

  /**
   * Open follow-ups, OLDEST first (§11 phase 3).
   *
   * The order is the point: the thing that has been hanging longest is the thing
   * most likely to be forgotten, so it goes at the top rather than scrolling off the
   * bottom. Rides idx_entries_open(user_id, is_open, created_at).
   */
  async openEntries(limit = 100): Promise<EntryRow[]> {
    return this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT id, created_at, synced_at, context, body, body_raw, lat, lng, is_open
             FROM entries
            WHERE user_id = ? AND is_open = 1 AND deleted_at IS NULL
            ORDER BY created_at ASC
            LIMIT ?`,
        )
        .bind(this.userId, limit),
    );
  }

  /**
   * Substring search over the note and the original dictation.
   *
   * Deliberately a LIKE scan, not FTS: §3 rules out retrieval machinery at this size,
   * and a few thousand entries scan comfortably inside the daily row-read budget.
   * `body_raw` is searched too, so a word that an edit removed is still findable.
   */
  async searchEntries(q: string, limit = 50): Promise<EntryRow[]> {
    const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    return this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT id, created_at, synced_at, context, body, body_raw, lat, lng, is_open
             FROM entries
            WHERE user_id = ? AND deleted_at IS NULL
              AND (body LIKE ?2 ESCAPE '\\' OR body_raw LIKE ?2 ESCAPE '\\')
            ORDER BY created_at DESC
            LIMIT ?3`,
        )
        .bind(this.userId, like, limit),
    );
  }

  /** An entry with its photos and both ends of its follow-up thread. */
  async entryDetail(id: string): Promise<EntryDetail | null> {
    const row = await this.first<EntryRow & { version: number; edited_at: number | null; resolved_by_id: string | null }>(
      this.d1
        .prepare(
          `SELECT id, created_at, synced_at, context, body, body_raw, lat, lng, is_open,
                  version, edited_at, resolved_by AS resolved_by_id
             FROM entries
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(id, this.userId),
    );
    if (!row) return null;

    const attachments = await this.all<AttachmentRow>(
      this.d1
        .prepare(
          `SELECT id, kind, r2_key, mime, bytes, created_at
             FROM attachments
            WHERE entry_id = ? AND user_id = ?
            ORDER BY created_at ASC`,
        )
        .bind(id, this.userId),
    );

    const brief = `SELECT id, created_at, synced_at, context, body, body_raw, lat, lng, is_open
                     FROM entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL`;

    const resolved_by = row.resolved_by_id
      ? await this.first<EntryRow>(this.d1.prepare(brief).bind(row.resolved_by_id, this.userId))
      : null;

    // The other direction: did THIS entry close something out?
    const resolves = await this.first<EntryRow>(
      this.d1
        .prepare(
          `SELECT id, created_at, synced_at, context, body, body_raw, lat, lng, is_open
             FROM entries WHERE resolved_by = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(id, this.userId),
    );

    const { resolved_by_id: _drop, ...entry } = row;
    return { ...entry, attachments, resolved_by, resolves };
  }

  /**
   * Edit an entry's note text.
   *
   * `body_raw` is never touched (§4): the original dictation survives every edit, so
   * you can always re-derive from the words actually spoken. `version` implements the
   * first of §6's conflict defences — the client sends the version it started from and
   * the write is refused if the server has moved on, rather than silently overwriting.
   */
  async editEntry(id: string, body: string | null, expectedVersion: number): Promise<EntryDetail> {
    const res = await this.d1
      .prepare(
        `UPDATE entries
            SET body = ?, edited_at = ?, version = version + 1
          WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NULL`,
      )
      .bind(body, Date.now(), id, this.userId, expectedVersion)
      .run();
    readMeta(this.meter, res.meta);

    const current = await this.entryDetail(id);
    if (!current) throw new Error("No such entry");
    // Zero rows changed with the row still present means the version moved on.
    if ((res.meta?.changes ?? 0) === 0) throw new VersionConflict(current);
    return current;
  }

  /**
   * Close out an open follow-up.
   *
   * Resolving points the open entry at the entry that answered it (§4 resolved_by),
   * so the thread is navigable from either end, and clears is_open so it leaves the
   * open list. Passing no resolver just closes it.
   */
  async resolveEntry(id: string, resolverId: string | null): Promise<void> {
    await this.run(
      this.d1
        .prepare(
          `UPDATE entries SET is_open = 0, resolved_by = ?
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(resolverId, id, this.userId),
    );
  }

  /** Reopen a follow-up that was closed too eagerly. */
  async reopenEntry(id: string): Promise<void> {
    await this.run(
      this.d1
        .prepare(
          `UPDATE entries SET is_open = 1, resolved_by = NULL
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(id, this.userId),
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

  // ----------------------------------------------------------------- subjects

  /** What to ask when adding a subject of a given type (§4). Global reference data. */
  async templates(): Promise<TemplateField[]> {
    return this.all<TemplateField>(
      this.d1.prepare(
        "SELECT type, key, label, sort_order FROM subject_templates ORDER BY type, sort_order",
      ),
    );
  }

  async listSubjects(includeArchived = false): Promise<SubjectRow[]> {
    return this.all<SubjectRow>(
      this.d1
        .prepare(
          `SELECT id, name, type, context, visibility, hero_photo_id, created_at, archived_at
             FROM subjects
            WHERE user_id = ?` +
            (includeArchived ? "" : " AND archived_at IS NULL") +
            ` ORDER BY name COLLATE NOCASE`,
        )
        .bind(this.userId),
    );
  }

  async createSubject(sub: NewSubject): Promise<string> {
    const id = newId();
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO subjects (id, user_id, name, type, context, visibility, created_at)
           VALUES (?, ?, ?, ?, ?, 'private', ?)`,
        )
        .bind(id, this.userId, sub.name, sub.type, sub.context, Date.now()),
    );
    return id;
  }

  /**
   * A subject with its attributes, its full history, and anything attached to it.
   *
   * The history is the point of the page (§8d): the fix you logged last time is in
   * front of you before you start guessing again.
   */
  async subjectDetail(id: string): Promise<SubjectDetail | null> {
    const row = await this.first<SubjectRow>(
      this.d1
        .prepare(
          `SELECT id, name, type, context, visibility, hero_photo_id, created_at, archived_at
             FROM subjects WHERE id = ? AND user_id = ?`,
        )
        .bind(id, this.userId),
    );
    if (!row) return null;

    const attributes = await this.all<AttributeRow>(
      this.d1
        .prepare(
          `SELECT key, value, sort_order FROM subject_attributes
            WHERE subject_id = ? AND user_id = ? ORDER BY sort_order, key`,
        )
        .bind(id, this.userId),
    );

    const entries = await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT e.id, e.created_at, e.synced_at, e.context, e.body, e.body_raw,
                  e.lat, e.lng, e.is_open
             FROM entries e
             JOIN entry_subjects es ON es.entry_id = e.id
            WHERE es.subject_id = ? AND e.user_id = ? AND e.deleted_at IS NULL
            ORDER BY e.created_at DESC
            LIMIT 200`,
        )
        .bind(id, this.userId),
    );

    const attachments = await this.all<AttachmentRow>(
      this.d1
        .prepare(
          `SELECT id, kind, r2_key, mime, bytes, created_at
             FROM attachments WHERE subject_id = ? AND user_id = ?
            ORDER BY created_at DESC`,
        )
        .bind(id, this.userId),
    );

    return { ...row, attributes, entries, attachments };
  }

  /**
   * Replace a subject's attributes.
   *
   * Key-value rather than a column per field (§4), so a new kind of thing never
   * needs a migration. Sent as a whole set because the edit screen owns the whole
   * set — a partial merge would make a deleted row indistinguishable from an
   * untouched one.
   */
  async setAttributes(subjectId: string, attrs: AttributeRow[]): Promise<void> {
    const owned = await this.first<{ id: string }>(
      this.d1.prepare("SELECT id FROM subjects WHERE id = ? AND user_id = ?")
        .bind(subjectId, this.userId),
    );
    if (!owned) throw new Error("No such subject");

    const stmts: D1PreparedStatement[] = [
      this.d1.prepare("DELETE FROM subject_attributes WHERE subject_id = ? AND user_id = ?")
        .bind(subjectId, this.userId),
    ];
    attrs
      .filter((a) => a.key.trim())
      .forEach((a, i) =>
        stmts.push(
          this.d1
            .prepare(
              `INSERT INTO subject_attributes (subject_id, user_id, key, value, sort_order)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(subjectId, this.userId, a.key.trim(), a.value ?? null, a.sort_order ?? i),
        ),
      );
    const res = await this.d1.batch(stmts);
    res.forEach((r) => readMeta(this.meter, r.meta));
  }

  async updateSubject(
    id: string,
    patch: { name?: string; context?: string; visibility?: string; hero_photo_id?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (!sets.length) return;
    await this.run(
      this.d1
        .prepare(`UPDATE subjects SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
        .bind(...vals, id, this.userId),
    );
  }

  async archiveSubject(id: string, archived: boolean): Promise<void> {
    await this.run(
      this.d1
        .prepare("UPDATE subjects SET archived_at = ? WHERE id = ? AND user_id = ?")
        .bind(archived ? Date.now() : null, id, this.userId),
    );
  }

  /** Link an entry to subjects. One capture can touch a site, a panel and a device (§4). */
  async linkEntrySubjects(entryId: string, subjectIds: string[]): Promise<void> {
    if (!subjectIds.length) return;
    const stmts = subjectIds.map((sid) =>
      this.d1
        .prepare(
          `INSERT INTO entry_subjects (entry_id, subject_id, user_id) VALUES (?, ?, ?)
           ON CONFLICT (entry_id, subject_id) DO NOTHING`,
        )
        .bind(entryId, sid, this.userId),
    );
    const res = await this.d1.batch(stmts);
    res.forEach((r) => readMeta(this.meter, r.meta));
  }

  /** Which subjects a given entry touches — for the entry detail page. */
  async entrySubjects(entryId: string): Promise<SubjectRow[]> {
    return this.all<SubjectRow>(
      this.d1
        .prepare(
          `SELECT s.id, s.name, s.type, s.context, s.visibility, s.hero_photo_id,
                  s.created_at, s.archived_at
             FROM subjects s
             JOIN entry_subjects es ON es.subject_id = s.id
            WHERE es.entry_id = ? AND s.user_id = ?
            ORDER BY s.name COLLATE NOCASE`,
        )
        .bind(entryId, this.userId),
    );
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
