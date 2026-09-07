import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block" });
// Photos are served from img.jpsapps.com, which does not exist for a local dev
// server — and the <img onerror> handler removes a photo that will not load, so
// without this the wrappers vanish before anything can be asserted about them.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
await ctx.route("https://img.jpsapps.com/**", (route) =>
  route.fulfill({ status: 200, contentType: "image/png", body: PNG }));

const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
p.on("dialog", (d) => d.accept());
await p.goto(B, { waitUntil: "networkidle" });
await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(700);

// ================= usage bars =================
await p.click("#gear"); await p.waitForTimeout(900);
const bars = await p.$$eval("#usage .bar-h .lb", (n) => n.map((x) => x.textContent.trim()));
check(bars.length === 4, `four bars, as §8 asks (${bars.length})`);
check(JSON.stringify(bars) === JSON.stringify(["AI neurons","Database reads","Database writes","Photo and file storage"]),
  `and the right four (${JSON.stringify(bars)})`);
const notes = await p.$$eval("#usage .bar-n", (n) => n.map((x) => x.textContent.trim()));
check(/of 5,000,000$/.test(notes[1]), `reads measured against the D1 free tier (${notes[1]})`);
check(/of 10\.00 GB$/.test(notes[3]), `storage against R2's 10 GB (${notes[3]})`);
const reads = await p.$eval("#usage .bar-f", (e) => e.style.width);
check(parseFloat(reads) >= 0, "bars render a width");
// the meter is live: opening settings itself costs reads
const before = await p.evaluate(async () => (await (await fetch("/api/me")).json()).usageToday.rows_read);
await p.evaluate(async () => { for (let i = 0; i < 3; i++) await fetch("/api/entries"); });
const after = await p.evaluate(async () => (await (await fetch("/api/me")).json()).usageToday.rows_read);
check(after > before, `the meter is live, not a placeholder (${before} -> ${after})`);
await p.evaluate(() => history.back()); await p.waitForTimeout(400);

// ================= hero photo =================
const sub = await p.evaluate(async () => {
  const r = await fetch("/api/subjects", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Cover Test Unit", type: "equipment", context: "work" }) });
  return (await r.json()).id;
});
const shots = await p.evaluate(async (id) => {
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const out = [];
  for (const n of ["first.png", "second.png"]) {
    const r = await fetch("/api/files?subject_id=" + id, { method: "POST",
      headers: { "content-type": "image/png", "x-filename": n }, body: png });
    out.push((await r.json()).id);
  }
  return out;
}, sub);
check(shots.length === 2, "two photos on the thing");

await p.click('nav button[data-view="subjects"]'); await p.waitForTimeout(700);
check(await p.$(`[data-subject-id="${sub}"] .cover.none`) !== null,
  "list shows a placeholder while there is no cover");

// By id, not "the first row": a leftover subject from an earlier run would otherwise
// open the wrong thing and the failure would look like a bug in the app.
await p.click(`[data-subject-id="${sub}"]`); await p.waitForSelector(".coverbtn", { timeout: 4000 });
const labels = await p.$$eval(".coverbtn", (n) => n.map((x) => x.textContent.trim()));
check(labels.every((l) => l === "Make cover"), `no cover set yet (${JSON.stringify(labels)})`);

// set the SECOND photo, so ordering is actually proved rather than coincidental
await p.click(`[data-hero="${shots[1]}"]`); await p.waitForTimeout(1200);
const order = await p.$$eval(".shotwrap .coverbtn", (n) => n.map((x) => x.textContent.trim()));
check(order[0] === "Cover", `the cover moves to the top (${JSON.stringify(order)})`);
const heroNow = await p.evaluate(async (id) => (await (await fetch("/api/subjects/" + id)).json()).hero_photo_id, sub);
check(heroNow === shots[1], "and it is the one that was tapped, not the first");

await p.evaluate(() => history.back()); await p.waitForTimeout(800);
const listCover = await p.$eval(`[data-subject-id="${sub}"] .cover`, (e) => e.tagName + ":" + (e.getAttribute("src") || ""));
check(/^IMG:https:\/\/img\./.test(listCover), `the list now shows the cover (${listCover.slice(0, 40)}…)`);

// tapping the current cover clears it
await p.click(`[data-subject-id="${sub}"]`); await p.waitForSelector(".coverbtn.on", { timeout: 4000 });
await p.click(".coverbtn.on"); await p.waitForTimeout(1200);
const cleared = await p.evaluate(async (id) => (await (await fetch("/api/subjects/" + id)).json()).hero_photo_id, sub);
check(cleared === null, `tapping the cover again clears it (${JSON.stringify(cleared)})`);

// The storage bar read 0 B earlier because nothing had been uploaded yet. Prove the
// SUM actually moves, or the bar is decoration.
{
  const me = await p.evaluate(async () => (await (await fetch("/api/me")).json()));
  check(me.storageBytes > 0, `storage total reflects the uploaded photos (${me.storageBytes} bytes)`);
  await p.evaluate(() => history.back());   // the subject overlay is still covering the gear
  await p.waitForTimeout(500);
  await p.click("#gear"); await p.waitForTimeout(900);
  const note = (await p.$$eval("#usage .bar-n", (n) => n.map((x) => x.textContent.trim())))[3];
  check(/^[0-9.]+ (B|KB) of 10\.00 GB$/.test(note), `and the bar shows it (${note})`);
}

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
