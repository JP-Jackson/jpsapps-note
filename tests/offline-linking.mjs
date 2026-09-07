import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };

// Every assertion here counts or ranks something, so both the things and the notes
// are unique to this run. Otherwise a leftover "Compressor 2" outranks the subject
// under test and a correct app looks broken.
const TAG = "run" + Math.random().toString(36).slice(2, 8);
const COMP = "Shop Compressor " + TAG;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block" });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
await p.goto(B, { waitUntil: "networkidle" });
await p.evaluate(async (n) => {
  await fetch("/api/subjects", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: n, type: "equipment", context: "work" }) });
}, COMP);
await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(800);

// ============ A. link while OFFLINE, entry still in the queue ============
await ctx.setOffline(true);
await p.evaluate(() => window.dispatchEvent(new Event("offline")));
await p.fill("#body", COMP + " tripped again, breaker warm");
await p.click("#save");
await p.waitForSelector("#linkBar:not([hidden])", { timeout: 4000 });
const first = await p.$eval("#linkChips .chip", (n) => n.textContent.trim());
check(first === COMP, `offline: the named thing ranks first (got "${first}")`);

const qBefore = await p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("note", 2);
  r.onsuccess = () => r.result.transaction("queue").objectStore("queue").getAll().onsuccess = (e) => res(e.target.result);
}));
check(qBefore.length === 1, `offline: the note is durable in the queue (${qBefore.length})`);

await p.click('#linkChips [data-link]');
await p.waitForTimeout(800);
const qAfter = await p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("note", 2);
  r.onsuccess = () => r.result.transaction("queue").objectStore("queue").getAll().onsuccess = (e) => res(e.target.result);
}));
check((qAfter[0]?.subject_ids || []).length === 1,
  `offline: link folded into the queued entry, no separate request (${JSON.stringify(qAfter[0]?.subject_ids)})`);

// back online -> it should land, link and all
await ctx.setOffline(false);
await p.evaluate(() => { window.dispatchEvent(new Event("online")); });
await p.waitForTimeout(2500);
const compEntries = await p.evaluate(async (n) => {
  const subs = (await (await fetch("/api/subjects")).json()).subjects;
  const c = subs.find((s) => s.name === n);
  return (await (await fetch("/api/subjects/" + c.id)).json()).entries.map((e) => e.body);
}, COMP);
check(compEntries.some((b) => /breaker warm/.test(b)),
  `offline note synced WITH its link (${JSON.stringify(compEntries)})`);

// ============ B. link an entry that has ALREADY synced ============
await p.fill("#body", "swapped the contactor on it " + TAG);
await p.click("#save");
await p.waitForSelector("#linkBar:not([hidden])", { timeout: 4000 });
await p.waitForTimeout(2000);                       // let it flush out of the queue
const stillQueued = await p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("note", 2);
  r.onsuccess = () => r.result.transaction("queue").objectStore("queue").getAll().onsuccess = (e) => res(e.target.result.length);
}));
check(stillQueued === 0, "entry has flushed out of the queue before we link it");

await p.click('#linkChips [data-link]');
await p.waitForTimeout(2000);
const after = await p.evaluate(async (n) => {
  const subs = (await (await fetch("/api/subjects")).json()).subjects;
  const c = subs.find((s) => s.name === n);
  const d = await (await fetch("/api/subjects/" + c.id)).json();
  const links = await new Promise((res) => {
    const r = indexedDB.open("note", 2);
    r.onsuccess = () => r.result.transaction("links").objectStore("links").getAll().onsuccess = (e) => res(e.target.result);
  });
  return { bodies: d.entries.map((e) => e.body), pending: links.length };
}, COMP);
check(after.bodies.some((b) => /contactor/.test(b)), `already-synced entry linked after the fact (${JSON.stringify(after.bodies)})`);
check(after.pending === 0, `link queue drained (${after.pending} left)`);

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
