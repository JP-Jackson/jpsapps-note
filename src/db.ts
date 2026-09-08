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
  /** What was running when this was captured (§11 phase 2: auto-stamped). */
  activity_id?: string | null;
  id: string;
  created_at: number;
  context: string;
  body: string | null;
  lat: number | null;
  lng: number | null;
  is_open: boolean;
  place_id?: string | null;
  /** v2: note | todo | appt | value | spec. Defaults to note. */
  kind?: string;
  due_at?: number | null;
  done_at?: number | null;
  starts_at?: number | null;
  ends_at?: number | null;
  metric?: string | null;
  value?: number | null;
  unit?: string | null;
  spec_key?: string | null;
  spec_value?: string | null;
  amount?: number | null;
  /** 0 lands it in the Inbox to be filed later. */
  reviewed?: boolean;
  schedule_id?: string | null;
}

/** The v2 columns, editable after the fact. */
export interface EntryPatch {
  kind?: string;
  due_at?: number | null;
  done_at?: number | null;
  starts_at?: number | null;
  ends_at?: number | null;
  metric?: string | null;
  value?: number | null;
  unit?: string | null;
  spec_key?: string | null;
  spec_value?: string | null;
  amount?: number | null;
  reviewed?: boolean;
  created_at?: number;
  place_id?: string | null;
}

/** Filters for the table, the tag view and search — one query builder, many doors. */
export interface EntryFilter {
  kind?: string | null;
  subject_id?: string | null;
  /** Tag names; every one must be present (AND). */
  tags?: string[];
  q?: string;
  from?: number;
  to?: number;
  /** To-dos not yet done. */
  open?: boolean;
  reviewed?: boolean;
  metric?: string | null;
  sort?: "created" | "due" | "kind" | "value";
  limit?: number;
}

export interface EntryRow {
  kind: string;
  due_at: number | null;
  done_at: number | null;
  starts_at: number | null;
  ends_at: number | null;
  metric: string | null;
  value: number | null;
  unit: string | null;
  spec_key: string | null;
  spec_value: string | null;
  amount: number | null;
  reviewed: number;
  schedule_id: string | null;
  /** Filled by `decorate`: tag names, and the things it is linked to. */
  tags?: string[];
  subjects?: { id: string; name: string }[];
  id: string;
  /** What was running when this was captured (§11 phase 2). */
  activity_id?: string | null;
  /** Where it happened — chosen, not always where the phone was (§4). */
  place_id?: string | null;
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
  title?: string | null;
  id: string;
  kind: string;
  r2_key: string | null;
  mime: string | null;
  bytes: number | null;
  created_at: number;
}

/** An entry plus everything the detail view needs in one round trip. */
export interface EntryDetail extends EntryRow {
  activity_label?: string | null;
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
  entry_id?: string | null;
  subject_id?: string | null;
  kind: string;
  r2_key: string;
  mime: string;
  bytes: number;
  title?: string | null;
}

export interface SubjectRow {
  /** Only on list queries: the hero photo's object key, for building its URL. */
  hero_key?: string | null;
  id: string;
  name: string;
  type: string;
  context: string;
  visibility: string;
  hero_photo_id: string | null;
  created_at: number;
  archived_at: number | null;
  /** Where it lives. At most one is ever set — see `setHome`. */
  parent_id: string | null;
  place_id: string | null;
}

/** One step of the path down to a thing, root first: 'Home' → 'Yard'. */
export interface Crumb {
  id: string;
  name: string;
  /** 'place' for the root of the tree, 'subject' for every step below it. */
  kind: "place" | "subject";
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
  tags: string[];
  schedules: ScheduleRow[];
  metrics: MetricSeries[];
  attributes: AttributeRow[];
  entries: EntryRow[];
  attachments: AttachmentRow[];
  /** The path down to it, root first, excluding itself. Empty for a root thing. */
  path: Crumb[];
  /** What lives directly under it — its parts. */
  children: SubjectRow[];
}

export interface PlaceRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  context: string | null;
  /** How many things are rooted here. The delete confirm has to be able to say so. */
  things: number;
}

/** A correction to an existing place. Every field is optional; absent means leave it. */
export interface PlacePatch {
  name?: string;
  lat?: number;
  lng?: number;
  radius_m?: number;
}

export interface NewSubject {
  name: string;
  type: string;
  context: string;
  parent_id?: string | null;
  place_id?: string | null;
}

/** Someone involved. Not a subject: a person is at several places, and is not
 *  "inside" one the way a VFD is inside a tank battery. */
export interface PersonRow {
  id: string;
  name: string;
  role: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  context: string;
  created_at: number;
  archived_at: number | null;
  /** Which places they belong to. Filled by the list and detail queries. */
  place_ids: string[];
}

export interface PersonDetail extends PersonRow {
  entries: EntryRow[];
}

export interface PersonPatch {
  name?: string;
  role?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  context?: string;
  place_ids?: string[];
}

/** Where a thing lives. Passing both is a caller error; `setHome` keeps only one. */
export interface Home {
  parent_id?: string | null;
  place_id?: string | null;
}

export class BadParent extends Error {}

export interface ActivityRow {
  id: string;
  parent_id: string | null;
  label: string;
  subject_id: string | null;
  context: string;
  started_at: number;
  ended_at: number | null;
}

export interface NewActivity {
  label: string;
  context: string;
  parent_id?: string | null;
  subject_id?: string | null;
  started_at?: number;
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
const CONTEXTS = ["work", "personal"] as const;
// "home" was the name until 1.24.0; older clients and Claude may still say it.
const CONTEXT_ALIASES: Record<string, string> = { home: "personal" };

export class BadContext extends Error {
  constructor(readonly given: string) {
    super(`"${given}" is not a context. Use work or personal.`);
  }
}

/** A world name, normalised, or null for anything that is not one. */
export function worldOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try { return normaliseContext(raw); } catch { return null; }
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

const KINDS = new Set(["note", "todo", "appt", "value", "spec"]);
/** Unknown kinds become notes rather than errors: a capture must never be refused. */
function normaliseKind(raw: string | null | undefined): string {
  const k = (raw || "note").trim().toLowerCase();
  if (k === "to-do" || k === "task" || k === "action") return "todo";
  if (k === "appointment" || k === "event") return "appt";
  if (k === "reading") return "value";
  return KINDS.has(k) ? k : "note";
}
export { normaliseKind };

function normaliseType(raw: string): string {
  const v = raw.trim().toLowerCase();
  return (TYPES as readonly string[]).includes(v) ? v : "generic";
}

/** Every column a list needs. One string, so a new column cannot be stored and never selected back. */
const ENTRY_COLS = [
  "id", "created_at", "synced_at", "context", "body", "body_raw", "lat", "lng", "is_open",
  "activity_id", "place_id", "kind", "due_at", "done_at", "starts_at", "ends_at", "metric",
  "value", "unit", "spec_key", "spec_value", "amount", "reviewed", "schedule_id",
];
const COLS = ENTRY_COLS.join(", ");
const ECOLS = ENTRY_COLS.map((c) => "e." + c).join(", ");

/** D1 allows 100 bound parameters per statement; IN-lists are chunked under that. */
const CHUNK = 90;

export interface TagRow { id: string; name: string; count: number; }

export interface ScheduleRow {
  id: string;
  subject_id: string | null;
  subject_name?: string | null;
  context: string;
  label: string;
  every_days: number | null;
  every_value: number | null;
  metric: string | null;
  fixed_month: number | null;
  fixed_day: number | null;
  last_done_at: number | null;
  last_value: number | null;
  created_at: number;
  archived_at: number | null;
}

export interface SavedView { id: string; name: string; context: string; query: string; sort_order: number; }

/** A reading series for one metric on one thing, newest first. */
export interface MetricSeries {
  metric: string;
  unit: string | null;
  latest: { value: number; at: number };
  points: { value: number; at: number }[];
}

export class Db {
  private readonly d1: D1Database;
  readonly userId: string;
  private readonly meter: Meter = { rows_read: 0, rows_written: 0, neurons: 0 };
  /** Which world every list is drawn from. Work and personal never intertwine
   *  (decided 7 Sep 2026), so the filter lives here rather than in each screen:
   *  a list that forgets to pass it is scoped anyway. Null means both, which only
   *  the by-id reads and the world switch's own lookups should want. */
  world: string | null = null;

  constructor(d1: D1Database, userId: string, world: string | null = null) {
    this.d1 = d1;
    this.userId = userId;
    this.world = world;
  }

  /** SQL and bindings for the world filter, or nothing when unscoped. */
  private scope(col = "context"): { sql: string; args: string[] } {
    return this.world ? { sql: ` AND ${col} = ?`, args: [this.world] } : { sql: "", args: [] };
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
  /**
   * Bytes held in R2, from the attachment rows rather than by listing the buckets.
   *
   * Listing to add up sizes is a Class A operation per page and grows with the
   * number of objects — paying, in requests, to measure a number we already wrote
   * down. The rows are the record; a divergence would mean a delete half-failed,
   * which is a bug to fix rather than a number to paper over.
   */
  async storageUsed(): Promise<number> {
    const row = await this.first<{ total: number | null }>(
      this.d1
        .prepare("SELECT SUM(bytes) AS total FROM attachments WHERE user_id = ?")
        .bind(this.userId),
    );
    return row?.total ?? 0;
  }

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
    const kind = normaliseKind(e.kind);
    // A to-do that is not done is "open"; the flag survives so the older views and
    // the connector's list_open_items keep meaning what they always meant.
    const isOpen = kind === "todo" ? !e.done_at : e.is_open;
    const res = await this.d1
      .prepare(
        `INSERT INTO entries
           (id, user_id, created_at, synced_at, context, body, body_raw, lat, lng, is_open, place_id, activity_id,
            kind, due_at, done_at, starts_at, ends_at, metric, value, unit, spec_key, spec_value, amount, reviewed, schedule_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        e.id,
        this.userId,
        e.created_at,
        Date.now(),
        // Normalised here, not trusted: a note stored as "home" would sit in
        // neither world and be invisible from both.
        normaliseContext(e.context),
        e.body,
        e.body,
        e.lat,
        e.lng,
        isOpen ? 1 : 0,
        e.place_id ?? null,
        e.activity_id ?? null,
        kind,
        e.due_at ?? null,
        e.done_at ?? null,
        e.starts_at ?? null,
        e.ends_at ?? null,
        e.metric ? e.metric.trim().toLowerCase() : null,
        e.value ?? null,
        e.unit ?? null,
        e.spec_key ?? null,
        e.spec_value ?? null,
        e.amount ?? null,
        e.reviewed === false ? 0 : 1,
        e.schedule_id ?? null,
      )
      .run();
    readMeta(this.meter, res.meta);
    return { created: (res.meta?.changes ?? 0) > 0 };
  }

  /** Today's captures, newest first. Rides the (user_id, created_at DESC) index. */
  async recentEntries(limit = 20): Promise<EntryRow[]> {
    const sc = this.scope();
    return this.decorate(await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT ${COLS}
             FROM entries
            WHERE user_id = ? AND deleted_at IS NULL${sc.sql}
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .bind(this.userId, ...sc.args, limit),
    ));
  }

  /**
   * One day's captures, newest first. The client sends the local day bounds rather
   * than a date string: "today" is the user's day, and the server has no business
   * guessing their timezone.
   */
  async entriesForDay(fromMs: number, toMs: number): Promise<EntryRow[]> {
    const sc = this.scope();
    return this.decorate(await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT ${COLS}
             FROM entries
            WHERE user_id = ? AND deleted_at IS NULL${sc.sql}
              AND created_at >= ? AND created_at < ?
            ORDER BY created_at DESC`,
        )
        .bind(this.userId, ...sc.args, fromMs, toMs),
    ));
  }

  /**
   * Open follow-ups, OLDEST first (§11 phase 3).
   *
   * The order is the point: the thing that has been hanging longest is the thing
   * most likely to be forgotten, so it goes at the top rather than scrolling off the
   * bottom. Rides idx_entries_open(user_id, is_open, created_at).
   */
  async openEntries(limit = 100): Promise<EntryRow[]> {
    const sc = this.scope();
    return this.decorate(await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT ${COLS}
             FROM entries
            WHERE user_id = ? AND is_open = 1 AND deleted_at IS NULL${sc.sql}
            ORDER BY created_at ASC
            LIMIT ?`,
        )
        .bind(this.userId, ...sc.args, limit),
    ));
  }

  /**
   * Substring search over the note and the original dictation.
   *
   * Deliberately a LIKE scan, not FTS: §3 rules out retrieval machinery at this size,
   * and a few thousand entries scan comfortably inside the daily row-read budget.
   * `body_raw` is searched too, so a word that an edit removed is still findable.
   */
  async searchEntries(q: string, limit = 50): Promise<EntryRow[]> {
    const sc = this.scope();
    const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    return this.decorate(await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT ${COLS}
             FROM entries
            WHERE user_id = ? AND deleted_at IS NULL${sc.sql}
              AND (body LIKE ?2 ESCAPE '\\' OR body_raw LIKE ?2 ESCAPE '\\')
            ORDER BY created_at DESC
            LIMIT ?3`,
        )
        .bind(this.userId, ...sc.args, like, limit),
    ));
  }

  /** An entry with its photos and both ends of its follow-up thread. */
  async entryDetail(id: string): Promise<EntryDetail | null> {
    const row = await this.first<
      EntryRow & {
        version: number;
        edited_at: number | null;
        resolved_by_id: string | null;
        activity_label: string | null;
      }
    >(
      this.d1
        .prepare(
          `SELECT ${ECOLS}, e.version, e.edited_at,
                  e.resolved_by AS resolved_by_id, a.label AS activity_label
             FROM entries e
             LEFT JOIN activities a ON a.id = e.activity_id AND a.user_id = e.user_id
            WHERE e.id = ? AND e.user_id = ? AND e.deleted_at IS NULL`,
        )
        .bind(id, this.userId),
    );
    if (!row) return null;

    const attachments = await this.all<AttachmentRow>(
      this.d1
        .prepare(
          `SELECT id, kind, r2_key, mime, bytes, title, created_at
             FROM attachments
            WHERE entry_id = ? AND user_id = ?
            ORDER BY created_at ASC`,
        )
        .bind(id, this.userId),
    );

    const brief = `SELECT ${COLS}
                     FROM entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL`;

    const resolved_by = row.resolved_by_id
      ? await this.first<EntryRow>(this.d1.prepare(brief).bind(row.resolved_by_id, this.userId))
      : null;

    // The other direction: did THIS entry close something out?
    const resolves = await this.first<EntryRow>(
      this.d1
        .prepare(
          `SELECT ${COLS}
             FROM entries WHERE resolved_by = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(id, this.userId),
    );

    const { resolved_by_id: _drop, ...entry } = row;
    const [dec] = await this.decorate([entry as EntryRow]);
    return { ...(dec as EntryRow), version: row.version, edited_at: row.edited_at,
      activity_label: row.activity_label, attachments, resolved_by, resolves };
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
          `UPDATE entries SET is_open = 0, resolved_by = ?, done_at = COALESCE(done_at, ?)
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(resolverId, Date.now(), id, this.userId),
    );
  }

  /** Reopen a follow-up that was closed too eagerly. */
  async reopenEntry(id: string): Promise<void> {
    await this.run(
      this.d1
        .prepare(
          `UPDATE entries SET is_open = 1, resolved_by = NULL, done_at = NULL, kind = 'todo'
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(id, this.userId),
    );
  }

  /** Does this entry belong to the current user? Guards photo attachment. */
  /**
   * Delete an entry and everything hanging off it.
   *
   * A real delete, not a `deleted_at` stamp. The point of the short window is that a
   * mis-tap or a typo can be taken back; the point of it being short is that the log
   * is not quietly rewritable history. A soft delete would satisfy neither — it
   * leaves behind exactly the rows someone clearing test data wants gone, and it
   * still counts against D1's row budget (§4).
   *
   * The cascade is written out because SQLite does not enforce foreign keys unless
   * asked, so nothing else is going to do it: another entry may close this one out,
   * and a dangling resolved_by would leave a thread pointing at a row that is gone.
   *
   * Returns the attachments so the caller can delete the objects. Rows come back
   * first because the object store is the part that cannot be rolled back.
   */
  async deleteEntry(id: string): Promise<AttachmentRow[] | null> {
    const attachments = await this.all<AttachmentRow>(
      this.d1
        .prepare(
          `SELECT id, kind, r2_key, mime, bytes, title, created_at
             FROM attachments WHERE entry_id = ? AND user_id = ?`,
        )
        .bind(id, this.userId),
    );

    const res = await this.d1.batch([
      this.d1
        .prepare("UPDATE entries SET resolved_by = NULL WHERE resolved_by = ? AND user_id = ?")
        .bind(id, this.userId),
      this.d1
        .prepare("DELETE FROM entry_subjects WHERE entry_id = ? AND user_id = ?")
        .bind(id, this.userId),
      this.d1
        .prepare("DELETE FROM entry_people WHERE entry_id = ? AND user_id = ?")
        .bind(id, this.userId),
      this.d1
        .prepare("DELETE FROM entry_tags WHERE entry_id = ? AND user_id = ?")
        .bind(id, this.userId),
      this.d1.prepare("DELETE FROM attachments WHERE entry_id = ? AND user_id = ?").bind(id, this.userId),
      this.d1.prepare("DELETE FROM entries WHERE id = ? AND user_id = ?").bind(id, this.userId),
    ]);
    res.forEach((r) => readMeta(this.meter, r.meta));

    // The last statement is the entry itself; no rows changed means it was not ours.
    const gone = (res[res.length - 1]?.meta?.changes ?? 0) > 0;
    return gone ? attachments : null;
  }

  /**
   * Delete a thing. Its notes survive — they are the log, and they happened whether
   * or not the thing is still being tracked. Only the link between them goes.
   */
  async deleteSubject(id: string): Promise<AttachmentRow[] | null> {
    const attachments = await this.all<AttachmentRow>(
      this.d1
        .prepare(
          `SELECT id, kind, r2_key, mime, bytes, title, created_at
             FROM attachments WHERE subject_id = ? AND user_id = ?`,
        )
        .bind(id, this.userId),
    );

    // Deleting the yard must not delete the sprinkler. Children are promoted into
    // whatever this thing was inside — its parent, or its place if it was a root —
    // so the branch stays in the tree instead of disappearing with it. A cascade
    // here would be a delete of unknown size behind a confirm that named one thing.
    const home = await this.first<{ parent_id: string | null; place_id: string | null }>(
      this.d1.prepare("SELECT parent_id, place_id FROM subjects WHERE id = ? AND user_id = ?")
        .bind(id, this.userId),
    );

    const res = await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE subjects SET parent_id = ?, place_id = ?
            WHERE parent_id = ? AND user_id = ?`,
        )
        .bind(home?.parent_id ?? null, home?.parent_id ? null : home?.place_id ?? null,
              id, this.userId),
      this.d1
        .prepare("UPDATE subjects SET hero_photo_id = NULL WHERE id = ? AND user_id = ?")
        .bind(id, this.userId),
      this.d1
        .prepare("DELETE FROM subject_attributes WHERE subject_id = ? AND user_id = ?")
        .bind(id, this.userId),
      this.d1
        .prepare("DELETE FROM entry_subjects WHERE subject_id = ? AND user_id = ?")
        .bind(id, this.userId),
      this.d1
        .prepare("DELETE FROM subject_tags WHERE subject_id = ? AND user_id = ?")
        .bind(id, this.userId),
      this.d1
        .prepare("DELETE FROM schedules WHERE subject_id = ? AND user_id = ?")
        .bind(id, this.userId),
      this.d1.prepare("DELETE FROM attachments WHERE subject_id = ? AND user_id = ?").bind(id, this.userId),
      this.d1.prepare("DELETE FROM subjects WHERE id = ? AND user_id = ?").bind(id, this.userId),
    ]);
    res.forEach((r) => readMeta(this.meter, r.meta));

    const gone = (res[res.length - 1]?.meta?.changes ?? 0) > 0;
    return gone ? attachments : null;
  }

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
             (id, user_id, entry_id, subject_id, kind, r2_key, mime, bytes, title, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          this.userId,
          a.entry_id ?? null,
          a.subject_id ?? null,
          a.kind,
          a.r2_key,
          a.mime,
          a.bytes,
          a.title ?? null,
          Date.now(),
        ),
    );
    return id;
  }

  /**
   * One attachment, for serving it.
   *
   * Scoped to the user like everything else, which is the whole point: a document
   * in the private bucket is reachable only through this lookup, so the ownership
   * check is not a nicety here, it is the access control.
   */
  async attachment(id: string): Promise<AttachmentRow | null> {
    return this.first<AttachmentRow>(
      this.d1
        .prepare(
          `SELECT id, kind, r2_key, mime, bytes, title, created_at
             FROM attachments WHERE id = ? AND user_id = ?`,
        )
        .bind(id, this.userId),
    );
  }

  /** Detach and forget. The caller deletes the object; this drops the record. */
  async removeAttachment(id: string): Promise<AttachmentRow | null> {
    const row = await this.attachment(id);
    if (!row) return null;
    await this.run(
      this.d1
        .prepare("DELETE FROM attachments WHERE id = ? AND user_id = ?")
        .bind(id, this.userId),
    );
    return row;
  }

  async ownsSubject(subjectId: string): Promise<boolean> {
    const row = await this.first<{ n: number }>(
      this.d1
        .prepare("SELECT 1 AS n FROM subjects WHERE id = ? AND user_id = ?")
        .bind(subjectId, this.userId),
    );
    return row !== null;
  }

  // ------------------------------------------------------------------- places
  // §4: raw coordinates are stored on every entry regardless. Places are a
  // convenience laid over them — matched by proximity, suggested, never forced.

  async listPlaces(): Promise<PlaceRow[]> {
    const sc = this.scope("p.context");
    return this.all<PlaceRow>(
      this.d1
        .prepare(
          `SELECT p.id, p.name, p.lat, p.lng, p.radius_m, p.context,
                  (SELECT COUNT(*) FROM subjects s
                    WHERE s.place_id = p.id AND s.user_id = p.user_id
                      AND s.archived_at IS NULL) AS things
             FROM places p
            WHERE p.user_id = ?${sc.sql}
            ORDER BY p.name COLLATE NOCASE`,
        )
        .bind(this.userId, ...sc.args),
    );
  }

  async createPlace(name: string, lat: number, lng: number, radiusM = 150, context = "work"): Promise<string> {
    const id = newId();
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO places (id, user_id, name, lat, lng, radius_m, created_at, context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, this.userId, name, lat, lng, radiusM, Date.now(), normaliseContext(context)),
    );
    return id;
  }

  /**
   * Move a note to the other world. Its links go with the move — an item or a
   * person belongs to one world, so every link it had was to something on the
   * side it is leaving — and so does the place, for the same reason.
   */
  async moveEntry(id: string, context: string): Promise<boolean> {
    const world = normaliseContext(context);
    const res = await this.d1.batch([
      this.d1.prepare("DELETE FROM entry_subjects WHERE entry_id = ? AND user_id = ?").bind(id, this.userId),
      this.d1.prepare("DELETE FROM entry_people WHERE entry_id = ? AND user_id = ?").bind(id, this.userId),
      this.d1
        .prepare(`UPDATE entries SET context = ?, place_id = NULL, edited_at = ?
                   WHERE id = ? AND user_id = ? AND context <> ?`)
        .bind(world, Date.now(), id, this.userId, world),
    ]);
    res.forEach((r) => readMeta(this.meter, r.meta));
    return (res[res.length - 1]?.meta?.changes ?? 0) > 0;
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
  /**
   * Forget a place. Entries keep their coordinates and simply stop naming it —
   * the capture happened where it happened, whatever the spot was being called.
   */
  async deletePlace(id: string): Promise<boolean> {
    const res = await this.d1.batch([
      this.d1
        .prepare("UPDATE entries SET place_id = NULL WHERE user_id = ? AND place_id = ?")
        .bind(this.userId, id),
      // Things rooted here become top-level rather than vanishing with the place —
      // same reasoning as the entries above. The mower still exists; the yard it
      // was in just stopped having a name.
      this.d1
        .prepare("UPDATE subjects SET place_id = NULL WHERE user_id = ? AND place_id = ?")
        .bind(this.userId, id),
      this.d1
        .prepare("DELETE FROM person_places WHERE user_id = ? AND place_id = ?")
        .bind(this.userId, id),
      this.d1.prepare("DELETE FROM places WHERE id = ? AND user_id = ?").bind(id, this.userId),
    ]);
    res.forEach((r) => readMeta(this.meter, r.meta));
    // The DELETE is last; index it from the end so adding another cleanup above it
    // cannot silently start reporting the wrong statement's row count.
    return (res[res.length - 1]?.meta?.changes ?? 0) > 0;
  }

  /**
   * Correct a place in situ — its name, its pin, or how close counts as being there.
   *
   * Editing rather than renaming only, because the alternative was
   * delete-and-recreate, and `deletePlace` unfiles every thing rooted here and
   * strips `place_id` off every entry that referenced it. Fixing a pin dropped on
   * the wrong building should not cost the history that made the pin worth fixing.
   *
   * Moving a place deliberately does **not** re-run `claimEntriesForPlace`. Naming a
   * spot explains the captures already made there; nudging the pin afterwards is a
   * correction, not a new claim on whatever happens to be near the new coordinates.
   * Entries keep their own lat/lng regardless, so nothing is lost either way.
   */
  async updatePlace(id: string, patch: PlacePatch): Promise<boolean> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); vals.push(patch.name.trim()); }
    if (patch.lat !== undefined) { sets.push("lat = ?"); vals.push(patch.lat); }
    if (patch.lng !== undefined) { sets.push("lng = ?"); vals.push(patch.lng); }
    if (patch.radius_m !== undefined) { sets.push("radius_m = ?"); vals.push(patch.radius_m); }
    if (!sets.length) return false;
    const res = await this.d1
      .prepare(`UPDATE places SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...vals, id, this.userId)
      .run();
    readMeta(this.meter, res.meta);
    // A no-op edit — saving a place without changing anything — reports zero changed
    // rows in SQLite, which is not the same as "no such place". Ask separately rather
    // than telling the caller their place has vanished.
    if ((res.meta?.changes ?? 0) > 0) return true;
    const row = await this.first<{ id: string }>(
      this.d1.prepare("SELECT id FROM places WHERE id = ? AND user_id = ?").bind(id, this.userId),
    );
    return row !== null;
  }

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
    const sc = this.scope("s.context");
    return this.all<SubjectRow>(
      this.d1
        .prepare(
          `SELECT s.id, s.name, s.type, s.context, s.visibility, s.hero_photo_id,
                  s.created_at, s.archived_at, s.parent_id, s.place_id,
                  a.r2_key AS hero_key
             FROM subjects s
             LEFT JOIN attachments a ON a.id = s.hero_photo_id AND a.user_id = s.user_id
            WHERE s.user_id = ?${sc.sql}` +
            (includeArchived ? "" : " AND s.archived_at IS NULL") +
            ` ORDER BY s.name COLLATE NOCASE`,
        )
        .bind(this.userId, ...sc.args),
    );
  }

  /** Returns the normalised row, not just its id: what was asked for and what was
   *  stored can differ, and a caller that reports the request back is reporting a
   *  value the database does not hold. */
  async createSubject(sub: NewSubject): Promise<{ id: string; type: string; context: string }> {
    const id = newId();
    const context = normaliseContext(sub.context);
    const type = normaliseType(sub.type);
    // A brand new row has no descendants, so there is no cycle to guard against —
    // but the same "only one home" rule applies, and the parent still has to exist
    // and still has to be yours.
    const home = await this.resolveHome(id, {
      parent_id: sub.parent_id ?? null,
      place_id: sub.place_id ?? null,
    });
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO subjects
             (id, user_id, name, type, context, visibility, created_at, parent_id, place_id)
           VALUES (?, ?, ?, ?, ?, 'private', ?, ?, ?)`,
        )
        .bind(id, this.userId, sub.name.trim(), type, context, Date.now(),
              home.parent_id, home.place_id),
    );
    return { id, type, context };
  }

  // ------------------------------------------------------- where a thing lives
  //
  // Home → Yard → Front sprinkler. Places are the roots (§4 already says where
  // things happen), subjects nest under a place and under each other.
  //
  // The tree is read by fetching every subject once and assembling it on the
  // client, so nothing here needs a recursive query: at this scale a hundred rows
  // is one cheap read, and a recursive CTE would be a second way to be wrong about
  // the same shape.

  /**
   * Decide what to store for "where does this live", and refuse the impossible.
   *
   * Exactly one of the two is kept. A subject with a parent inherits the parent's
   * place, so writing both would create a second copy of the same fact — and the
   * copy is the one that goes stale the first time a branch is moved.
   */
  private async resolveHome(id: string, home: Home): Promise<{ parent_id: string | null; place_id: string | null }> {
    const parent = home.parent_id ?? null;
    if (parent) {
      if (parent === id) throw new BadParent("A thing cannot be inside itself.");
      const ok = await this.first<{ n: number }>(
        this.d1.prepare("SELECT 1 AS n FROM subjects WHERE id = ? AND user_id = ?")
          .bind(parent, this.userId),
      );
      if (!ok) throw new BadParent("No such thing to put it in.");
      // Walking up from the proposed parent is the whole cycle check: if this row
      // is already above it, the move would close a loop and the tree screen would
      // recurse forever. Cheap because the chain is a handful of rows deep.
      const chain = await this.ancestorIds(parent);
      if (chain.includes(id)) throw new BadParent("That would put a thing inside itself.");
      return { parent_id: parent, place_id: null };
    }
    const place = home.place_id ?? null;
    if (place) {
      const ok = await this.first<{ n: number }>(
        this.d1.prepare("SELECT 1 AS n FROM places WHERE id = ? AND user_id = ?")
          .bind(place, this.userId),
      );
      if (!ok) throw new BadParent("No such place.");
    }
    return { parent_id: null, place_id: place };
  }

  /** Ids from `id` up to the root, `id` first. Bounded so a loop cannot hang a request. */
  private async ancestorIds(id: string): Promise<string[]> {
    const seen: string[] = [];
    let at: string | null = id;
    for (let i = 0; at && i < 32; i++) {
      if (seen.includes(at)) break;
      seen.push(at);
      const row: { parent_id: string | null } | null = await this.first<{ parent_id: string | null }>(
        this.d1.prepare("SELECT parent_id FROM subjects WHERE id = ? AND user_id = ?")
          .bind(at, this.userId),
      );
      at = row?.parent_id ?? null;
    }
    return seen;
  }

  /** Move a thing: under another thing, into a place, or out to the top level. */
  async setHome(id: string, home: Home): Promise<void> {
    const resolved = await this.resolveHome(id, home);
    await this.run(
      this.d1
        .prepare("UPDATE subjects SET parent_id = ?, place_id = ? WHERE id = ? AND user_id = ?")
        .bind(resolved.parent_id, resolved.place_id, id, this.userId),
    );
  }

  /** The path down to a thing, root first, excluding itself. */
  async subjectPath(id: string): Promise<Crumb[]> {
    const chain = await this.ancestorIds(id);
    const above = chain.slice(1);           // skip the thing itself
    const crumbs: Crumb[] = [];
    for (const aid of above) {
      const row = await this.first<{ name: string }>(
        this.d1.prepare("SELECT name FROM subjects WHERE id = ? AND user_id = ?")
          .bind(aid, this.userId),
      );
      if (row) crumbs.push({ id: aid, name: row.name, kind: "subject" });
    }
    // The root's place, if it has one, is the first crumb of all.
    const rootId = chain[chain.length - 1];
    if (rootId) {
      const root = await this.first<{ place_id: string | null }>(
        this.d1.prepare("SELECT place_id FROM subjects WHERE id = ? AND user_id = ?")
          .bind(rootId, this.userId),
      );
      if (root?.place_id) {
        const place = await this.first<{ name: string }>(
          this.d1.prepare("SELECT name FROM places WHERE id = ? AND user_id = ?")
            .bind(root.place_id, this.userId),
        );
        if (place) crumbs.push({ id: root.place_id, name: place.name, kind: "place" });
      }
    }
    return crumbs.reverse();
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
          `SELECT id, name, type, context, visibility, hero_photo_id, created_at,
                  archived_at, parent_id, place_id
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
          `SELECT ${ECOLS}
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
          `SELECT id, kind, r2_key, mime, bytes, title, created_at
             FROM attachments WHERE subject_id = ? AND user_id = ?
            ORDER BY created_at DESC`,
        )
        .bind(id, this.userId),
    );

    // Where it sits in the tree. Both are on the detail page because standing in
    // front of a thing, "which yard is this sprinkler in" and "what is on this
    // manifold" are the two questions the page cannot answer from its own row.
    const path = await this.subjectPath(id);
    const children = await this.all<SubjectRow>(
      this.d1
        .prepare(
          `SELECT id, name, type, context, visibility, hero_photo_id, created_at,
                  archived_at, parent_id, place_id
             FROM subjects
            WHERE parent_id = ? AND user_id = ? AND archived_at IS NULL
            ORDER BY name COLLATE NOCASE`,
        )
        .bind(id, this.userId),
    );

    const [tags, schedules, metrics] = await Promise.all([
      this.subjectTags(id), this.listSchedules(id), this.metricsOf(id),
    ]);
    return { ...row, attributes, entries: await this.decorate(entries), attachments, path, children,
      tags, schedules, metrics };
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
                  s.created_at, s.archived_at, s.parent_id, s.place_id
             FROM subjects s
             JOIN entry_subjects es ON es.subject_id = s.id
            WHERE es.entry_id = ? AND s.user_id = ?
            ORDER BY s.name COLLATE NOCASE`,
        )
        .bind(entryId, this.userId),
    );
  }

  // --------------------------------------------------------------- v2: kinds

  /**
   * Attach tag names and linked things to a list of entries.
   *
   * Two IN queries rather than a join per row. The list views show "which thing"
   * and "which tags" on every row, and fetching those per entry would be the
   * N+1 that eats the daily row budget.
   */
  async decorate(rows: EntryRow[]): Promise<EntryRow[]> {
    if (!rows.length) return rows;
    const tags = new Map<string, string[]>();
    const subs = new Map<string, { id: string; name: string }[]>();
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const marks = part.map(() => "?").join(",");
      const t = await this.all<{ entry_id: string; name: string }>(
        this.d1
          .prepare(
            `SELECT et.entry_id, t.name FROM entry_tags et
               JOIN tags t ON t.id = et.tag_id
              WHERE et.user_id = ? AND et.entry_id IN (${marks})
              ORDER BY t.name`,
          )
          .bind(this.userId, ...part),
      );
      t.forEach((r) => tags.set(r.entry_id, [...(tags.get(r.entry_id) || []), r.name]));
      const x = await this.all<{ entry_id: string; id: string; name: string }>(
        this.d1
          .prepare(
            `SELECT es.entry_id, s.id, s.name FROM entry_subjects es
               JOIN subjects s ON s.id = es.subject_id
              WHERE es.user_id = ? AND es.entry_id IN (${marks})
              ORDER BY s.name COLLATE NOCASE`,
          )
          .bind(this.userId, ...part),
      );
      x.forEach((r) => subs.set(r.entry_id, [...(subs.get(r.entry_id) || []), { id: r.id, name: r.name }]));
    }
    return rows.map((r) => ({ ...r, tags: tags.get(r.id) || [], subjects: subs.get(r.id) || [] }));
  }

  /**
   * The one query behind the table, the tag view, the stream filter and search.
   *
   * Built from the filter rather than one method per door, so every door answers
   * from the same rows and a saved view is just a filter written down.
   */
  async queryEntries(f: EntryFilter): Promise<EntryRow[]> {
    const sc = this.scope("e.context");
    const joins: string[] = [];
    const where: string[] = ["e.user_id = ?", "e.deleted_at IS NULL"];
    const args: unknown[] = [this.userId];
    if (sc.sql) { where.push("e.context = ?"); args.push(...sc.args); }
    // Join binds sit in the SQL before the WHERE binds, so they are kept apart.
    const joinArgs: unknown[] = [];
    if (f.subject_id) {
      joins.push("JOIN entry_subjects es ON es.entry_id = e.id AND es.subject_id = ?");
      joinArgs.push(f.subject_id);
    }
    (f.tags || []).forEach((name, i) => {
      joins.push(
        `JOIN entry_tags et${i} ON et${i}.entry_id = e.id
           AND et${i}.tag_id = (SELECT id FROM tags WHERE user_id = e.user_id AND name = ?)`,
      );
      joinArgs.push(name.toLowerCase().replace(/^#/, ""));
    });
    const kind = f.kind ? normaliseKind(f.kind) : null;
    if (kind) { where.push("e.kind = ?"); args.push(kind); }
    if (f.open) where.push("e.kind = 'todo' AND e.done_at IS NULL");
    if (f.reviewed === false) where.push("e.reviewed = 0");
    if (f.reviewed === true) where.push("e.reviewed = 1");
    if (f.metric) { where.push("e.metric = ?"); args.push(f.metric.toLowerCase()); }
    if (f.from != null) { where.push("e.created_at >= ?"); args.push(f.from); }
    if (f.to != null) { where.push("e.created_at < ?"); args.push(f.to); }
    if (f.q && f.q.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, (c) => "\\" + c)}%`;
      where.push("(e.body LIKE ? ESCAPE '\\' OR e.body_raw LIKE ? ESCAPE '\\' OR e.spec_key LIKE ? ESCAPE '\\' OR e.spec_value LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }
    const order = {
      created: "e.created_at DESC",
      due: "COALESCE(e.due_at, e.starts_at) IS NULL, COALESCE(e.due_at, e.starts_at) ASC, e.created_at DESC",
      kind: "e.kind, e.created_at DESC",
      value: "e.value DESC, e.created_at DESC",
    }[f.sort || "created"];
    const limit = Math.min(Math.max(1, f.limit || 200), 500);
    const rows = await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT ${ECOLS} FROM entries e ${joins.join(" ")}
            WHERE ${where.join(" AND ")}
            ORDER BY ${order}
            LIMIT ?`,
        )
        .bind(...joinArgs, ...args, limit),
    );
    return this.decorate(rows);
  }

  /**
   * What is due: open to-dos by due date (undated last), and appointments from
   * yesterday on. Schedules are computed separately — they are rules, not rows.
   */
  async dueEntries(sinceMs: number, limit = 200): Promise<EntryRow[]> {
    const sc = this.scope();
    return this.decorate(await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT ${COLS} FROM entries
            WHERE user_id = ? AND deleted_at IS NULL${sc.sql}
              AND ((kind = 'todo' AND done_at IS NULL) OR (kind = 'appt' AND starts_at >= ?))
            ORDER BY COALESCE(due_at, starts_at) IS NULL, COALESCE(due_at, starts_at) ASC, created_at ASC
            LIMIT ?`,
        )
        .bind(this.userId, ...sc.args, sinceMs, limit),
    ));
  }

  /** Recently finished to-dos, for the bottom of the Due tab. */
  async doneEntries(limit = 30): Promise<EntryRow[]> {
    const sc = this.scope();
    return this.decorate(await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT ${COLS} FROM entries
            WHERE user_id = ? AND deleted_at IS NULL${sc.sql} AND kind = 'todo' AND done_at IS NOT NULL
            ORDER BY done_at DESC LIMIT ?`,
        )
        .bind(this.userId, ...sc.args, limit),
    ));
  }

  /** Captures waiting to be filed. */
  async inboxEntries(limit = 100): Promise<EntryRow[]> {
    const sc = this.scope();
    return this.decorate(await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT ${COLS} FROM entries
            WHERE user_id = ? AND deleted_at IS NULL${sc.sql} AND reviewed = 0
            ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(this.userId, ...sc.args, limit),
    ));
  }

  async inboxCount(): Promise<number> {
    const sc = this.scope();
    const row = await this.first<{ n: number }>(
      this.d1
        .prepare(`SELECT COUNT(*) AS n FROM entries WHERE user_id = ? AND deleted_at IS NULL${sc.sql} AND reviewed = 0`)
        .bind(this.userId, ...sc.args),
    );
    return row?.n ?? 0;
  }

  /**
   * Edit the v2 fields on an entry. The note text goes through `editEntry`, which
   * carries the version check; these fields do not conflict in practice and a
   * version bump for ticking a box would make the edit screen refuse the tick.
   */
  async patchEntry(id: string, patch: EntryPatch): Promise<boolean> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    if (patch.kind !== undefined) put("kind", normaliseKind(patch.kind));
    for (const k of ["due_at", "done_at", "starts_at", "ends_at", "value", "amount", "created_at", "place_id"] as const) {
      if (patch[k] !== undefined) put(k, patch[k]);
    }
    for (const k of ["unit", "spec_key", "spec_value"] as const) {
      if (patch[k] !== undefined) put(k, patch[k] ? String(patch[k]).trim() : null);
    }
    if (patch.metric !== undefined) put("metric", patch.metric ? patch.metric.trim().toLowerCase() : null);
    if (patch.reviewed !== undefined) put("reviewed", patch.reviewed ? 1 : 0);
    if (!sets.length) return true;
    put("edited_at", Date.now());
    const res = await this.d1
      .prepare(`UPDATE entries SET ${sets.join(", ")} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
      .bind(...vals, id, this.userId)
      .run();
    readMeta(this.meter, res.meta);
    // is_open follows the kind and done_at, always — never edited on its own.
    await this.run(
      this.d1
        .prepare(
          `UPDATE entries SET is_open = CASE WHEN kind = 'todo' AND done_at IS NULL THEN 1 ELSE 0 END
            WHERE id = ? AND user_id = ?`,
        )
        .bind(id, this.userId),
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  /** Replace which things an entry is about. The edit sheet owns the whole set. */
  async setEntrySubjects(entryId: string, subjectIds: string[]): Promise<void> {
    await this.run(
      this.d1.prepare("DELETE FROM entry_subjects WHERE entry_id = ? AND user_id = ?").bind(entryId, this.userId),
    );
    await this.linkEntrySubjects(entryId, subjectIds);
  }

  // ------------------------------------------------------------------- tags

  private cleanTag(name: string): string {
    return name.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-").slice(0, 40);
  }

  /** Ids for tag names, creating the ones that do not exist yet. */
  async ensureTags(names: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const clean = [...new Set(names.map((n) => this.cleanTag(n)).filter(Boolean))];
    for (const name of clean) {
      const have = await this.first<{ id: string }>(
        this.d1.prepare("SELECT id FROM tags WHERE user_id = ? AND name = ?").bind(this.userId, name),
      );
      if (have) { out.set(name, have.id); continue; }
      const id = newId();
      await this.run(
        this.d1
          .prepare("INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, this.userId, name, Date.now()),
      );
      out.set(name, id);
    }
    return out;
  }

  /** Every tag with how many entries in this world carry it. */
  async listTags(): Promise<TagRow[]> {
    const sc = this.scope("e.context");
    return this.all<TagRow>(
      this.d1
        .prepare(
          `SELECT t.id, t.name,
                  (SELECT COUNT(*) FROM entry_tags et JOIN entries e ON e.id = et.entry_id
                    WHERE et.tag_id = t.id AND e.deleted_at IS NULL${sc.sql}) AS count
             FROM tags t WHERE t.user_id = ?
            ORDER BY count DESC, t.name`,
        )
        .bind(...sc.args, this.userId),
    );
  }

  /** Set an entry's tags to exactly this list. */
  async setEntryTags(entryId: string, names: string[], suggested = false): Promise<void> {
    const ids = await this.ensureTags(names);
    const stmts: D1PreparedStatement[] = [
      this.d1.prepare("DELETE FROM entry_tags WHERE entry_id = ? AND user_id = ?").bind(entryId, this.userId),
    ];
    ids.forEach((tagId) =>
      stmts.push(
        this.d1
          .prepare("INSERT INTO entry_tags (entry_id, tag_id, user_id, suggested) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .bind(entryId, tagId, this.userId, suggested ? 1 : 0),
      ),
    );
    const res = await this.d1.batch(stmts);
    res.forEach((r) => readMeta(this.meter, r.meta));
  }

  /** Add tags without touching the ones already there. */
  async addEntryTags(entryId: string, names: string[]): Promise<void> {
    const ids = await this.ensureTags(names);
    if (!ids.size) return;
    const stmts = [...ids.values()].map((tagId) =>
      this.d1
        .prepare("INSERT INTO entry_tags (entry_id, tag_id, user_id, suggested) VALUES (?, ?, ?, 0) ON CONFLICT DO NOTHING")
        .bind(entryId, tagId, this.userId),
    );
    const res = await this.d1.batch(stmts);
    res.forEach((r) => readMeta(this.meter, r.meta));
  }

  async setSubjectTags(subjectId: string, names: string[]): Promise<void> {
    const ids = await this.ensureTags(names);
    const stmts: D1PreparedStatement[] = [
      this.d1.prepare("DELETE FROM subject_tags WHERE subject_id = ? AND user_id = ?").bind(subjectId, this.userId),
    ];
    ids.forEach((tagId) =>
      stmts.push(
        this.d1
          .prepare("INSERT INTO subject_tags (subject_id, tag_id, user_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
          .bind(subjectId, tagId, this.userId),
      ),
    );
    const res = await this.d1.batch(stmts);
    res.forEach((r) => readMeta(this.meter, r.meta));
  }

  async subjectTags(subjectId: string): Promise<string[]> {
    const rows = await this.all<{ name: string }>(
      this.d1
        .prepare(
          `SELECT t.name FROM subject_tags st JOIN tags t ON t.id = st.tag_id
            WHERE st.subject_id = ? AND st.user_id = ? ORDER BY t.name`,
        )
        .bind(subjectId, this.userId),
    );
    return rows.map((r) => r.name);
  }

  /** Rename a tag. Renaming onto an existing name merges into it. */
  async renameTag(id: string, newName: string): Promise<boolean> {
    const name = this.cleanTag(newName);
    if (!name) return false;
    const clash = await this.first<{ id: string }>(
      this.d1.prepare("SELECT id FROM tags WHERE user_id = ? AND name = ? AND id != ?").bind(this.userId, name, id),
    );
    if (clash) {
      const res = await this.d1.batch([
        this.d1.prepare("INSERT OR IGNORE INTO entry_tags (entry_id, tag_id, user_id, suggested) SELECT entry_id, ?, user_id, suggested FROM entry_tags WHERE tag_id = ? AND user_id = ?").bind(clash.id, id, this.userId),
        this.d1.prepare("INSERT OR IGNORE INTO subject_tags (subject_id, tag_id, user_id) SELECT subject_id, ?, user_id FROM subject_tags WHERE tag_id = ? AND user_id = ?").bind(clash.id, id, this.userId),
        this.d1.prepare("DELETE FROM entry_tags WHERE tag_id = ? AND user_id = ?").bind(id, this.userId),
        this.d1.prepare("DELETE FROM subject_tags WHERE tag_id = ? AND user_id = ?").bind(id, this.userId),
        this.d1.prepare("DELETE FROM tags WHERE id = ? AND user_id = ?").bind(id, this.userId),
      ]);
      res.forEach((r) => readMeta(this.meter, r.meta));
      return true;
    }
    const res = await this.d1.prepare("UPDATE tags SET name = ? WHERE id = ? AND user_id = ?").bind(name, id, this.userId).run();
    readMeta(this.meter, res.meta);
    return (res.meta?.changes ?? 0) > 0;
  }

  async deleteTag(id: string): Promise<boolean> {
    const res = await this.d1.batch([
      this.d1.prepare("DELETE FROM entry_tags WHERE tag_id = ? AND user_id = ?").bind(id, this.userId),
      this.d1.prepare("DELETE FROM subject_tags WHERE tag_id = ? AND user_id = ?").bind(id, this.userId),
      this.d1.prepare("DELETE FROM tags WHERE id = ? AND user_id = ?").bind(id, this.userId),
    ]);
    res.forEach((r) => readMeta(this.meter, r.meta));
    return (res[res.length - 1]?.meta?.changes ?? 0) > 0;
  }

  // ------------------------------------------------------------------ specs

  /** Write or overwrite one attribute on a thing: what a spec capture does. */
  async setAttribute(subjectId: string, key: string, value: string | null): Promise<void> {
    const k = key.trim();
    if (!k) return;
    // Match an existing key case-insensitively so "tire size" updates "Tire size"
    // rather than sitting beside it.
    const have = await this.first<{ key: string }>(
      this.d1
        .prepare("SELECT key FROM subject_attributes WHERE subject_id = ? AND user_id = ? AND key = ? COLLATE NOCASE")
        .bind(subjectId, this.userId, k),
    );
    if (have) {
      await this.run(
        this.d1
          .prepare("UPDATE subject_attributes SET value = ? WHERE subject_id = ? AND user_id = ? AND key = ?")
          .bind(value, subjectId, this.userId, have.key),
      );
      return;
    }
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO subject_attributes (subject_id, user_id, key, value, sort_order)
           VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM subject_attributes WHERE subject_id = ?))`,
        )
        .bind(subjectId, this.userId, k, value, subjectId),
    );
  }

  // ----------------------------------------------------------------- values

  /** Readings on a thing, grouped by metric, newest first — for the thing page. */
  async metricsOf(subjectId: string, perMetric = 24): Promise<MetricSeries[]> {
    const rows = await this.all<{ metric: string; value: number; unit: string | null; created_at: number }>(
      this.d1
        .prepare(
          `SELECT e.metric, e.value, e.unit, e.created_at FROM entries e
             JOIN entry_subjects es ON es.entry_id = e.id AND es.subject_id = ?
            WHERE e.user_id = ? AND e.deleted_at IS NULL AND e.kind = 'value' AND e.metric IS NOT NULL AND e.value IS NOT NULL
            ORDER BY e.created_at DESC LIMIT 400`,
        )
        .bind(subjectId, this.userId),
    );
    const by = new Map<string, MetricSeries>();
    for (const r of rows) {
      let m = by.get(r.metric);
      if (!m) {
        m = { metric: r.metric, unit: r.unit, latest: { value: r.value, at: r.created_at }, points: [] };
        by.set(r.metric, m);
      }
      if (m.points.length < perMetric) m.points.push({ value: r.value, at: r.created_at });
      if (!m.unit && r.unit) m.unit = r.unit;
    }
    return [...by.values()];
  }

  /** Earliest and latest reading of one metric on a thing — what a schedule needs. */
  async metricStats(subjectId: string, metric: string): Promise<{ latest: { value: number; at: number } | null; earliest: { value: number; at: number } | null }> {
    const one = (dir: "ASC" | "DESC") =>
      this.first<{ value: number; created_at: number }>(
        this.d1
          .prepare(
            `SELECT e.value, e.created_at FROM entries e
               JOIN entry_subjects es ON es.entry_id = e.id AND es.subject_id = ?
              WHERE e.user_id = ? AND e.deleted_at IS NULL AND e.kind = 'value' AND e.metric = ? AND e.value IS NOT NULL
              ORDER BY e.created_at ${dir} LIMIT 1`,
          )
          .bind(subjectId, this.userId, metric.toLowerCase()),
      );
    const [l, f] = await Promise.all([one("DESC"), one("ASC")]);
    return {
      latest: l ? { value: l.value, at: l.created_at } : null,
      earliest: f ? { value: f.value, at: f.created_at } : null,
    };
  }

  // -------------------------------------------------------------- schedules

  private readonly SCHED_COLS =
    "s.id, s.subject_id, s.context, s.label, s.every_days, s.every_value, s.metric, s.fixed_month, s.fixed_day, s.last_done_at, s.last_value, s.created_at, s.archived_at, j.name AS subject_name";

  async listSchedules(subjectId: string | null = null, includeArchived = false): Promise<ScheduleRow[]> {
    const sc = this.scope("s.context");
    return this.all<ScheduleRow>(
      this.d1
        .prepare(
          `SELECT ${this.SCHED_COLS} FROM schedules s
             LEFT JOIN subjects j ON j.id = s.subject_id AND j.user_id = s.user_id
            WHERE s.user_id = ?${sc.sql}` +
            (subjectId ? " AND s.subject_id = ?" : "") +
            (includeArchived ? "" : " AND s.archived_at IS NULL") +
            " ORDER BY s.label COLLATE NOCASE",
        )
        .bind(this.userId, ...sc.args, ...(subjectId ? [subjectId] : [])),
    );
  }

  async schedule(id: string): Promise<ScheduleRow | null> {
    return this.first<ScheduleRow>(
      this.d1
        .prepare(
          `SELECT ${this.SCHED_COLS} FROM schedules s
             LEFT JOIN subjects j ON j.id = s.subject_id AND j.user_id = s.user_id
            WHERE s.id = ? AND s.user_id = ?`,
        )
        .bind(id, this.userId),
    );
  }

  async createSchedule(s: Omit<ScheduleRow, "id" | "created_at" | "archived_at" | "subject_name">): Promise<string> {
    const id = newId();
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO schedules
             (id, user_id, subject_id, context, label, every_days, every_value, metric, fixed_month, fixed_day, last_done_at, last_value, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, this.userId, s.subject_id, normaliseContext(s.context), s.label.trim(),
              s.every_days ?? null, s.every_value ?? null, s.metric ? s.metric.trim().toLowerCase() : null,
              s.fixed_month ?? null, s.fixed_day ?? null, s.last_done_at ?? null, s.last_value ?? null, Date.now()),
    );
    return id;
  }

  async updateSchedule(id: string, patch: Partial<Omit<ScheduleRow, "id" | "created_at" | "subject_name">>): Promise<boolean> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(k === "metric" && typeof v === "string" ? v.trim().toLowerCase() : v);
    }
    if (!sets.length) return true;
    const res = await this.d1
      .prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...vals, id, this.userId)
      .run();
    readMeta(this.meter, res.meta);
    return (res.meta?.changes ?? 0) > 0;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const res = await this.d1.batch([
      this.d1.prepare("UPDATE entries SET schedule_id = NULL WHERE schedule_id = ? AND user_id = ?").bind(id, this.userId),
      this.d1.prepare("DELETE FROM schedules WHERE id = ? AND user_id = ?").bind(id, this.userId),
    ]);
    res.forEach((r) => readMeta(this.meter, r.meta));
    return (res[res.length - 1]?.meta?.changes ?? 0) > 0;
  }

  // ------------------------------------------------------------ saved views

  async listViews(): Promise<SavedView[]> {
    const sc = this.scope();
    return this.all<SavedView>(
      this.d1
        .prepare(`SELECT id, name, context, query, sort_order FROM saved_views WHERE user_id = ?${sc.sql} ORDER BY sort_order, name`)
        .bind(this.userId, ...sc.args),
    );
  }

  async createView(name: string, context: string, query: string): Promise<string> {
    const id = newId();
    await this.run(
      this.d1
        .prepare("INSERT INTO saved_views (id, user_id, context, name, query, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
        .bind(id, this.userId, normaliseContext(context), name.trim(), query, Date.now()),
    );
    return id;
  }

  async deleteView(id: string): Promise<boolean> {
    const res = await this.d1.prepare("DELETE FROM saved_views WHERE id = ? AND user_id = ?").bind(id, this.userId).run();
    readMeta(this.meter, res.meta);
    return (res.meta?.changes ?? 0) > 0;
  }

  // ----------------------------------------------------------------- people
  // Who was involved. Their own table rather than a subject type: the tree files a
  // subject in exactly one place, and a person covers several. The links are the
  // same shape as entry_subjects, so a note can name a site, a machine and the
  // operator who reported it.

  private readonly PERSON_COLS =
    "id, name, role, company, phone, email, notes, context, created_at, archived_at";

  private async placesOfPeople(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!ids.length) return out;
    const rows = await this.all<{ person_id: string; place_id: string }>(
      this.d1
        .prepare(
          `SELECT person_id, place_id FROM person_places
            WHERE user_id = ? AND person_id IN (${ids.map(() => "?").join(",")})`,
        )
        .bind(this.userId, ...ids),
    );
    rows.forEach((r) => out.set(r.person_id, [...(out.get(r.person_id) || []), r.place_id]));
    return out;
  }

  async listPeople(includeArchived = false): Promise<PersonRow[]> {
    const sc = this.scope();
    const rows = await this.all<Omit<PersonRow, "place_ids">>(
      this.d1
        .prepare(
          `SELECT ${this.PERSON_COLS} FROM people WHERE user_id = ?${sc.sql}` +
            (includeArchived ? "" : " AND archived_at IS NULL") +
            " ORDER BY name COLLATE NOCASE",
        )
        .bind(this.userId, ...sc.args),
    );
    const at = await this.placesOfPeople(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, place_ids: at.get(r.id) || [] }));
  }

  /** Exact name first, then a unique partial. Used by spoken "new person" so a
   *  second mention links the existing record instead of minting a twin. */
  async personByName(name: string, context?: string): Promise<PersonRow | null> {
    const lower = name.trim().toLowerCase();
    if (!lower) return null;
    const all = await this.listPeople();
    return all.find((p) => p.name.toLowerCase() === lower && (!context || p.context === context)) ?? null;
  }

  async subjectByName(name: string, context?: string): Promise<SubjectRow | null> {
    const lower = name.trim().toLowerCase();
    if (!lower) return null;
    const all = await this.listSubjects();
    return all.find((s) => s.name.toLowerCase() === lower && (!context || s.context === context)) ?? null;
  }

  async createPerson(p: PersonPatch & { name: string; context: string }): Promise<string> {
    const id = newId();
    const context = normaliseContext(p.context);
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO people (id, user_id, name, role, company, phone, email, notes, context, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, this.userId, p.name.trim(), p.role ?? null, p.company ?? null,
          p.phone ?? null, p.email ?? null, p.notes ?? null, context, Date.now()),
    );
    if (p.place_ids) await this.setPersonPlaces(id, p.place_ids);
    return id;
  }

  /** Replace the set. Only places that are yours are kept, silently: a stale id
   *  from a deleted place should not fail the whole save. */
  async setPersonPlaces(personId: string, placeIds: string[]): Promise<void> {
    const mine = new Set((await this.listPlaces()).map((pl) => pl.id));
    const keep = [...new Set(placeIds)].filter((id) => mine.has(id));
    const stmts = [
      this.d1
        .prepare("DELETE FROM person_places WHERE person_id = ? AND user_id = ?")
        .bind(personId, this.userId),
      ...keep.map((pid) =>
        this.d1
          .prepare("INSERT INTO person_places (person_id, place_id, user_id) VALUES (?, ?, ?)")
          .bind(personId, pid, this.userId)),
    ];
    const res = await this.d1.batch(stmts);
    res.forEach((r) => readMeta(this.meter, r.meta));
  }

  async updatePerson(id: string, patch: PersonPatch): Promise<boolean> {
    const owned = await this.first<{ id: string }>(
      this.d1.prepare("SELECT id FROM people WHERE id = ? AND user_id = ?").bind(id, this.userId),
    );
    if (!owned) return false;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    if (patch.name !== undefined) put("name", patch.name.trim());
    if (patch.context !== undefined) put("context", normaliseContext(patch.context));
    for (const k of ["role", "company", "phone", "email", "notes"] as const) {
      if (patch[k] !== undefined) put(k, patch[k]);
    }
    if (sets.length) {
      await this.run(
        this.d1
          .prepare(`UPDATE people SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
          .bind(...vals, id, this.userId),
      );
    }
    if (patch.place_ids) await this.setPersonPlaces(id, patch.place_ids);
    return true;
  }

  /** Their notes survive, as with a deleted subject. Only the links go. */
  async deletePerson(id: string): Promise<boolean> {
    const res = await this.d1.batch([
      this.d1.prepare("DELETE FROM entry_people WHERE person_id = ? AND user_id = ?").bind(id, this.userId),
      this.d1.prepare("DELETE FROM person_places WHERE person_id = ? AND user_id = ?").bind(id, this.userId),
      this.d1.prepare("DELETE FROM people WHERE id = ? AND user_id = ?").bind(id, this.userId),
    ]);
    res.forEach((r) => readMeta(this.meter, r.meta));
    return (res[res.length - 1]?.meta?.changes ?? 0) > 0;
  }

  async personDetail(id: string): Promise<PersonDetail | null> {
    const row = await this.first<Omit<PersonRow, "place_ids">>(
      this.d1
        .prepare(`SELECT ${this.PERSON_COLS} FROM people WHERE id = ? AND user_id = ?`)
        .bind(id, this.userId),
    );
    if (!row) return null;
    const at = await this.placesOfPeople([id]);
    const entries = await this.all<EntryRow>(
      this.d1
        .prepare(
          `SELECT e.id, e.created_at, e.synced_at, e.context, e.body, e.body_raw,
                  e.lat, e.lng, e.is_open
             FROM entries e
             JOIN entry_people ep ON ep.entry_id = e.id
            WHERE ep.person_id = ? AND e.user_id = ? AND e.deleted_at IS NULL
            ORDER BY e.created_at DESC
            LIMIT 200`,
        )
        .bind(id, this.userId),
    );
    return { ...row, place_ids: at.get(id) || [], entries };
  }

  async linkEntryPeople(entryId: string, personIds: string[]): Promise<void> {
    if (!personIds.length) return;
    const stmts = personIds.map((pid) =>
      this.d1
        .prepare(
          `INSERT INTO entry_people (entry_id, person_id, user_id) VALUES (?, ?, ?)
           ON CONFLICT (entry_id, person_id) DO NOTHING`,
        )
        .bind(entryId, pid, this.userId),
    );
    const res = await this.d1.batch(stmts);
    res.forEach((r) => readMeta(this.meter, r.meta));
  }

  async entryPeople(entryId: string): Promise<PersonRow[]> {
    const rows = await this.all<Omit<PersonRow, "place_ids">>(
      this.d1
        .prepare(
          `SELECT p.id, p.name, p.role, p.company, p.phone, p.email, p.notes, p.context,
                  p.created_at, p.archived_at
             FROM people p
             JOIN entry_people ep ON ep.person_id = p.id
            WHERE ep.entry_id = ? AND p.user_id = ?
            ORDER BY p.name COLLATE NOCASE`,
        )
        .bind(entryId, this.userId),
    );
    return rows.map((r) => ({ ...r, place_ids: [] }));
  }

  // ------------------------------------------------------------- activities
  // §4: time is a stack, not a clock. Something is always running and it nests —
  // "At the shop" over "Compressor 2 — contactor swap". parent_id allows any depth
  // for free; the interface only ever shows the leaf and its parent.

  /**
   * The open chain, leaf first.
   *
   * Read as one query and assembled here rather than walked with a recursive CTE:
   * there is only ever one open chain and it is two or three rows deep, so the walk
   * would cost more in query planning than the rows it saves.
   */
  async openStack(): Promise<ActivityRow[]> {
    const sc = this.scope();
    const open = await this.all<ActivityRow>(
      this.d1
        .prepare(
          `SELECT id, parent_id, label, subject_id, context, started_at, ended_at
             FROM activities WHERE user_id = ? AND ended_at IS NULL${sc.sql}
            ORDER BY started_at DESC`,
        )
        .bind(this.userId, ...sc.args),
    );
    if (!open.length) return [];

    // The leaf is the one nothing else claims as a parent. Deriving it beats
    // trusting recency: a correction can move a start time behind its own parent's.
    const parents = new Set(open.map((a) => a.parent_id).filter(Boolean));
    const byId = new Map(open.map((a) => [a.id, a]));
    const leaf = open.find((a) => !parents.has(a.id)) ?? open[0]!;

    const chain: ActivityRow[] = [];
    let cur: ActivityRow | undefined = leaf;
    while (cur && chain.length < 8) {          // a cycle would otherwise hang here
      chain.push(cur);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
  }

  async startActivity(a: NewActivity): Promise<ActivityRow> {
    const row: ActivityRow = {
      id: newId(),
      parent_id: a.parent_id ?? null,
      label: a.label.trim(),
      subject_id: a.subject_id ?? null,
      context: normaliseContext(a.context),
      started_at: a.started_at ?? Date.now(),
      ended_at: null,
    };
    await this.run(
      this.d1
        .prepare(
          `INSERT INTO activities
             (id, user_id, parent_id, label, subject_id, context, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(row.id, this.userId, row.parent_id, row.label, row.subject_id, row.context, row.started_at),
    );
    return row;
  }

  /**
   * End an activity and anything nested under it.
   *
   * A child cannot outlive its parent — "Compressor 2" happening after "At the
   * shop" finished is not a thing that can be true — so the whole subtree closes
   * at the same instant. Depth is bounded rather than recursive because the
   * interface only ever creates two levels; the loop is there so data that somehow
   * went deeper still closes cleanly.
   */
  async endActivity(id: string, endedAt: number = Date.now()): Promise<number> {
    let ids = [id];
    const all: string[] = [];
    for (let depth = 0; depth < 8 && ids.length; depth++) {
      all.push(...ids);
      const marks = ids.map(() => "?").join(",");
      const kids = await this.all<{ id: string }>(
        this.d1
          .prepare(
            `SELECT id FROM activities
              WHERE user_id = ? AND ended_at IS NULL AND parent_id IN (${marks})`,
          )
          .bind(this.userId, ...ids),
      );
      ids = kids.map((k) => k.id);
    }

    const marks = all.map(() => "?").join(",");
    const res = await this.d1
      .prepare(
        `UPDATE activities SET ended_at = ?
          WHERE user_id = ? AND ended_at IS NULL AND id IN (${marks})`,
      )
      .bind(endedAt, this.userId, ...all)
      .run();
    readMeta(this.meter, res.meta);
    return res.meta?.changes ?? 0;
  }

  /**
   * Remove an activity, and its children with it.
   *
   * Notes captured during it survive with their stamp cleared — they happened, and
   * the note is the record; only the claim about what was being worked on goes. An
   * activity started by mistake is a correction like any other, and without this it
   * would sit in the day's list forever.
   */
  async deleteActivity(id: string): Promise<boolean> {
    const kids = await this.all<{ id: string }>(
      this.d1
        .prepare("SELECT id FROM activities WHERE user_id = ? AND parent_id = ?")
        .bind(this.userId, id),
    );
    const ids = [id, ...kids.map((k) => k.id)];
    const marks = ids.map(() => "?").join(",");

    const res = await this.d1.batch([
      this.d1
        .prepare(`UPDATE entries SET activity_id = NULL WHERE user_id = ? AND activity_id IN (${marks})`)
        .bind(this.userId, ...ids),
      this.d1
        .prepare(`DELETE FROM activities WHERE user_id = ? AND id IN (${marks})`)
        .bind(this.userId, ...ids),
    ]);
    res.forEach((r) => readMeta(this.meter, r.meta));
    return (res[1]?.meta?.changes ?? 0) > 0;
  }

  /** Corrections after the fact, which §11 calls for explicitly. */
  async updateActivity(
    id: string,
    patch: { label?: string; started_at?: number; ended_at?: number | null },
  ): Promise<ActivityRow | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(typeof v === "string" ? v.trim() : v);
    }
    if (sets.length) {
      await this.run(
        this.d1
          .prepare(`UPDATE activities SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
          .bind(...vals, id, this.userId),
      );
    }
    return this.activity(id);
  }

  async activity(id: string): Promise<ActivityRow | null> {
    return this.first<ActivityRow>(
      this.d1
        .prepare(
          `SELECT id, parent_id, label, subject_id, context, started_at, ended_at
             FROM activities WHERE id = ? AND user_id = ?`,
        )
        .bind(id, this.userId),
    );
  }

  /** Everything that overlaps a window, so a span crossing midnight still appears. */
  async activitiesBetween(fromMs: number, toMs: number): Promise<ActivityRow[]> {
    const sc = this.scope();
    return this.all<ActivityRow>(
      this.d1
        .prepare(
          `SELECT id, parent_id, label, subject_id, context, started_at, ended_at
             FROM activities
            WHERE user_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)${sc.sql}
            ORDER BY started_at ASC`,
        )
        .bind(this.userId, ...sc.args, toMs, fromMs),
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
