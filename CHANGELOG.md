# Changelog

Mirrors the list shown in Settings. One line per release — enough to answer
"did the thing I asked for actually ship", not full release notes.

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
