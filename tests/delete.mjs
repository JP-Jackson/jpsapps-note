import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
// Run-scoped: these count and address rows, and the database is not empty.
const TAG = "run" + Math.random().toString(36).slice(2, 8);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block" });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
p.on("dialog", (d) => d.accept());
await p.goto(B, { waitUntil: "networkidle" });
await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(700);
await p.click('nav [data-view="capture"]');
await p.waitForTimeout(300);

const api = (path, opts) => p.evaluate(async ([u, o]) => {
  const r = await fetch(u, o); let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}, [path, opts || {}]);

const mkEntry = (body, agoMs = 0) => p.evaluate(async ([b, ago]) => {
  const id = crypto.randomUUID();
  await fetch("/api/entries", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, created_at: Date.now() - ago, context: "work", body: b }) });
  return id;
}, [body, agoMs]);

// ---------------- fresh entry: deletable, and everything goes with it ----------------
const id = await mkEntry("typo entry to remove " + TAG);
await p.evaluate(async (i) => {
  await fetch("/api/files?entry_id=" + i, { method: "POST",
    headers: { "content-type": "application/pdf", "x-filename": "doomed.pdf" }, body: "%PDF fake" });
}, id);
let d = await api("/api/entries/" + id);
check(d.body.deletable_for_ms > 0, `a fresh entry reports time left (${Math.round(d.body.deletable_for_ms/60000)} min)`);
check(d.body.files.length === 1, "and has a file attached");

await p.click('nav button[data-view="log"]'); await p.waitForTimeout(700);
await p.click(`#dayList .entry:has-text("typo entry to remove ${TAG}")`); await p.waitForSelector("#deleteEntry", { timeout: 4000 });
check(/for \d+ minutes more|under a minute/.test(await p.textContent(".windowleft")), "detail says how long is left");
await p.click("#deleteEntry"); await p.waitForTimeout(1200);
check((await api("/api/entries/" + id)).status === 404, "entry is gone from the server");
const orphan = await p.evaluate(async (tag) =>
  (await (await fetch("/api/entries")).json()).entries.filter((e) => (e.body || "").includes(tag)).length, TAG);
check(orphan === 0, `and out of the log (${orphan} of this run's left)`);

// The row going is not the point -- the object going is. A photo whose row is gone
// but whose object survives sits at its public URL with nothing recording it exists.
{
  const id2 = await mkEntry("entry whose photo must really go " + TAG);
  const key = await p.evaluate(async (i) => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const r = await fetch("/api/files?entry_id=" + i, { method: "POST",
      headers: { "content-type": "image/png", "x-filename": "shot.png" }, body: png });
    return (await r.json()).url;
  }, id2);
  check(/^https:\/\/img\./.test(key), `photo went to the public bucket (${key.slice(0, 46)}…)`);
  await api("/api/entries/" + id2, { method: "DELETE" });
  check((await api("/api/entries/" + id2)).status === 404, "entry with a photo deletes");
  globalThis.__deletedKey = key;
}

// ---------------- past the window: refused, and no button offered ----------------
const old = await mkEntry("older than the window " + TAG, 20 * 60 * 1000);
d = await api("/api/entries/" + old);
check(d.body.deletable_for_ms === 0, "a 20-minute-old entry reports no time left");
const refused = await api("/api/entries/" + old, { method: "DELETE" });
check(refused.status === 403, `server refuses it even if asked directly (${refused.status})`);
check(/window has passed/.test(refused.body.error || ""), `and says why (${refused.body.error})`);
check((await api("/api/entries/" + old)).status === 200, "the entry survives the refused attempt");

// go() is a no-op when the tab is already current, so the list would still be the
// stale one from before this entry existed.
await p.click('nav button[data-view="capture"]'); await p.waitForTimeout(300);
await p.click('nav button[data-view="log"]'); await p.waitForTimeout(900);
await p.click(`#dayList .entry:has-text("older than the window ${TAG}")`); await p.waitForTimeout(900);
check(await p.$("#deleteEntry") === null, "and no Delete button is offered for it");
await p.evaluate(() => history.back()); await p.waitForTimeout(400);

// ---------------- a thing: deleted, but its notes survive ----------------
const sub = await p.evaluate(async (tag) => {
  const r = await fetch("/api/subjects", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Scrap Compressor " + tag, type: "equipment", context: "work" }) });
  return (await r.json()).id;
}, TAG);
const kept = await mkEntry("note that must outlive the thing " + TAG);
await p.evaluate(async ([e, sId]) => {
  await fetch("/api/entries/" + e + "/subjects", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ subject_ids: [sId] }) });
}, [kept, sub]);
check((await api("/api/subjects/" + sub)).body.entries.length === 1, "the thing has the note linked");

await p.click('nav button[data-view="subjects"]'); await p.waitForTimeout(700);
// By id: other runs have left subjects in the list.
await p.click(`[data-subject-id="${sub}"]`); await p.waitForSelector("#editSubject", { timeout: 4000 });
await p.click("#editSubject"); await p.waitForSelector("#deleteSubject", { timeout: 4000 });
await p.click("#deleteSubject"); await p.waitForTimeout(1200);
check((await api("/api/subjects/" + sub)).status === 404, "thing is gone");
check((await api("/api/entries/" + kept)).status === 200, "but the note logged against it survives");
check((await api("/api/entries/" + kept)).body.subjects.length === 0, "with the link cleaned up, not dangling");

// ---------------- a queued note can be discarded before it ever syncs ----------------
await ctx.setOffline(true);
await p.evaluate(() => window.dispatchEvent(new Event("offline")));
await p.click('nav button[data-view="capture"]'); await p.waitForTimeout(400);
await p.fill("#body", "queued mistake " + TAG);
await p.click("#save"); await p.waitForTimeout(3500);
check(await p.isVisible("#log .entry.pending"), "a queued note shows as pending");
check(await p.isVisible("#log .entry.pending .rowx"), "and offers a discard");
await p.click("#log .entry.pending .rowx"); await p.waitForTimeout(800);
const left = await p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("note", 2);
  r.onsuccess = () => r.result.transaction("queue").objectStore("queue").getAll().onsuccess = (e) => res(e.target.result.length);
}));
check(left === 0, `discarded straight out of the queue, never reaching the server (${left} left)`);

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
console.log("\n  check the object is gone from R2:\n   ", globalThis.__deletedKey);
await browser.close();
process.exit(fails ? 1 : 0);
