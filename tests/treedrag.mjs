/**
 * Rearranging the tree by dragging, and adding a thing where you are looking.
 *
 * Driven with the mouse, which takes the pointerType === "mouse" branch and starts
 * dragging on movement rather than on a hold. The hold is a touch affordance; every
 * rule that matters after the drag has begun — what counts as a target, what a drop
 * writes, what a drop must NOT do — is shared, and that is what is under test here.
 *
 * Tagged unique to the run and addressed by id, per tests/README.md.
 */
import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const TAG = "run" + Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block",
  hasTouch: true,
  permissions: ["geolocation"], geolocation: { latitude: 29.0577094, longitude: -96.9786539 } });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
p.on("dialog", (d) => d.accept(""));

const boot = async () => {
  await p.goto(B, { waitUntil: "networkidle" });
  await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
};
await boot();

const api = (path, init) => p.evaluate(async ([path, init]) => {
  const r = await fetch(path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}, [path, init]);
const post = (path, body) => api(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const homeOf = async (id) => {
  const b = (await api("/api/subjects/" + id)).body;
  return { parent: b.parent_id, place: b.place_id };
};

// Named to sort last. Places are listed alphabetically and "Not in a place" always
// comes after them, so a "zz" prefix puts this run's group and that heading next to
// each other — every drag in this file is then between two rows a few pixels apart,
// however many hundred things earlier runs left in the database. Dragging is the one
// interaction where "do not assume an empty database" is not enough on its own: two
// points that cannot share a screen cannot be dragged between.
const shed = (await post("/api/places", { name: "zzShed " + TAG, lat: 29.0577, lng: -96.9786 })).body.id;
const barn = (await post("/api/places", { name: "zzBarn " + TAG, lat: 29.06, lng: -96.97 })).body.id;

const alpha = (await post("/api/subjects",
  { name: "Alpha " + TAG, type: "generic", context: "work", place_id: shed })).body.id;
const beta = (await post("/api/subjects",
  { name: "Beta " + TAG, type: "equipment", context: "work", place_id: shed })).body.id;
const gamma = (await post("/api/subjects",
  { name: "Gamma " + TAG, type: "equipment", context: "work", parent_id: alpha })).body.id;

await boot();
await p.click('nav button[data-view="subjects"]');
await p.waitForTimeout(900);

// Every place is a heading now, filed or not — an empty place you cannot see is an
// empty place you cannot drag anything into.
const heads = await p.$$eval(".tgroup .gn", (n) => n.map((x) => x.textContent.trim()));
check(heads.includes("zzBarn " + TAG),
  "a place with nothing in it still gets a heading, so it can be dropped on");
check(heads.includes("Not in a place"),
  "and there is always somewhere to drag things back out to");

/**
 * Put both ends of a drag somewhere they can actually be hit.
 *
 * The nav bar is fixed over the bottom of the screen and the header is sticky at the
 * top, and an element underneath either receives no pointer events at all — it is
 * not hidden, it is covered, so it still reports a perfectly good bounding box and
 * every click silently lands on the nav instead. That cost an hour: the drags had
 * passed, then a later run with more rows in the database pushed them under the nav
 * and every assertion went red at once with nothing wrong in the app.
 */
const SAFE_TOP = 130, SAFE_BOTTOM = 140;
const bring = async (from, to) => {
  await p.$eval(to, (el) => el.scrollIntoView({ block: "center" }));
  await p.waitForTimeout(150);
  const h = await p.evaluate(() => innerHeight);
  let a = await (await p.$(from)).boundingBox();
  let b = await (await p.$(to)).boundingBox();
  // Centre the pair rather than either one, so a source above and a target below
  // both end up in the band between the header and the nav.
  await p.evaluate((dy) => scrollBy(0, dy),
    (a.y + a.height / 2 + b.y + b.height / 2) / 2 - h / 2);
  await p.waitForTimeout(150);
  a = await (await p.$(from)).boundingBox();
  b = await (await p.$(to)).boundingBox();
  const ok = (r) => r.y > SAFE_TOP && r.y + r.height < h - SAFE_BOTTOM;
  check(ok(a) && ok(b),
    `both ends of the drag are clear of the header and the nav (${Math.round(a.y)}, ${Math.round(b.y)} of ${h})`);
  return { a, b };
};

/** Drag the centre of one selector onto the centre of another. */
const dragTo = async (from, to) => {
  const { a, b } = await bring(from, to);
  await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await p.mouse.down();
  await p.mouse.move(a.x + a.width / 2 + 14, a.y + a.height / 2 + 4, { steps: 3 });
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await p.waitForTimeout(120);
  const lit = await p.$$eval(".drop-into", (n) => n.length);
  await p.mouse.up();
  await p.waitForTimeout(1100);
  return lit;
};

const row = (id) => `.trow[data-subject-id="${id}"]`;
const group = (id) => `.tgroup[data-place-id="${id}"]`;

/* ------------------------------------------------- a thing onto another thing */

let lit = await dragTo(row(beta), row(alpha));
check(lit === 1, `the row under the pointer is highlighted while dragging (${lit})`);
let where = await homeOf(beta);
check(where.parent === alpha && where.place === null,
  "dropping a thing on a thing files it inside — and clears the place, never both");
check(await p.isVisible(row(gamma)), "the branch it joined is still drawn");

/* --------------------------------------------------- a thing onto a place */

lit = await dragTo(row(beta), group(barn));
check(lit === 1, "a place heading highlights too");
where = await homeOf(beta);
check(where.place === barn && where.parent === null,
  "dropping on a place makes it a root there, which is the only way out of a branch");

/* ------------------------------------------- and back out to nowhere at all */

await dragTo(row(beta), group(""));
where = await homeOf(beta);
check(where.place === null && where.parent === null,
  "dropping on 'Not in a place' unfiles it — null is savable, not just ignored");

/* ------------------------------------------------------------- the refusal */

// Alpha contains Gamma. Dropping Alpha into Gamma would close a loop.
const before = await homeOf(alpha);
lit = await dragTo(row(alpha), row(gamma));
check(lit === 0, `a thing's own branch never lights up as a target (${lit})`);
const after = await homeOf(alpha);
check(after.parent === before.parent && after.place === before.place,
  "and nothing moves when it is dropped there anyway");

/* ----------------------------------------------- dragging has not eaten the tap */

await p.click(row(gamma));
await p.waitForTimeout(900);
check(await p.isVisible("#subject"), "a plain tap still opens the thing");
check(new RegExp("Gamma " + TAG).test(await p.textContent(".subjhead h1")), "the right one");
await p.evaluate(() => history.back());
await p.waitForTimeout(700);

// A drop lands as a click on the row underneath it. That must not open it.
// gamma is already inside alpha, so this moves nothing and is purely about the click
// — and the two sit next to each other, which a thing unfiled among a screenful of
// leftovers would not.
await dragTo(row(gamma), row(alpha));
check(await p.isHidden("#subject"), "but dropping onto a thing does not open it");

/* ------------------------------------------------- adding where you are looking */

await p.click(`${row(alpha)} [data-add-inside]`);
await p.waitForTimeout(700);
check(await p.isVisible("#addThing"), "the + on a row opens the Add screen");
check(await p.inputValue("#newHome") === "s:" + alpha,
  "already filed inside the thing you tapped it on");
await p.fill("#newName", "Delta " + TAG);
await p.click("#createThing");
await p.waitForTimeout(1400);

const delta = await p.evaluate(async (tag) =>
  ((await (await fetch("/api/subjects")).json()).subjects || []).find((s) => s.name === "Delta " + tag), TAG);
check(!!delta && delta.parent_id === alpha, "and what you add lands there, not loose");

await p.evaluate(() => history.back()); await p.waitForTimeout(500);
await p.click('nav button[data-view="subjects"]'); await p.waitForTimeout(900);
await p.click(`${group(barn)} [data-add-inside]`);
await p.waitForTimeout(700);
check(await p.inputValue("#newHome") === "p:" + barn,
  "the + on a place heading fills that place in instead");

/* ------------------------------------------------------------ the touch path

   The branch above is the mouse one. This is the branch a phone takes, and it is
   the one that cannot be checked by reading: press-and-move has to keep scrolling
   the list, and only press-and-HOLD-and-move may pick a thing up. Real touch events
   through CDP rather than synthetic ones, so pointer capture and pointerType are
   the browser's own rather than something the test made up. */

const cdp = await ctx.newCDPSession(p);
const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", {
  type,
  touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
});

/** Press, optionally hold, drag, release — the whole gesture as a finger makes it. */
const touchDrag = async (from, to, holdMs) => {
  const boxes = await bring(from, to);
  const a = { x: boxes.a.x + boxes.a.width / 2, y: boxes.a.y + boxes.a.height / 2 };
  const b = { x: boxes.b.x + boxes.b.width / 2, y: boxes.b.y + boxes.b.height / 2 };
  await touch("touchStart", a.x, a.y);
  await p.waitForTimeout(holdMs);
  await touch("touchMove", a.x + 10, a.y + 6);
  await p.waitForTimeout(90);
  await touch("touchMove", b.x, b.y);
  await p.waitForTimeout(140);
  const lifted = await p.$$eval(".tghost", (n) => n.length);
  await touch("touchEnd", b.x, b.y);
  await p.waitForTimeout(1100);
  return lifted;
};

await p.evaluate(() => history.back()); await p.waitForTimeout(500);
await p.click('nav button[data-view="subjects"]'); await p.waitForTimeout(900);

// Gamma sits inside Alpha. A flick — press and move without holding — is a scroll,
// and must leave it exactly where it was.
const stay = await homeOf(gamma);
let ghosts = await touchDrag(row(gamma), group(barn), 0);
check(ghosts === 0, `a flick never picks anything up (${ghosts} ghosts)`);
const stillThere = await homeOf(gamma);
check(stillThere.parent === stay.parent && stillThere.place === stay.place,
  "so scrolling the list cannot rearrange it by accident");

// The same gesture with a hold in front of it is a drag.
ghosts = await touchDrag(row(gamma), group(barn), 480);
check(ghosts === 1, `holding first picks it up (${ghosts} ghost)`);
const moved = await homeOf(gamma);
check(moved.place === barn && moved.parent === null,
  "and a held drag files it where it was dropped");

/* Tidy up. Not because the tests assume an empty database — they must not — but
   because dragging needs two points on one screen, and every run that leaves rows
   behind makes that harder for the next one. */
await p.evaluate(async (ids) => {
  for (const id of ids.things) await fetch("/api/subjects/" + id, { method: "DELETE" });
  for (const id of ids.places) await fetch("/api/places/" + id, { method: "DELETE" });
}, { things: [delta && delta.id, gamma, beta, alpha].filter(Boolean), places: [shed, barn] });

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
