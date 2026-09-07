import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const TAG = "run" + Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
// A fixed location so proximity is deterministic.
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block",
  permissions: ["geolocation"], geolocation: { latitude: 29.0577094, longitude: -96.9786539 } });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
let answer = null;
p.on("dialog", (d) => d.accept(typeof answer === "string" ? answer : ""));
const boot = async () => {
  await p.goto(B, { waitUntil: "networkidle" });
  await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
};
await boot();
// clear this run's slate
await p.evaluate(async () => {
  for (const pl of (await (await fetch("/api/places")).json()).places || [])
    await fetch("/api/places/" + pl.id, { method: "DELETE" });
});
await boot();

check(await p.isVisible("#placeChip"), "the place chip is always there, not only when one is detected");
check(/Add a place/.test(await p.textContent("#placeChip")), "with no places yet it offers to add one");

await p.click("#placeChip"); await p.waitForTimeout(600);
check(await p.isVisible("#places"), "tapping it opens the picker");
check(/Nowhere in particular/.test(await p.textContent("#placesBody")), "which offers 'nowhere in particular'");

answer = "The Rental " + TAG;
await p.click("#addPlaceHere"); await p.waitForTimeout(1400);
check((await p.$$("#placesBody [data-pick-place]")).length === 2, "adding one lists it");
check(/here/.test(await p.textContent("#placesBody")), "and shows it as here");
await p.waitForTimeout(300);
check(new RegExp("At.*The Rental " + TAG).test(await p.textContent("#placeChip")),
  `the chip now names it (${(await p.textContent("#placeChip")).trim()})`);

// a second place, added while standing in the same spot — next door is inside GPS error
answer = "Home " + TAG;
// the picker stays open after adding, so you can see it land; close it first
await p.evaluate(() => history.back()); await p.waitForTimeout(500);
await p.click("#placeChip"); await p.waitForTimeout(600);
await p.click("#addPlaceHere"); await p.waitForTimeout(1400);
const rows = await p.$$eval("#placesBody [data-pick-place]", (n) => n.map((x) => x.textContent.trim()));
check(rows.length === 3, `both places are offered even though they share coordinates (${rows.length - 1})`);

// choosing the other one sticks
await p.click(`[data-pick-place]:has-text("The Rental ${TAG}")`); await p.waitForTimeout(700);
check(new RegExp("The Rental " + TAG).test(await p.textContent("#placeChip")),
  "choosing the far-from-obvious one sticks — proximity does not override it");

// and lands on the capture
await p.fill("#body", "capacitor 5/40, forty side reading 37.7 " + TAG);
await p.click("#save"); await p.waitForTimeout(3800);
const landed = await p.evaluate(async (tag) => {
  const e = (await (await fetch("/api/entries")).json()).entries.find((x) => (x.body || "").includes(tag));
  const pl = (await (await fetch("/api/places")).json()).places;
  const d = await (await fetch("/api/entries/" + e.id)).json();
  return (pl.find((x) => x.id === d.place_id) || {}).name;
}, TAG);
check(landed === "The Rental " + TAG, `the capture records the place you chose (${landed})`);

// removing a place leaves the note's coordinates alone
const before = await p.evaluate(async (tag) =>
  (await (await fetch("/api/entries")).json()).entries.find((x) => (x.body || "").includes(tag)).lat, TAG);
await p.click("#placeChip"); await p.waitForTimeout(600);
answer = null;   // a confirm takes no text
// Delete the one the note actually uses; both sit at the same coordinates, so
// "the first row" is whichever the sort happened to put first.
const rentalId = await p.evaluate(async (tag) =>
  (await (await fetch("/api/places")).json()).places.find((x) => x.name === "The Rental " + tag).id, TAG);
await p.click(`[data-del-place="${rentalId}"]`); await p.waitForTimeout(1400);
const after = await p.evaluate(async (tag) => {
  const e = (await (await fetch("/api/entries")).json()).entries.find((x) => (x.body || "").includes(tag));
  return { lat: e.lat, place: (await (await fetch("/api/entries/" + e.id)).json()).place_id };
}, TAG);
check(after.lat === before, "removing a place keeps the note's coordinates");
check(after.place === null, "and only drops the name");

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
