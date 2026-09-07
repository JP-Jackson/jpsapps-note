/**
 * Dropping a pin on a map.
 *
 * Deliberately asserts nothing about tiles. They come from tile.openstreetmap.org,
 * which a sandboxed test runner may not be able to reach at all — and a test that
 * goes red because someone else's CDN is slow teaches you to ignore it. What is
 * actually under test is the Web Mercator maths, the drag, and the coordinates that
 * end up on the saved row, all of which are ours and all of which are readable from
 * the coordinate readout.
 *
 * Places created here are tagged unique to the run and addressed by id, per
 * tests/README.md.
 */
import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const TAG = "run" + Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
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

/** The readout is the receipt: "29.05771, -96.97865 · 150 m · z17". */
const readout = async () => {
  const t = (await p.textContent("#mapAt")).split("·").map((x) => x.trim());
  const [lat, lng] = t[0].split(",").map(Number);
  return { lat, lng, radius: parseInt(t[1], 10), z: parseInt(t[2].slice(1), 10) };
};

await p.click("#placeChip"); await p.waitForTimeout(700);
check(await p.isVisible("#addPlaceMap"), "the places list offers a map as well as 'here'");

await p.click("#addPlaceMap"); await p.waitForTimeout(800);
check(await p.isVisible("#mapPick"), "which opens the picker");
check(await p.isVisible("#mapPin"), "with a pin");
check(/OpenStreetMap/.test(await p.textContent("#mapAttr")),
  "and the attribution the tile licence requires");

const start = await readout();
check(Math.abs(start.lat - 29.0577094) < 0.0002 && Math.abs(start.lng + 96.9786539) < 0.0002,
  `it opens on the current fix (${start.lat}, ${start.lng})`);
check(start.z === 17 && start.radius === 150, `at a sensible zoom and radius (z${start.z}, ${start.radius}m)`);

// The map must have laid itself out despite having been display:none a moment ago —
// an element measured while hidden is zero-wide and tiles nothing.
const tiles = await p.$$eval("#mapTiles img", (n) => n.length);
check(tiles > 0, `the viewport is measured after it is shown, not while hidden (${tiles} tiles)`);

/* ---------------------------------------------------------------- panning */

const box = await p.$("#mapView");
const b = await box.boundingBox();
const drag = async (dx, dy) => {
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await p.mouse.down();
  await p.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(400);
};

// The pin does not move; the world moves under it. So dragging the map east (right)
// puts the pin further west, and dragging it down puts the pin further north.
await drag(120, 0);
const west = await readout();
check(west.lng < start.lng, `dragging right walks the pin west (${start.lng} -> ${west.lng})`);
check(Math.abs(west.lat - start.lat) < 0.00002, "and leaves latitude alone");

await drag(0, 90);
const north = await readout();
check(north.lat > west.lat, `dragging down walks the pin north (${west.lat} -> ${north.lat})`);

// A drag of a known size at a known zoom moves a knowable distance, which is the
// whole Mercator conversion in one assertion.
const moved = await p.evaluate(() => metresPerPx(mapC.lat, mapZ) * 120);
const apart = await p.evaluate((a) => metresBetween(a.lat, a.lng, mapC.lat, mapC.lng),
  { lat: north.lat, lng: start.lng });
check(Math.abs(apart - moved) / moved < 0.05,
  `120px at z17 is the ground distance Mercator says it is (${apart.toFixed(1)}m vs ${moved.toFixed(1)}m)`);

/* ------------------------------------------------------------------ zoom */

await p.click("#mapOut"); await p.waitForTimeout(400);
const out = await readout();
check(out.z === 16, `zooming out steps the zoom (z${out.z})`);
check(Math.abs(out.lat - north.lat) < 0.00002 && Math.abs(out.lng - north.lng) < 0.00002,
  "and holds the pin exactly where it was");

// The ring is drawn at its real ground size, so half the zoom is half the ring.
const ringOut = await p.$eval("#mapRing", (n) => n.getBoundingClientRect().width);
await p.click("#mapIn"); await p.waitForTimeout(400);
const ringIn = await p.$eval("#mapRing", (n) => n.getBoundingClientRect().width);
check(Math.abs(ringIn / ringOut - 2) < 0.06,
  `the radius ring is ground truth, not a fixed circle (${ringOut.toFixed(0)}px -> ${ringIn.toFixed(0)}px)`);

await p.click('[data-radius="400"]'); await p.waitForTimeout(300);
const wide = await readout();
check(wide.radius === 400, "the radius chips set how close counts as here");

/* ------------------------------------------------------------------ saving */

await p.fill("#mapName", "Pinned " + TAG);
const pinned = await readout();
await p.click("#mapSave"); await p.waitForTimeout(1500);

check(await p.isHidden("#mapPick"), "saving closes the picker");
const saved = await p.evaluate(async (tag) =>
  ((await (await fetch("/api/places")).json()).places || []).find((x) => x.name === "Pinned " + tag), TAG);
check(!!saved, "and the place is there");
check(saved && Math.abs(saved.lat - pinned.lat) < 0.00002 && Math.abs(saved.lng - pinned.lng) < 0.00002,
  "at the coordinates under the pin, not the ones the phone reported");
check(saved && saved.radius_m === 400, `with the radius that was chosen (${saved && saved.radius_m})`);
check(new RegExp("Pinned " + TAG).test(await p.textContent("#placeChip")),
  "and it becomes the place this capture is at");

/* ------------------------------------------------------- back, not out of the app */

// The places list is still open underneath — saving returns you to it rather than
// dumping you back on the capture screen — so the map is one tap away, not two.
check(await p.isVisible("#places"), "saving lands back on the places list");
await p.click("#addPlaceMap"); await p.waitForTimeout(700);
await p.evaluate(() => history.back()); await p.waitForTimeout(600);
check(await p.isHidden("#mapPick"), "back closes the picker");
check(await p.isVisible("#places"), "and lands on the places list underneath, not out of the app");

// Cancelling must not leave a half-made place behind.
const count = await p.evaluate(async (tag) =>
  ((await (await fetch("/api/places")).json()).places || []).filter((x) => x.name.includes(tag)).length, TAG);
check(count === 1, `cancelling saves nothing (${count} place from this run)`);

// Tidy up after the run rather than leaving pins in the list.
await p.evaluate(async (id) => { await fetch("/api/places/" + id, { method: "DELETE" }); }, saved.id);

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
