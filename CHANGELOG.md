# Changelog

Mirrors the list shown in Settings. One line per release — enough to answer
"did the thing I asked for actually ship", not full release notes.

## 2.0.2
Work accent is charcoal (#2E3A45 light, #8FA3B5 dark), picked from a swatch sheet.

## 2.0.1
Work is a darker maroon. Links on Today are ink and underlined instead of an
unreadable blue. Typing `every 30 days` or `every 5000 mi` in the capture line makes
a repeating schedule on the thing named. A schedule's editor links to Google
Calendar as a repeating event, so the phone does the reminding.

## 2.0.0
Every capture has a kind: note, to-do, appointment, value (a reading off a thing —
odo 84,200) or spec (a fact about a thing — tire size). One line does it:
`@compressor2 contactor chattering #parts !fri` files it, tags it and makes it a
to-do due Friday; chips under the line show what was understood and the kind chips
override it. Tags cut across the tree. Four doors onto the same rows — Tree, Tags,
Stream and Table with CSV and saved views. Due gathers to-dos, appointments and
schedules (every N days, every N miles, or a yearly date; both means whichever
first) with progress bars and a Done that resets the next. Inbox holds bare notes
until they are filed. Today lands first: overdue, this week, inbox, recent. Tap any
row to edit everything about it; delete and done get an Undo instead of a confirm.
Appointments and dated to-dos link into Google Calendar or Outlook. Claude's tools
learned kinds, tags, schedules and the inbox.

## 1.22.0
Places can be corrected. A pin dropped on the wrong building, or a name typed in a
hurry, is fixed with the pencil on its row — the same map, opened on the place, with
its name and radius already filled in. Until now the only way to move a pin was to
delete the place and add it again, which unfiled every thing rooted there and took
the name off every note that referenced it. Removing a place now says how many things
that unfiles before it does it. And the two screens that can fail quietly no longer
do: saving a place with no signal says the place was not saved instead of doing
nothing at all, and the map says it needs a connection rather than drawing a grey
square with a confident-looking pin over it.

## 1.21.0
Drag things around the tree. Press and hold a row, drag it onto another thing to file
it inside, onto a place to make it a root there, or onto **Not in a place** to pull it
back out. Its own branch never lights up — nothing can be filed inside itself. Every
place now gets a heading whether or not anything is in it yet, so an empty place is
somewhere you can drop things. And a **+** on any row or heading opens Add-a-thing
with that answer already filled in, so a part is added where it belongs rather than
loose and then hunted down.

## 1.20.0
Drop a pin. Places can be added from a map instead of only from where the phone is
standing — drag until the pin sits on the place, pick how close counts as being
there, and the ring shows that distance at its real size on the ground. This is the
answer to the two cases a location fix can never get right: a job written up after
you have left, and next door sitting inside GPS error. OpenStreetMap tiles, no
account and no key; the map is hand-rolled rather than pulling in a library.

## 1.19.0
Things nest. **Home → Yard → Front sprinkler**, **Rental → Air conditioner** — places
are the roots and things go under a place and under each other. The Things tab draws
the tree, with branches that fold and a flat list still one tap away. A thing's page
shows the path down to it and what is inside it, and either can be moved from the
edit screen. Deleting a thing promotes whatever was inside it instead of taking it
along. After saving a note, the things that live where you are are offered first.

## 1.18.0
Places are chosen, not only detected. The chip is always there and opens a list of
every place with a way to add one where you are standing, so a job written up after
you have left can still be filed where it happened. Places can be renamed and
removed. The log heading carries the date.

## 1.17.0
Dates and times read **Monday, 9/7/2026 1:10 PM** everywhere they are written out,
from one formatter rather than five ad-hoc ones. An activity started by mistake can
be removed; notes captured during it stay in the log and lose only the stamp. Fixed
the day's activity rows, where a long label was squeezed until it wrapped one word
per line.

## 1.16.0
Activities (phase 5). Time as a stack rather than a clock: something is always
running, and it nests one level — "At the shop" over "Compressor 2 — contactor". The
capture screen shows what is running and every note is stamped with it. Capturing
with nothing running asks when the day started; an activity still running from a
previous day asks when it finished. Times are editable after the fact.

## 1.15.0
Usage bars in Settings: AI neurons, database reads, database writes and storage,
each against its free allocation, from the self-metered tally rather than
Cloudflare's analytics. A thing can have a cover photo — tap **Make cover** on any
of its photos and it leads the page and the list; tap it again to clear it.

## 1.14.0
A note can be deleted for 15 minutes after it was captured, and the detail screen
says how long is left. After that it is permanent. A note still in the offline queue
can be discarded outright, since it never reached the server. Things can be deleted
with no window — their notes survive, only the link goes. Photos and files are
removed from storage, not just unlinked.

## 1.13.0
The install offer sits at the top of the capture screen, not only in Settings — one
tap installs on Android, and on iPhone it opens the Safari steps. Dismiss it and it
stays gone. On a desktop it reads as installing an app in a pinnable window, which
is what installing there actually does.

## 1.12.1
The install screen can now tell that Note is still installed as an Android app even
when you are looking at it in a browser tab — taking the icon off the home screen
only removes the shortcut. It says so, and how to uninstall properly, instead of
pointing vaguely at the browser menu.

## 1.12.0
Settings can add Note to your home screen. On Android that is the browser's own
install dialog; on iPhone it is the three steps to do it from Safari, because Apple
gives a page no way to ask. Says so plainly when it is already installed.

## 1.11.1
Home-screen icon rebuilt. It drew its own rounded square and keyline, which Android
then masked again — a ring inside a ring, with the keyline shaved at the clip edge.
All three icons are full bleed now, the monogram sits inside the maskable safe zone,
and the white corner artifacts in the old files are gone. Generated by
`npm run icons` rather than by hand.

## 1.11.0
Attach files — PDFs, exports, HTML, anything — to a capture or to a thing. Documents
go to a private bucket and come back through the Worker behind Access, so revoking
access actually revokes them; photos keep using the public CDN, where the bandwidth
argument applies. Documents always download and never render. Removing a file deletes
the stored object too, not just the record.

## 1.10.0
Contexts are Work and Home. Vehicles was never a sharing boundary — a work truck is
Work and her car is Home — so filtering to vehicles is answered by the thing's type
instead. Linking a note to a thing happens after it is saved rather than before,
offered as a bar that costs nothing to ignore, and works offline both ways. A thing's
page has a **+ Note** button that opens capture already aimed at it.

## 1.9.1
A thing's context and type are normalised and checked before they are stored. The
bulk importer took free text, so "vehicle " reached the database and produced a
thing that could never be attached to a capture. Route errors now answer with their
own status instead of a bare 500.

## 1.9.0
Note connects to Claude over MCP. Seven tools: search the log, read a day, list
open items, read a thing's whole history, add a thing, add a note. `/mcp` sits
outside Cloudflare Access with its own OAuth; the consent screen stays inside it.
Settings lists live connections and can disconnect them.

## 1.8.0
Import an HTML or text log as dated entries, and a copy button for the prompt that
tells Claude what shape to hand back.

## 1.7.0
Adding a thing is a real screen with a worked example. Read and edit are separate.
The Android back button moves back a screen instead of closing the app.

## 1.6.0
Capture rebuilt for one-handed use: everything you touch to finish a capture now
sits in the bottom third, with Save furthest right. Places are matched by
proximity and suggested. Tapping the sync indicator forces a sync and reloads if
the build has moved on. Version history in Settings.

## 1.5.0
Things: list, detail with key-value attributes, full history, three onboarding
templates, bulk import. Context-scoped sharing table added (not yet read).

## 1.4.0
Wordmark set in Caveat and given its own token, so it no longer follows the UI
font. The splash writes the name with a single left-to-right reveal.

## 1.3.0
Header rebuilt to the approved layout. High-contrast mode. Roboto, Ubuntu and
Public Sans added; Gluten removed.

## 1.2.0
Settings: theme and font pickers. Fonts self-hosted — they were named in the
stylesheet but never actually loaded.

## 1.1.0
Views: day log, open follow-ups oldest-first, search, entry detail with the
follow-up thread and the original dictation. Version stamping.

## 1.0.0
Capture screen, offline queue in IndexedDB, home-screen web app.
