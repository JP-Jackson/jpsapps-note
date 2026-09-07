# Browser tests

Not run in CI — they need a live `wrangler dev` and a real browser, and CI's job is
to keep a broken build from deploying, not to hold a server open.

Run them by hand when the capture path changes:

    npx wrangler dev --port 8787              # in one shell
    NOTE_URL=http://127.0.0.1:8787 npm run test:ui   # in another

Every file honours `NOTE_URL`, so the whole suite runs against one server.
`attachments.mjs` needs fixtures in /tmp/fx.

They do **not** assume an empty database. Anything counted or matched by text is
tagged unique to the run, and subjects are addressed by id rather than "the first
row" — a leftover row from an earlier run should never make a correct app look
broken. Several hours were lost to exactly that before the rule was adopted.

They drive the real app in Chromium: contexts, the post-save link bar and its
ranking, capture-from-a-thing, the back stack, and both offline branches (a link
folded into a still-queued entry, and one queued separately for an entry that has
already synced).

They write to the **local** D1, never `--remote`. Clear it first if a previous run
left things behind:

    npx wrangler d1 execute note --local --command \
      "DELETE FROM entry_subjects; DELETE FROM entries; DELETE FROM subject_attributes; DELETE FROM subjects;"

Every bug these caught was invisible from reading the code: a `history.back()` race
that left a stack entry matching nothing on screen, an overlay that was never
registered so back fell out of the app, and a subject picker that filtered on a
context nothing used.
