# Browser tests

Not run in CI — they need a live `wrangler dev` and a real browser, and CI's job is
to keep a broken build from deploying, not to hold a server open.

Run them by hand when the capture path changes:

    npx wrangler dev --port 8791          # in one shell
    npm run test:ui                       # in another

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
