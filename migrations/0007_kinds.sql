-- v2 data model: every capture has a kind, and there are three new axes to find
-- things on — tags, due dates and readings. All additive. Nothing here rewrites a
-- note; the day log stays the day log.
--
--   kind      note | todo | appt | value | spec
--   todo      due_at, done_at.  is_open is kept in step (1 while a to-do is undone)
--             so the older queries and the MCP tools keep answering.
--   appt      starts_at, ends_at
--   value     metric, value, unit   — a reading off a thing at a moment: odo 84200
--   spec      spec_key, spec_value  — a fact about a thing; also written to
--             subject_attributes so the thing's page shows it
--   reviewed  0 = in the Inbox, waiting to be filed

ALTER TABLE entries ADD COLUMN kind        TEXT NOT NULL DEFAULT 'note';
ALTER TABLE entries ADD COLUMN due_at      INTEGER;
ALTER TABLE entries ADD COLUMN done_at     INTEGER;
ALTER TABLE entries ADD COLUMN starts_at   INTEGER;
ALTER TABLE entries ADD COLUMN ends_at     INTEGER;
ALTER TABLE entries ADD COLUMN metric      TEXT;
ALTER TABLE entries ADD COLUMN value       REAL;
ALTER TABLE entries ADD COLUMN unit        TEXT;
ALTER TABLE entries ADD COLUMN spec_key    TEXT;
ALTER TABLE entries ADD COLUMN spec_value  TEXT;
ALTER TABLE entries ADD COLUMN amount      REAL;                      -- cost, optional
ALTER TABLE entries ADD COLUMN reviewed    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE entries ADD COLUMN schedule_id TEXT;                      -- to-do spawned by a schedule

-- What used to be a follow-up flag is a to-do now.
UPDATE entries SET kind = 'todo' WHERE is_open = 1 OR resolved_by IS NOT NULL;
UPDATE entries SET done_at = COALESCE(edited_at, created_at) WHERE kind = 'todo' AND is_open = 0;

CREATE INDEX idx_entries_kind_due ON entries(user_id, kind, done_at, due_at);
CREATE INDEX idx_entries_inbox    ON entries(user_id, reviewed, created_at);
CREATE INDEX idx_entries_metric   ON entries(user_id, metric, created_at);

-- Tags: what a thing is about, as many as you like. The tree says where it lives;
-- tags cut across that. One row per name so a rename or merge is one row.
CREATE TABLE tags (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,           -- lower case, no leading #
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE entry_tags (
  entry_id    TEXT NOT NULL REFERENCES entries(id),
  tag_id      TEXT NOT NULL REFERENCES tags(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  suggested   INTEGER NOT NULL DEFAULT 0,   -- 1 = a guess not yet accepted
  PRIMARY KEY (entry_id, tag_id)
);
CREATE INDEX idx_entry_tags_tag ON entry_tags(user_id, tag_id);

CREATE TABLE subject_tags (
  subject_id  TEXT NOT NULL REFERENCES subjects(id),
  tag_id      TEXT NOT NULL REFERENCES tags(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (subject_id, tag_id)
);
CREATE INDEX idx_subject_tags_tag ON subject_tags(user_id, tag_id);

-- Schedules: a rule on a thing, like an alarm setpoint. Every N days, every N of a
-- metric, or a fixed day each year; both of the first two set means whichever
-- comes first. Marking it done stamps last_done_at / last_value and the next due
-- is computed from those and the latest reading — nothing here is a stored date
-- that can go stale.
CREATE TABLE schedules (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  subject_id    TEXT REFERENCES subjects(id),
  context       TEXT NOT NULL,
  label         TEXT NOT NULL,           -- 'Oil change'
  every_days    INTEGER,
  every_value   REAL,
  metric        TEXT,                    -- which reading every_value counts in
  fixed_month   INTEGER,                 -- 1-12, with fixed_day: yearly on that date
  fixed_day     INTEGER,
  last_done_at  INTEGER,
  last_value    REAL,
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER
);
CREATE INDEX idx_schedules_user ON schedules(user_id, archived_at);

-- A filter worth coming back to: '#xlights, to-dos, by due'.
CREATE TABLE saved_views (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  context     TEXT NOT NULL,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL,             -- JSON: the table/tag filter as sent to /api/entries
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_saved_views_user ON saved_views(user_id, context, sort_order);
