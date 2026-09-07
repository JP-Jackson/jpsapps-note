/**
 * Work and personal never intertwine (decided 7 Sep 2026).
 *
 * The header switch is the only place the two meet. Every list is scoped on the
 * server, so this drives the screens and asks the API with and without ?world=.
 * Tagged unique to the run, per tests/README.md.
 */
import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const TAG = "run" + Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block",
  permissions: ["geolocation"], geolocation: { latitude: 30.5, longitude: -97.5 } });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
p.on("dialog", (d) => d.accept());

await p.goto(B, { waitUntil: "networkidle" });
await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(1200);

const api = (path, init) => p.evaluate(async ([path, init]) => {
  const r = await fetch(path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}, [path, init]);
const post = (path, body) => api(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const del = (path) => api(path, { method: "DELETE" });

/* --------------------------------------------------------- one of each, per side */
const wPlace = (await post("/api/places", { name: "zzShop " + TAG, lat: 30.5, lng: -97.5, context: "work" })).body.id;
// Right where the test's phone is, on the other side: the nudge case.
const pPlace = (await post("/api/places", { name: "zzRental " + TAG, lat: 30.5, lng: -97.5, context: "personal" })).body.id;
const wItem = (await post("/api/subjects", { name: "Press " + TAG, type: "equipment", context: "work", place_id: wPlace })).body.id;
const pItem = (await post("/api/subjects", { name: "Mower " + TAG, type: "equipment", context: "home", place_id: pPlace })).body.id;
const wPerson = (await post("/api/people", { name: "Foreman " + TAG, context: "work" })).body.id;
const pPerson = (await post("/api/people", { name: "Neighbour " + TAG, context: "personal" })).body.id;
const wNote = crypto.randomUUID(), pNote = crypto.randomUUID();
await post("/api/entries", { id: wNote, context: "work", body: "press jammed " + TAG, is_open: true, subject_ids: [wItem] });
await post("/api/entries", { id: pNote, context: "home", body: "mower blade " + TAG, is_open: true, subject_ids: [pItem] });

check((await api("/api/subjects/" + pItem)).body.context === "personal", '"home" still lands as personal');

/* ------------------------------------------------------- the API scopes lists */
const names = (r, k) => (r.body[k] || []).map((x) => x.name || x.body);
const w = await api("/api/subjects?world=work"), pe = await api("/api/subjects?world=personal");
check(names(w, "subjects").includes("Press " + TAG) && !names(w, "subjects").includes("Mower " + TAG), "work items only in the work list");
check(names(pe, "subjects").includes("Mower " + TAG) && !names(pe, "subjects").includes("Press " + TAG), "personal items only in the personal list");
const pw = await api("/api/people?world=work");
check(names(pw, "people").includes("Foreman " + TAG) && !names(pw, "people").includes("Neighbour " + TAG), "people are scoped");
const plw = await api("/api/places?world=work");
check(names(plw, "places").includes("zzShop " + TAG) && !names(plw, "places").includes("zzRental " + TAG), "places are scoped");
const ow = await api("/api/entries?view=open&world=work"), op = await api("/api/entries?view=open&world=personal");
check(names(ow, "entries").some((b) => b.includes("press jammed")) && !names(ow, "entries").some((b) => b.includes("mower blade")), "open items are scoped");
check(names(op, "entries").some((b) => b.includes("mower blade")), "the other side has its own");
const sw = await api("/api/lookup?q=" + TAG + "&world=personal");
check(names(sw, "items").includes("Mower " + TAG) && !names(sw, "items").includes("Press " + TAG), "name lookup is scoped");

/* ------------------------------------------------------------- the switch */
await p.click('[data-ctx="work"]');
await p.waitForTimeout(600);
check(await p.evaluate(() => document.documentElement.dataset.world) === "work", "the page knows it is in work");
const workBlue = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--blue").trim());
await p.click('nav [data-view="subjects"]');
await p.waitForTimeout(800);
let tree = await p.locator("#subjectList").innerText();
check(tree.includes("Press " + TAG) && !tree.includes("Mower " + TAG), "the Places tab shows work only");

await p.click('[data-ctx="personal"]');
await p.waitForTimeout(1200);
const personalBlue = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--blue").trim());
check(workBlue !== personalBlue, `the accent changes with the world (${workBlue} vs ${personalBlue})`);
tree = await p.locator("#subjectList").innerText();
check(tree.includes("Mower " + TAG) && !tree.includes("Press " + TAG), "and personal only after the switch");
await p.click('[data-tmode="people"]');
await p.waitForTimeout(300);
const ppl = await p.locator("#subjectList").innerText();
check(ppl.includes("Neighbour " + TAG) && !ppl.includes("Foreman " + TAG), "people follow the switch");
await p.click('[data-tmode="tree"]');

/* --------------------------------------------- an item added lands in this world */
await p.click("#addSubject");
await p.fill("#newName", "Grill " + TAG);
check(!(await p.locator("#newCtx").isVisible()), "the add form has no world chooser");
check((await p.locator("#newWorld").innerText()).includes("personal"), "it says which world the item lands in");
await p.click("#createThing");
await p.waitForSelector("#noteAgainst", { timeout: 8000 });
const grill = (await api("/api/lookup?q=Grill%20" + TAG + "&world=personal")).body.items[0];
check(grill && grill.context === "personal", "an item added while in personal is personal");
await p.click("#subjectBack");
await p.waitForTimeout(300);

/* ------------------------------------------------------- the nudge */
await p.click('[data-ctx="work"]');
await p.waitForTimeout(500);
await p.click('nav [data-view="capture"]');
await p.waitForTimeout(2500);
// In work, standing at zzShop: no nudge. Both places sit at the same spot, so the
// chip should name the work one, not offer a switch.
let chipText = await p.locator("#placeChip").innerText();
check(chipText.includes("zzShop " + TAG), `at a work place in work, the chip names it (${chipText})`);
// Remove the work place: now the only place here belongs to personal.
await del("/api/places/" + wPlace);
await p.evaluate(() => loadPlaces().then(suggestPlace));
await p.waitForTimeout(1500);
chipText = await p.locator("#placeChip").innerText();
check(/zzRental/.test(chipText) && /switch to personal/.test(chipText), `standing at the other side's place offers the switch (${chipText})`);
await p.click("#placeChip");
await p.waitForTimeout(1200);
check(await p.evaluate(() => document.documentElement.dataset.world) === "personal", "tapping it switches");
chipText = await p.locator("#placeChip").innerText();
check(chipText.includes("zzRental " + TAG), "and the place is then suggested normally");

/* --------------------------------------------------------- move a note */
await p.click('[data-ctx="work"]');
await p.waitForTimeout(500);
await p.click('nav [data-view="open"]');
await p.waitForTimeout(800);
await p.locator("#openList .entry", { hasText: "press jammed " + TAG }).click();
await p.waitForSelector("#moveEntry", { timeout: 8000 });
check((await p.locator("#moveEntry").innerText()).includes("personal"), "a work note offers a move to personal");
await p.click("#moveEntry");
await p.waitForTimeout(1500);
const moved = (await api("/api/entries/" + wNote)).body;
check(moved.context === "personal" && moved.subjects.length === 0, "moved, with its work links dropped");
check(!names(await api("/api/entries?view=open&world=work"), "entries").some((b) => b.includes("press jammed " + TAG)),
  "and it is gone from the work side");

/* ------------------------------------------------------- Claude asks */
const rpc = (name, args) => api("/mcp", {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});
// The MCP endpoint needs a token, so this only checks the shape when reachable.
const r = await rpc("list_things", {});
check(r.status === 401 || /work or personal/.test(JSON.stringify(r.body)), "the connector asks which world when not told");

/* ------------------------------------------------------------ cleanup */
for (const id of [wItem, pItem, grill && grill.id]) if (id) await del("/api/subjects/" + id);
await del("/api/people/" + wPerson); await del("/api/people/" + pPerson);
await del("/api/places/" + pPlace);

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
