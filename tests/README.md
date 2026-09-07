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
ranking, capture-from-a-thing, the back stack, the tree of things, and both offline
branches (a link folded into a still-queued entry, and one queued separately for an
entry that has already synced).

`treedrag.mjs` drives both input styles, because they take different branches: a
mouse drags on movement, a finger has to press and hold first. The touch half goes
through CDP `Input.dispatchTouchEvent` so pointer capture and `pointerType` are the
browser's own. It also centres both ends of every drag and asserts they clear the
sticky header and the fixed nav — an element under either is not hidden, it is
covered, and every click silently lands on the nav.

`mappick.mjs` asserts nothing about map tiles. They come from
`tile.openstreetmap.org`, which a sandboxed runner may not reach at all, and a test
that goes red because someone else's CDN is slow is one you learn to ignore. The
Mercator maths, the drag and the saved coordinates are checked through the map's
coordinate readout instead.

`hierarchy.mjs` is the reason the "no empty database" rule keeps earning itself: the
tree is drawn from every subject the account holds, so it creates its own place per
run and asks the API which things actually live there rather than assuming the five
chips it can see are the only candidates.

They write to the **local** D1, never `--remote`. Clear it first if a previous run
left things behind:

    npx wrangler d1 execute note --local --command \
      "DELETE FROM entry_subjects; DELETE FROM entries; DELETE FROM subject_attributes; DELETE FROM subjects;"

`attachments.mjs` needs three fixtures in /tmp/fx: `IR-2475-manual.pdf`, `points.csv`
and `b44-log.html`. The HTML one must contain a literal `<script>` in its first forty
bytes — the test asserts the file comes back untouched and inert only because it is
served as a download.

Every bug these caught was invisible from reading the code: a `history.back()` race
that left a stack entry matching nothing on screen, an overlay that was never
registered so back fell out of the app, and a subject picker that filtered on a
context nothing used.
