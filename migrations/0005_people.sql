-- People: who was involved. Separate from subjects on purpose — a person is not
-- "inside" a lease the way a VFD is, and belongs to several places at once.
-- user_id on every table, per the rule that must not be relaxed.

CREATE TABLE people (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  role        TEXT,                    -- 'Lease operator'
  company     TEXT,
  phone       TEXT,
  email       TEXT,
  notes       TEXT,                    -- 'How I know them', free text
  context     TEXT NOT NULL,           -- 'work' | 'home'
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX idx_people_user ON people(user_id, archived_at, name);

-- A person can be at many places: a foreman covers three leases.
CREATE TABLE person_places (
  person_id   TEXT NOT NULL REFERENCES people(id),
  place_id    TEXT NOT NULL REFERENCES places(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (person_id, place_id)
);
CREATE INDEX idx_person_places_place ON person_places(user_id, place_id);

-- A note can involve several people, the same shape as entry_subjects.
CREATE TABLE entry_people (
  entry_id    TEXT NOT NULL REFERENCES entries(id),
  person_id   TEXT NOT NULL REFERENCES people(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (entry_id, person_id)
);
CREATE INDEX idx_entry_people_person ON entry_people(user_id, person_id);
