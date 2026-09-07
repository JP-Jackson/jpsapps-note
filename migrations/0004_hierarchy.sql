-- Hierarchy for things: Home → Yard → Front sprinkler, Rental → Air conditioner.
--
-- Additive only. Every existing subject keeps parent_id and place_id NULL, which
-- reads as "a root thing that lives nowhere in particular" — exactly the flat list
-- that is on screen today. Nothing is backfilled and no existing query changes
-- meaning.

-- Two columns, not one, because a tree needs two different kinds of parent.
--
-- §4 already says where things happen: places. So places are the roots of the tree
-- and subjects nest under a place and under each other. The alternative — a "Home"
-- subject that duplicates the "Home" place — would leave two records of the same
-- yard, one of which collects notes and one of which does not.
--
-- Only ONE of these is ever set on a row. A subject with a parent inherits its
-- place from that parent (db.ts enforces both halves): storing the place on every
-- descendant would be a second copy of the same fact, and the copy is the one that
-- goes stale the first time a branch is moved.
ALTER TABLE subjects ADD COLUMN parent_id TEXT REFERENCES subjects(id);
ALTER TABLE subjects ADD COLUMN place_id  TEXT REFERENCES places(id);

-- The tree screen asks "what lives under this" and capture asks "what lives here".
-- Both are per-user, so the user id leads the index — the same shape as
-- idx_subjects_user in 0001.
CREATE INDEX idx_subjects_parent ON subjects(user_id, parent_id);
CREATE INDEX idx_subjects_place  ON subjects(user_id, place_id);
