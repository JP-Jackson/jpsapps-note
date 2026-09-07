-- Two worlds that never intertwine: work and personal. "Home" was one place among
-- several (the rental, the in-laws') so the not-work side is renamed. Places get a
-- world of their own instead of inferring one from the notes made there.
ALTER TABLE places ADD COLUMN context TEXT NOT NULL DEFAULT 'work';
CREATE INDEX idx_places_context ON places(user_id, context);

UPDATE entries        SET context = 'personal' WHERE context = 'home';
UPDATE subjects       SET context = 'personal' WHERE context = 'home';
UPDATE activities     SET context = 'personal' WHERE context = 'home';
UPDATE people         SET context = 'personal' WHERE context = 'home';
UPDATE context_blocks SET context = 'personal' WHERE context = 'home';
UPDATE context_shares SET context = 'personal' WHERE context = 'home';
