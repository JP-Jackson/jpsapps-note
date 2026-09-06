-- Phase 4 groundwork: seed the onboarding templates, record who a context is
-- shared with, and index the lookups subject pages actually make.
--
-- Additive only. Nothing here changes an existing column or query.

-- ---------------------------------------------------------------- templates
-- NOTE_SPEC.md §4: exactly three types to start. Generic covers about ninety
-- percent of things; a type only earns its own template once you have added a
-- third or fourth of that kind and are tired of typing the same fields.
-- Because attributes are key-value anyway, a generic subject can hold any field —
-- a template's only job is remembering what to ask.
INSERT INTO subject_templates (type, key, label, sort_order) VALUES
  ('generic',   'make',       'Make',            1),
  ('generic',   'model',      'Model',           2),
  ('generic',   'notes',      'Notes',           3),

  ('vehicle',   'make',       'Make',            1),
  ('vehicle',   'model',      'Model',           2),
  ('vehicle',   'year',       'Year',            3),
  ('vehicle',   'vin',        'VIN',             4),
  ('vehicle',   'plate',      'Plate',           5),
  ('vehicle',   'engine_oil', 'Engine oil',      6),
  ('vehicle',   'tire_size',  'Tire size',       7),

  ('equipment', 'make',       'Make',            1),
  ('equipment', 'model',      'Model',           2),
  ('equipment', 'serial',     'Serial number',   3),
  ('equipment', 'voltage',    'Voltage / phase', 4),
  ('equipment', 'location',   'Location',        5),
  ('equipment', 'notes',      'Notes',           6);

-- ---------------------------------------------------------- context sharing
-- §7: "Sharing is scoped by context, not all-or-nothing. JP's wife sees Home —
-- the AC, the mower, the cameras. She never sees Work."
--
-- So the grant belongs on the context, not on each subject. `subjects.visibility`
-- says whether a thing may be shared at all; this says who with. Per-subject
-- grants would mean re-deciding for every new mower and camera, which is exactly
-- the friction that stops sharing being used.
--
-- user_id is the OWNER (§4: user_id on every table), granted_to is the recipient.
CREATE TABLE context_shares (
  user_id     TEXT NOT NULL REFERENCES users(id),
  granted_to  TEXT NOT NULL REFERENCES users(id),
  context     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, granted_to, context)
);

-- Answering "what has been shared with me" is the read that happens on every
-- request once sharing is on, so it gets its own index.
CREATE INDEX idx_context_shares_grantee ON context_shares(granted_to, context);

-- No new indexes here: 0001 already covers the subject page's reads
-- (idx_subjects_user, idx_entry_subjects_subject, idx_attachments_subject).
