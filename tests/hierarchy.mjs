/**
 * Things nest: Home > Yard > Front sprinkler, Rental > Air conditioner.
 *
 * Everything here is tagged unique to the run and addressed by id, per the rule in
 * tests/README.md — the tree is drawn from every subject the account has, so a
 * leftover row from a previous run is exactly the kind of thing that would make a
 * correct tree look wrong.
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
  // Everything this run makes is personal, and the page boots into work.
  await p.click('[data-ctx="personal"]');
  await p.waitForTimeout(800);
};
await boot();

const api = (path, init) => p.evaluate(
  async ([path, init]) => {
    const r = await fetch(path, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [path, init]);

const post = (path, body) => api(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const patch = (path, body) => api(path, {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

/* ------------------------------------------------------------ the two trees */

const home = (await post("/api/places", { name: "Home " + TAG, lat: 29.0577094, lng: -96.9786539, context: "home" })).body.id;
const rental = (await post("/api/places", { name: "Rental " + TAG, lat: 29.1, lng: -96.9, context: "home" })).body.id;

const yard = (await post("/api/subjects",
  { name: "Yard " + TAG, type: "generic", context: "home", place_id: home })).body.id;
const sprinkler = (await post("/api/subjects",
  { name: "Front sprinkler " + TAG, type: "equipment", context: "home", parent_id: yard })).body.id;
const ac = (await post("/api/subjects",
  { name: "Air conditioner " + TAG, type: "equipment", context: "home", place_id: rental })).body.id;

check(!!yard && !!sprinkler && !!ac, "a place, a thing in it, and a thing in that thing all save");

/* ------------------------------------------------------------- the data model */

const deep = await api("/api/subjects/" + sprinkler);
check(deep.body.parent_id === yard, "the sprinkler records its parent");
check(deep.body.place_id === null,
  "and NOT its place — a child inherits the place, so storing it twice is a copy that can go stale");
check(deep.body.path.map((c) => c.name).join(" > ") === `Home ${TAG} > Yard ${TAG}`,
  `the path down to it is the place then the parent (${deep.body.path.map((c) => c.name).join(" > ")})`);
check(deep.body.path[0].kind === "place" && deep.body.path[1].kind === "subject",
  "and says which crumb is a place and which is a thing");

const yardDetail = await api("/api/subjects/" + yard);
check(yardDetail.body.children.length === 1 && yardDetail.body.children[0].id === sprinkler,
  "the yard knows what is inside it");

/* --------------------------------------------------------------- the refusals */

const self = await patch("/api/subjects/" + yard, { parent_id: yard });
check(self.status === 400, `a thing cannot be put inside itself (${self.status})`);

const cycle = await patch("/api/subjects/" + yard, { parent_id: sprinkler });
check(cycle.status === 400,
  `nor inside something already inside it — that closes a loop the tree would recurse forever on (${cycle.status})`);

const missing = await post("/api/subjects",
  { name: "Nowhere " + TAG, type: "generic", context: "home", parent_id: "does-not-exist" });
check(missing.status === 400, `a parent that does not exist is refused (${missing.status})`);

const both = await post("/api/subjects",
  { name: "Both " + TAG, type: "generic", context: "home", parent_id: yard, place_id: rental });
const bothRow = (await api("/api/subjects/" + both.body.id)).body;
check(bothRow.parent_id === yard && bothRow.place_id === null,
  "sending both a parent and a place keeps only the parent");

/* ------------------------------------------------------------- the tree screen */

await boot();
await p.click('nav button[data-view="subjects"]');
await p.waitForTimeout(900);

check(await p.isVisible("#thingsMode"), "the Things tab offers Tree and List");
check(await p.getAttribute('[data-tmode="tree"]', "aria-pressed") === "true", "and opens on the tree");

// .gn, not the heading itself: the heading also carries the + that adds a thing
// straight into that place, and its text would otherwise land in the name.
const groups = await p.$$eval(".tgroup .gn", (n) => n.map((x) => x.textContent.trim()));
check(groups.includes("Home " + TAG) && groups.includes("Rental " + TAG),
  "each place heads its own group");

// The sprinkler is drawn inside the yard's container, not beside it. Checked by
// containment rather than by indentation, which is a style and could be right by
// accident.
const nested = await p.evaluate((ids) => {
  const yardRow = document.querySelector('[data-subject-id="' + ids.yard + '"]');
  const sprRow = document.querySelector('[data-subject-id="' + ids.sprinkler + '"]');
  if (!yardRow || !sprRow) return "missing";
  const kids = yardRow.nextElementSibling;
  return kids && kids.classList.contains("tkids") && kids.contains(sprRow) ? "nested" : "flat";
}, { yard, sprinkler });
check(nested === "nested", `the sprinkler is drawn inside the yard (${nested})`);

// Folding.
await p.click('[data-fold="' + yard + '"]');
await p.waitForTimeout(400);
check(!(await p.isVisible('.trow[data-subject-id="' + sprinkler + '"]')),
  "folding the yard hides what is inside it");
check(await p.isVisible('.trow[data-subject-id="' + yard + '"]'), "and leaves the yard itself");
const hidden = (await api("/api/subjects/" + yard)).body.children.length;
check(await p.textContent('.trow[data-subject-id="' + yard + '"] .tcount') === String(hidden),
  `a folded branch says how many are hidden (${hidden})`);

// Folding is remembered — a branch you closed should not reopen every time the tab
// is repainted, which is on every visit.
await p.click('nav button[data-view="capture"]'); await p.waitForTimeout(400);
await p.click('nav button[data-view="subjects"]'); await p.waitForTimeout(900);
check(!(await p.isVisible('.trow[data-subject-id="' + sprinkler + '"]')),
  "and it stays folded across a repaint");

await p.click('[data-fold="' + yard + '"]');
await p.waitForTimeout(400);
check(await p.isVisible('.trow[data-subject-id="' + sprinkler + '"]'), "unfolding brings it back");

// Tapping the twisty must not also open the thing: the twisty sits inside the row.
check(await p.isHidden("#subject"), "and folding never opened the thing underneath it");

// The flat list still exists.
await p.click('[data-tmode="list"]'); await p.waitForTimeout(400);
check((await p.$$(".tgroup")).length === 0, "List drops the grouping");
check(await p.isVisible('.subj[data-subject-id="' + sprinkler + '"]'),
  "and shows every thing at one level");
await p.click('[data-tmode="tree"]'); await p.waitForTimeout(400);

/* --------------------------------------------------------- a thing's own page */

await p.click('.trow[data-subject-id="' + sprinkler + '"]');
await p.waitForTimeout(900);
check(await p.isVisible("#subject"), "tapping a tree row opens the thing");
check(new RegExp("Home " + TAG + ".*Yard " + TAG).test(await p.textContent(".crumbs")),
  "which carries the path down to it");

await p.click('.crumbs [data-crumb="' + yard + '"]');
await p.waitForTimeout(900);
check(/Yard /.test(await p.textContent(".subjhead h1")), "and the crumb walks back up to the yard");
check(new RegExp("Front sprinkler " + TAG).test(await p.textContent("#subjectBody")),
  "the yard's page lists what is inside it");

/* ------------------------------------------------------------------ moving it */

await p.click('.subj[data-subject-id="' + sprinkler + '"]');
await p.waitForTimeout(900);
await p.click("#editSubject"); await p.waitForTimeout(300);
check(await p.isVisible("#subjHome"), "the edit screen asks where it lives");

const offered = await p.$$eval("#subjHome option", (n) => n.map((o) => o.textContent.trim()));
check(!offered.some((o) => o.includes("Front sprinkler " + TAG)),
  "and never offers to put a thing inside itself");

await p.selectOption("#subjHome", "p:" + rental);
await p.click("#saveSubject"); await p.waitForTimeout(1200);

const moved = (await api("/api/subjects/" + sprinkler)).body;
check(moved.place_id === rental && moved.parent_id === null,
  "moving it to a place clears the parent — one home, never two");
check(moved.path.map((c) => c.name).join(" > ") === "Rental " + TAG,
  `and the path follows it (${moved.path.map((c) => c.name).join(" > ")})`);

/* ----------------------------------------------- deleting a branch's parent */

// Put it back under the yard, then delete the yard: the sprinkler must survive.
await patch("/api/subjects/" + sprinkler, { parent_id: yard });
const before = (await api("/api/subjects/" + sprinkler)).body;
check(before.parent_id === yard, "put back under the yard");

answer = null;                                   // the delete confirm takes no text
await api("/api/subjects/" + yard, { method: "DELETE" });
const orphan = (await api("/api/subjects/" + sprinkler)).body;
check(orphan && orphan.id === sprinkler, "deleting the yard does not delete the sprinkler");
check(orphan.place_id === home && orphan.parent_id === null,
  `it is promoted into whatever the yard was in (place ${orphan.place_id === home ? "Home" : orphan.place_id})`);

/* ------------------------------------------------ deleting a thing's place */

await api("/api/places/" + rental, { method: "DELETE" });
const homeless = (await api("/api/subjects/" + ac)).body;
check(homeless && homeless.id === ac, "removing a place does not remove what was in it");
check(homeless.place_id === null, "the thing simply stops being anywhere in particular");

/* --------------------------------- what lives here is offered first on save */

// Standing at Home, with a note that names nothing: the sprinkler is at Home and
// the air conditioner is nowhere, so the sprinkler should lead.
await boot();
await p.evaluate((id) => {
  // Choose the place the same way the chip does, so this exercises the real state.
  choosePlace(id);
}, home);
// Context is still the sharing boundary and still filters the offer, so it has to
// match the things being looked for. The chip is clicked rather than set, because
// choosePlace only moves context when the place has a history to move it by.
await p.click('[data-ctx="personal"]');
await p.waitForTimeout(400);
await p.fill("#body", "checked it over, all good " + TAG);
await p.click("#save");
await p.waitForTimeout(3800);

// Which things actually live at this run's place, worked out from the API rather
// than assumed: the account holds things from every earlier run, and the offer is
// capped at five, so "the sprinkler is first" is only meaningful against the real set.
const atHome = await p.evaluate(async (placeId) => {
  const rows = (await (await fetch("/api/subjects")).json()).subjects || [];
  const byId = new Map(rows.map((s) => [s.id, s]));
  const rootOf = (s) => { let a = s; for (let i = 0; a && a.parent_id && i < 32; i++) a = byId.get(a.parent_id); return a; };
  return rows.filter((s) => !s.archived_at && (rootOf(s) || {}).place_id === placeId).map((s) => s.name);
}, home);

const offeredFirst = await p.$$eval("#linkChips button", (n) => n.map((b) => b.textContent.trim()));
check(offeredFirst.length > 0, `the link bar offers something (${offeredFirst.length})`);
check(atHome.length > 0 && atHome.some((n) => (offeredFirst[0] || "") === n),
  `what lives where you are is offered first (${offeredFirst[0] || "nothing"}; here: ${atHome.join(", ")})`);
check(!(offeredFirst[0] || "").includes("Air conditioner " + TAG),
  "and a thing that lives nowhere does not lead just because it exists");

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
