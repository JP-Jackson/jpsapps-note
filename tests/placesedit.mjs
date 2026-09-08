/**
 * The places layer: correcting a place, and admitting when it cannot be done.
 *
 * Four defects, all found while planning the offline work and all invisible from
 * reading the code:
 *
 *  1. Creating a place died silently with no signal. Offline a fetch *rejects*
 *     rather than answering, so `if (!r.ok)` never ran and the handler fell over on
 *     an unhandled rejection — you typed a name, tapped, and nothing was said.
 *  2. A place could not be renamed or re-pinned at all, so a pin dropped on the
 *     wrong building could only be corrected by deleting it and adding it again.
 *     That unfiles every thing rooted there and strips place_id off every entry
 *     that named it. This file's centre of gravity is that path being closed.
 *  3. The delete confirm still said only "Notes keep their coordinates", which
 *     stopped being the whole truth in 1.19 when places became the roots of the
 *     tree.
 *  4. The map is the one screen that needs somebody else's server, and offline it
 *     drew a grey square with a confident pin over it rather than saying so.
 *
 * Nothing here assumes an empty database: every name carries a run tag, the place
 * and the thing are addressed by id, and both are removed at the end.
 */
import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const TAG = "run" + Math.random().toString(36).slice(2, 8);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 }, serviceWorkers: "block",
  permissions: ["geolocation"], geolocation: { latitude: 29.0577094, longitude: -96.9786539 },
});
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });

// Both the text a prompt is answered with and the text the dialog asked, because
// what the confirm *says* is one of the four things under test.
// One handler, not two. A second listener registered with `once` never gets the
// dialog — the first one has already answered it — so the mode is a flag instead.
let answer = null, lastDialog = "", dismissNext = false;
p.on("dialog", (d) => {
  lastDialog = d.message();
  if (dismissNext) { dismissNext = false; d.dismiss(); return; }
  d.accept(typeof answer === "string" ? answer : "");
});

const boot = async () => {
  await p.goto(B, { waitUntil: "networkidle" });
  await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
  await p.reload({ waitUntil: "networkidle" });
await p.click('nav [data-view="capture"]');
await p.waitForTimeout(300);
  await p.waitForTimeout(1200);
};
await boot();

const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const readout = async () => {
  const t = await p.textContent("#mapAt");
  const [lat, lng] = t.split("·")[0].split(",").map((n) => Number(n.trim()));
  return { lat, lng, radius: Number(/(\d+) m/.exec(t)[1]) };
};
/* Saving from the map closes the map and leaves the places list open underneath, so
   this has to be idempotent. Tapping the chip again would aim at an element the open
   overlay covers, and a covered element is not hidden — the click lands on the
   overlay and the test times out with nothing wrong in the app. */
const openList = async () => {
  if (await p.isVisible("#places")) { await p.waitForTimeout(200); return; }
  await p.click("#placeChip");
  await p.waitForTimeout(600);
};

/* ---------------------------------------------------- something to correct */

await openList();
answer = "zzShop " + TAG;          // zz so it sorts last whatever an earlier run left
await p.click("#addPlaceHere");
await p.waitForTimeout(1400);
const placeId = await p.evaluate(async (n) =>
  ((await (await fetch("/api/places")).json()).places.find((x) => x.name === n) || {}).id,
  "zzShop " + TAG);
check(!!placeId, "a place to correct exists");

// A thing rooted there and a note captured there — the two things the old
// delete-and-recreate path silently destroyed.
const thingId = await p.evaluate(async (arg) => {
  const r = await fetch("/api/subjects", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Compressor " + arg.tag, type: "equipment", context: "work",
      place_id: arg.place }),
  });
  return (await r.json()).id;
}, { tag: TAG, place: placeId });
check(!!thingId, "with a thing filed in it");

await p.evaluate(() => history.back());
await p.waitForTimeout(500);
await openList();
await p.click(`[data-pick-place="${placeId}"]`);
await p.waitForTimeout(700);
await p.fill("#body", "megged the windings, 8.2 meg " + TAG);
await p.click("#save");
await p.waitForTimeout(3800);
const entryId = await p.evaluate(async (t) =>
  ((await (await fetch("/api/entries")).json()).entries.find((x) => (x.body || "").includes(t)) || {}).id, TAG);
const entryPlacedBefore = entryId
  ? (await api("/api/entries/" + entryId)).place_id : null;
check(entryPlacedBefore === placeId, "and a note that names it");

/* ------------------------------------------------- correcting it in place */

await openList();
check((await p.$$(`[data-edit-place="${placeId}"]`)).length === 1,
  "every place offers a way to correct it");

await p.click(`[data-edit-place="${placeId}"]`);
await p.waitForTimeout(900);
check(await p.isVisible("#mapPick"), "which opens the map on that place");
check(/Move this pin/.test(await p.textContent("#mapTitle")),
  "titled for the job it is doing, not 'Drop a pin'");
check(await p.inputValue("#mapName") === "zzShop " + TAG,
  "with the name it already has, so a re-pin is not also a rename");

const before = await readout();
check(Math.abs(before.lat - 29.0577094) < 0.0005,
  `centred on the place, not on wherever the phone is (${before.lat})`);

// Move the pin the way somebody correcting a slightly-wrong drop would.
const b = await (await p.$("#mapView")).boundingBox();
await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
await p.mouse.down();
await p.mouse.move(b.x + b.width / 2 + 140, b.y + b.height / 2 + 90, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(400);
const moved = await readout();
check(moved.lng < before.lng && moved.lat > before.lat, "the pin can be walked to the right building");

await p.fill("#mapName", "zzShop back lot " + TAG);
await p.click('[data-radius="400"]');
await p.waitForTimeout(200);
await p.click("#mapSave");
await p.waitForTimeout(1600);

check(await p.isVisible("#mapPick") === false, "saving closes the map");

const after = await p.evaluate(async (id) =>
  (await (await fetch("/api/places")).json()).places.find((x) => x.id === id), placeId);
check(!!after, "the place is the same place — a correction, not a replacement");
check(after && after.name === "zzShop back lot " + TAG, "renamed");
check(after && Math.abs(after.lng - moved.lng) < 0.0002 && Math.abs(after.lat - moved.lat) < 0.0002,
  "re-pinned to the coordinates under the pin");
check(after && after.radius_m === 400, "and how close counts as being there can change too");

// The whole reason this exists. Before it, the only way to move a pin was to delete
// the place, which took these two with it.
const thingStill = await p.evaluate(async (arg) =>
  ((await (await fetch("/api/subjects")).json()).subjects.find((x) => x.id === arg.thing) || {}).place_id,
  { thing: thingId });
check(thingStill === placeId, "the thing filed there is still filed there");
const entryStill = (await api("/api/entries/" + entryId)).place_id;
check(entryStill === placeId, "and the note still names it — the data-loss path is closed");

/* -------------------------------------------- the confirm tells the truth */

await openList();
answer = null;
lastDialog = "";
// Cancel it: this assertion is about what the confirm says, not about deleting.
dismissNext = true;
await p.click(`[data-del-place="${placeId}"]`);
await p.waitForTimeout(700);
check(/1 item filed there becomes unfiled/.test(lastDialog),
  `the delete confirm counts what it unfiles (${JSON.stringify(lastDialog)})`);
check(/coordinates/.test(lastDialog), "and still says notes keep their coordinates");
check(!!(await p.evaluate(async (id) =>
  (await (await fetch("/api/places")).json()).places.find((x) => x.id === id), placeId)),
  "and cancelling it removes nothing");

/* ------------------------------------------------------------- no signal */

await ctx.setOffline(true);
await p.waitForTimeout(600);

check(await p.getAttribute("#addPlaceMap", "disabled") !== null,
  "with no signal the map is not offered");
check(/needs a connection/.test(await p.textContent("#addPlaceMap")),
  "and says why rather than opening a grey square");

// Tapping the pencil offline must say something too — the same screen, the same
// dependency on somebody else's tile server.
await p.click(`[data-edit-place="${placeId}"]`);
await p.waitForTimeout(600);
check(await p.isVisible("#mapPick") === false, "correcting a place offline does not open the map");
check(/needs a connection/.test(await p.textContent("#placesBody")),
  "it explains itself in the list instead");

// The defect that started all this: offline, a bare fetch rejects rather than
// answering, so the handler died and nothing at all was said.
const errorsBefore = fails;
answer = "zzGhost " + TAG;
await p.click("#addPlaceHere");
await p.waitForTimeout(1200);
check(fails === errorsBefore, "saving a place offline does not die on an unhandled rejection");
check(/not saved/.test(await p.textContent("#placesBody")),
  "it says the place was not saved, rather than nothing at all");
const ghost = await p.evaluate(() => document.querySelectorAll("[data-pick-place]").length);
check(!/zzGhost/.test(await p.textContent("#placesBody")) && ghost > 0,
  "and does not draw a place that does not exist");

await ctx.setOffline(false);
await p.waitForTimeout(800);
check(/Pick on a map/.test(await p.textContent("#addPlaceMap")),
  "signal coming back re-offers the map without a reload");

/* ------------------------------------------------------------- tidy up */

await p.evaluate(async (arg) => {
  await fetch("/api/subjects/" + arg.thing, { method: "DELETE" });
  await fetch("/api/places/" + arg.place, { method: "DELETE" });
}, { thing: thingId, place: placeId });

await browser.close();
console.log(fails ? `\n${fails} failed` : "\nall green");
process.exit(fails ? 1 : 0);
