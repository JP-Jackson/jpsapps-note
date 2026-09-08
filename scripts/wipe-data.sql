-- Empty the app's data, keep the accounts and the Claude connection.
-- Children before parents: D1 enforces foreign keys.
DELETE FROM entry_tags;
DELETE FROM subject_tags;
DELETE FROM entry_subjects;
DELETE FROM entry_people;
DELETE FROM person_places;
DELETE FROM attachments;
DELETE FROM saved_views;
DELETE FROM schedules;
DELETE FROM context_blocks;
DELETE FROM tags;
UPDATE subjects SET hero_photo_id = NULL, parent_id = NULL;
UPDATE entries SET resolved_by = NULL, activity_id = NULL, place_id = NULL;
DELETE FROM subject_attributes;
DELETE FROM entries;
DELETE FROM subjects;
DELETE FROM people;
DELETE FROM activities;
DELETE FROM places;
DELETE FROM context_shares;
