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
  place_id?: string | null;
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

export interface PlaceRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  context: string | null;
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

export interface AuthCode {
  user_id: string;
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  code_challenge: string;
}

export interface TokenRow {
  user_id: string;
  client_id: string;
  client_name: string | null;
  kind: string;
  expires_at: number;
}

/** One live MCP connection, as the settings screen shows it. */
export interface ConnectionRow {
  token_hash: string;
  client_name: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
}

/**
 * The two contexts.
 *
 * Context is the sharing boundary, not a topic tag: §7 draws the line at "JP's wife
 * sees Home, she never sees Work". "Vehicles" was a third chip and never a boundary —
 * a work truck is Work and her car is Home, and as a peer of those two it could
 * express neither. Filtering to vehicles is answered by type = 'vehicle' on the
 * thing, which is where it belonged all along.
 *
 * Also a hard filter everywhere it appears, so free text from the bulk importer is
 * normalised here rather than trusted; a subject stored as "vehicle " could never be
 * attached to anything and looked, from the app, simply broken.
 *
 * "vehicles" is rejected rather than mapped. Half of them are Work and half are Home,
 * so a guess here would be wrong about half the time and silent every time.
 */
const CONTEXTS = ["work", "home"] as const;
const CONTEXT_ALIASES: Record<string, string> = {};

export class BadContext extends Error {
  constructor(readonly given: string) {
    super(`"${given}" is not a context. Use work or home.`);
  }
}

function normaliseContext(raw: string): string {
  const v = raw.trim().toLowerCase();
  const mapped = CONTEXT_ALIASES[v] ?? v;
  if (!(CONTEXTS as readonly string[]).includes(mapped)) throw new BadContext(raw);
  return mapped;
}

/**
 * Type only decides which fields a new thing is asked for, so an unrecognised one
 * costs nothing but a blank template — "zero turn mower" is a real answer to the
 * wrong question. Fold it to generic, which holds any field anyway (§4).
 */
const TYPES = ["equipment", "vehicle", "generic"] as const;

function normaliseType(raw: string): string {
  const v = raw.trim().toLowerCase();
  return (TYPES as readonly string[]).includes(v) ? v : "generic";
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

  // ------------------------------------------------------------------- OAuth
  // Static for the same reason as the lookups above: the token exchange happens
  // before any session exists — the code is what establishes who the user is.
  // Only hashes are passed in; this file never sees a token in the clear.

  /** Redeem an authorisation code. Single use: the row is deleted as it is read. */
  static async consumeAuthCode(d1: D1Database, codeHash: string): Promise<AuthCode | null> {
    const res = await d1
      .prepare(
        `DELETE FROM oauth_codes WHERE code_hash = ? AND expires_at > ?
         RETURNING user_id, client_id, client_name, redirect_uri, code_challenge`,
      )
      .bind(codeHash, Date.now())
      .all<AuthCode>();
    return res.results[0] ?? null;
  }

  /**
   * Look up a bearer token.
   *
   * `last_used_at` is deliberately not written here. It would turn every MCP call
   * into a write, and the only thing it buys is a nicer line on the settings
   * screen; the token exchange already stamps it.
   */
  static async findToken(d1: D1Database, tokenHash: string, kind: string): Promise<TokenRow | null> {
    const res = await d1
      .prepare(
        `SELECT user_id, client_id, client_name, kind, expires_at FROM oauth_tokens
          WHERE token_hash = ? AND kind = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(tokenHash, kind, Date.now())
      .all<TokenRow>();
    return res.results[0] ?? null;
  }

  /** Issue an access/refresh pair. Written together so neither can exist alone. */
  static async issueTokens(
    d1: D1Database,
    t: {
      userId: string;
      clientId: string;
      clientName: string | null;
      accessHash: string;
      accessExpiresAt: number;
      refreshHash: string;
      refreshExpiresAt: number;
    },
  ): Promise<void> {
    const now = Date.now();
    const stmt = (hash: string, kind: string, expires: number) =>
      d1
        .prepare(
          `INSERT INTO oauth_tokens
             (token_hash, user_id, client_id, client_name, kind, created_at, expires_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(hash, t.userId, t.clientId, t.clientName, kind, now, expires, now);
    await d1.batch([
      stmt(t.accessHash, "access", t.accessExpiresAt),
      stmt(t.refreshHash, "refresh", t.refreshExpiresAt),
    ]);
  }

  /**
   * Retire a refresh token as it is spent.
   *
   * Rotation is the point: a refresh token used twice means one of the two holders
   * is not the client we issued it to, and revoking on first use is what makes that
   * detectable rather than silent.
   */
  static async revokeTokenHash(d1: D1Database, tokenHash: string): Promise<void> {
    await d1
      .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(Date.now(), tokenHash)
      .run();
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
           (id, user_id, created_at, synced_at, context, body, body_raw, lat, lng, is_open, place_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        e.place_id ?? null,
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

  // ------------------------------------------------------------------- places
  // §4: raw coordinates are stored on every entry regardless. Places are a
  // convenience laid over them — matched by proximity, suggested, never forced.

  async listPlaces(): Promise<PlaceRow[]> {
    return this.all<PlaceRow>(
      this.d1
        .prepare(
          `SELECT p.id, p.name, p.lat, p.lng, p.radius_m,
                  (SELECT e.context FROM entries e
                    WHERE e.place_id = p.id AND e.user_id = p.user_id
                    GROUP BY e.context ORDER BY COUNT(*) DESC LIMIT 1) AS context
             FROM places p
            WHERE p.user_id = ?
            ORDER BY p.name COLLATE NOCASE`,
        )
        .bind(this.userId),
    );
  }

  async createPlace(name: string, lat: number, lng: number, radiusM = 150): Promise<string> {
    const id = newId();
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO places (id, user_id, name, lat, lng, radius_m, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, this.userId, name, lat, lng, radiusM, Date.now()),
    );
    return id;
  }

  /**
   * How many past captures sit near here with no place named yet.
   *
   * §4: "after the second or third capture at an unnamed spot, offer to name it."
   * That is the whole mechanism — the app learns your places from where you actually
   * work rather than asking you to enter them up front.
   *
   * Filtered to a crude lat/lng box first so the scan stays cheap, then measured
   * properly in the caller. A degree of latitude is ~111km everywhere; longitude
   * narrows with latitude, but the box only has to be generous, not exact.
   */
  async unnamedNearby(lat: number, lng: number, metres = 150): Promise<{ lat: number; lng: number }[]> {
    const d = (metres * 2) / 111_000;
    return this.all<{ lat: number; lng: number }>(
      this.d1
        .prepare(
          `SELECT lat, lng FROM entries
            WHERE user_id = ? AND place_id IS NULL AND deleted_at IS NULL
              AND lat IS NOT NULL
              AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
            LIMIT 50`,
        )
        .bind(this.userId, lat - d, lat + d, lng - d * 4, lng + d * 4),
    );
  }

  /** Attach captures made at this spot to a newly named place. */
  async claimEntriesForPlace(placeId: string, lat: number, lng: number, metres = 150): Promise<number> {
    const d = (metres * 2) / 111_000;
    const res = await this.d1
      .prepare(
        `UPDATE entries SET place_id = ?
          WHERE user_id = ? AND place_id IS NULL AND deleted_at IS NULL
            AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
      )
      .bind(placeId, this.userId, lat - d, lat + d, lng - d * 4, lng + d * 4)
      .run();
    readMeta(this.meter, res.meta);
    return res.meta?.changes ?? 0;
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

  /** Returns the normalised row, not just its id: what was asked for and what was
   *  stored can differ, and a caller that reports the request back is reporting a
   *  value the database does not hold. */
  async createSubject(sub: NewSubject): Promise<{ id: string; type: string; context: string }> {
    const id = newId();
    const context = normaliseContext(sub.context);
    const type = normaliseType(sub.type);
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO subjects (id, user_id, name, type, context, visibility, created_at)
           VALUES (?, ?, ?, ?, ?, 'private', ?)`,
        )
        .bind(id, this.userId, sub.name.trim(), type, context, Date.now()),
    );
    return { id, type, context };
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
      // Same rule on the way in through an edit as on the way in through creation.
      vals.push(k === "context" && typeof v === "string" ? normaliseContext(v) : v);
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

  // ----------------------------------------------------------- OAuth, scoped

  /**
   * Park an authorisation code for the token exchange to redeem.
   *
   * Two minutes is the whole window: the client already holds the redirect and is
   * about to POST it back, so anything longer is only extra time for a code sitting
   * in a browser history to be useful to someone else.
   */
  async saveAuthCode(c: {
    codeHash: string;
    clientId: string;
    clientName: string | null;
    redirectUri: string;
    codeChallenge: string;
  }): Promise<void> {
    const now = Date.now();
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO oauth_codes
             (code_hash, user_id, client_id, client_name, redirect_uri, code_challenge, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          c.codeHash,
          this.userId,
          c.clientId,
          c.clientName,
          c.redirectUri,
          c.codeChallenge,
          now,
          now + 120_000,
        ),
    );
  }

  /** Live connections, newest first. Access tokens only — one row per connection. */
  async connections(): Promise<ConnectionRow[]> {
    return this.all<ConnectionRow>(
      this.d1
        .prepare(
          `SELECT token_hash, client_name, created_at, last_used_at, expires_at
             FROM oauth_tokens
            WHERE user_id = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC`,
        )
        .bind(this.userId, Date.now()),
    );
  }

  /**
   * Cut off a connection.
   *
   * The refresh token issued alongside goes too — revoking only the access token
   * would let the client mint a new one within the hour, which is not what anyone
   * means by "disconnect".
   */
  async revokeConnection(tokenHash: string): Promise<boolean> {
    const row = await this.first<{ client_id: string; created_at: number }>(
      this.d1
        .prepare("SELECT client_id, created_at FROM oauth_tokens WHERE token_hash = ? AND user_id = ?")
        .bind(tokenHash, this.userId),
    );
    if (!row) return false;
    await this.run(
      this.d1
        .prepare(
          `UPDATE oauth_tokens SET revoked_at = ?
            WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL`,
        )
        .bind(Date.now(), this.userId, row.client_id),
    );
    return true;
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
