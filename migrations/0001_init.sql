-- Note — foundation schema (phase 1)
--
-- Every user-owned table carries user_id from day one. Per NOTE_SPEC.md §4 this is
-- the one thing in the design that is genuinely painful to retrofit: adding it after
-- 2,000 entries means backfilling rows and rewriting every query.
--
-- The single exception is subject_templates, which is global reference data
-- (what to ask when adding a subject of a given type), not user data.
--
-- All tables are created now, including ones phase 1 does not use. Empty tables cost
-- nothing and it means user_id is never retrofitted anywhere.

-- ---------- people ----------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);

-- ---------- named places ----------
CREATE TABLE places (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  radius_m    INTEGER NOT NULL DEFAULT 150,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_places_user ON places(user_id);

-- ---------- the things ----------
-- hero_photo_id forward-references attachments; SQLite resolves foreign key parents
-- lazily at DML time, so declaration order does not matter here.
CREATE TABLE subjects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,          -- 'generic' | 'vehicle' | 'equipment'
  context       TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'private',
  hero_photo_id TEXT REFERENCES attachments(id),
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER
);
CREATE INDEX idx_subjects_user ON subjects(user_id, archived_at, name);

-- variable detail without schema changes, ever
CREATE TABLE subject_attributes (
  subject_id  TEXT NOT NULL REFERENCES subjects(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  key         TEXT NOT NULL,            -- 'Engine oil', 'Tire size', 'VIN'
  value       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_id, key)
);

-- ---------- what to ask when adding a new subject ----------
-- Global reference data. The one table with no user_id, deliberately.
-- Not seeded in phase 1; templates arrive with subjects in phase 4.
CREATE TABLE subject_templates (
  type        TEXT NOT NULL,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, key)
);

-- ---------- time as a stack, not a clock ----------
CREATE TABLE activities (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  parent_id   TEXT REFERENCES activities(id),
  label       TEXT NOT NULL,
  subject_id  TEXT REFERENCES subjects(id),
  context     TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
-- "what is running right now" — the hottest query in the app
CREATE INDEX idx_activities_open ON activities(user_id, ended_at, started_at DESC);

-- ---------- the event stream ----------
CREATE TABLE entries (
  id            TEXT PRIMARY KEY,       -- generated on the device at capture time
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,       -- when it happened (device clock)
  synced_at     INTEGER,                -- when the server received it
  context       TEXT NOT NULL,          -- 'work' | 'home' | 'vehicles' | ...
  body          TEXT,                   -- the cleaned-up note
  body_raw      TEXT,                   -- original dictation, never overwritten
  lat           REAL,
  lng           REAL,
  place_id      TEXT REFERENCES places(id),
  activity_id   TEXT REFERENCES activities(id),
  is_open       INTEGER NOT NULL DEFAULT 0,
  resolved_by   TEXT REFERENCES entries(id),
  version       INTEGER NOT NULL DEFAULT 1,
  edited_at     INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX idx_entries_user_time ON entries(user_id, created_at DESC);
CREATE INDEX idx_entries_open      ON entries(user_id, is_open, created_at);
CREATE INDEX idx_entries_activity  ON entries(activity_id);
CREATE INDEX idx_entries_place     ON entries(place_id);

-- ---------- one entry can touch several subjects ----------
CREATE TABLE entry_subjects (
  entry_id    TEXT NOT NULL REFERENCES entries(id),
  subject_id  TEXT NOT NULL REFERENCES subjects(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (entry_id, subject_id)
);
-- reverse lookup: "everything that ever happened to Compressor 2"
CREATE INDEX idx_entry_subjects_subject ON entry_subjects(user_id, subject_id);

-- ---------- files, links, photos ----------
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  entry_id     TEXT REFERENCES entries(id),
  subject_id   TEXT REFERENCES subjects(id),
  kind         TEXT NOT NULL,           -- 'photo' | 'file' | 'url'
  r2_key       TEXT,
  url          TEXT,
  title        TEXT,
  mime         TEXT,
  bytes        INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_attachments_entry   ON attachments(entry_id);
CREATE INDEX idx_attachments_subject ON attachments(subject_id);

-- ---------- saved context for Claude ----------
CREATE TABLE context_blocks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  context     TEXT,
  subject_id  TEXT REFERENCES subjects(id),
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_context_blocks_user ON context_blocks(user_id);

-- ---------- self-metered usage, for the quota bars ----------
-- No FK to users on purpose: metering writes stay cheap and independent.
CREATE TABLE usage_log (
  user_id     TEXT NOT NULL,
  day         TEXT NOT NULL,            -- 'YYYY-MM-DD' UTC
  metric      TEXT NOT NULL,            -- 'neurons' | 'rows_read' | 'rows_written'
  amount      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, metric)
);
