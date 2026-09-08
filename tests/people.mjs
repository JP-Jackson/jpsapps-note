/**
 * People: their own records, at several places, linked to notes — and the spoken
 * "new item X" / "new person X" path that adds a record from inside a capture.
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
  permissions: ["geolocation"], geolocation: { latitude: 29.0577094, longitude: -96.9786539 } });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
p.on("dialog", (d) => d.accept());

const boot = async () => {
  await p.goto(B, { waitUntil: "networkidle" });
  await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
  await p.reload({ waitUntil: "networkidle" });
await p.click('nav [data-view="capture"]');
await p.waitForTimeout(300);
  await p.waitForTimeout(1200);
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
const del = (path) => api(path, { method: "DELETE" });

/* ------------------------------------------------------------------ words */
check((await p.locator('nav [data-view="subjects"]').textContent()).trim() === "Places",
  "the tab is called Places");
await p.click('nav [data-view="subjects"]');
await p.waitForTimeout(600);
check((await p.locator("#addSubject").innerText()).includes("item"), "the add button says item, not thing");
check(await p.locator('[data-tmode="people"]').isVisible(), "People is a mode on the Places tab");

/* ------------------------------------------------- a person at two places */
const lease = (await post("/api/places", { name: "zzLease " + TAG, lat: 29.2, lng: -96.8 })).body.id;
const battery = (await post("/api/places", { name: "zzBattery " + TAG, lat: 29.3, lng: -96.7 })).body.id;
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(800);
await p.click('nav [data-view="capture"]');
await p.waitForTimeout(300);
// Boot lands on Today when online (§ the landing choice in boot()); every check
// below is about the capture screen, so go there first.
await p.click('nav [data-view="capture"]');
await p.waitForTimeout(300);
await p.click('nav [data-view="subjects"]');
await p.click('[data-tmode="people"]');
await p.click("#addSubject");
await p.fill("#pName", "Dana " + TAG);
await p.fill("#pRole", "Foreman");
await p.fill("#pPhone", "432-555-0100");
await p.click('[data-pctx="work"]');
await p.click('[data-pp="' + lease + '"]');
await p.click('[data-pp="' + battery + '"]');
await p.click("#savePerson");
await p.waitForSelector("#noteWith", { timeout: 8000 });
const personText = await p.locator("#personBody").innerText();
check(personText.includes("zzLease " + TAG) && personText.includes("zzBattery " + TAG),
  "the person page lists both places");
check(personText.includes("432-555-0100"), "the phone number is on the page");
const people = (await api("/api/people")).body.people;
const dana = people.find((x) => x.name === "Dana " + TAG);
// "Includes", not "equals two": a new person is preset to the place you are
// standing in, and a leftover place near the test coordinates would be a third.
check(dana && [lease, battery].every((id) => dana.place_ids.includes(id)) && dana.context === "work",
  "the API holds both place links");

/* ------------------------------------------- + Note from the person page */
await p.click("#noteWith");
await p.waitForTimeout(400);
check(await p.locator("#againstChip").isVisible() &&
  (await p.locator("#againstChip").innerText()).includes("Dana " + TAG), "+ Note presets the link");
await p.fill("#body", "Walked the site with the foreman " + TAG);
await p.click("#save");
await p.waitForTimeout(2500);
const withDana = (await api("/api/people/" + dana.id)).body;
check(withDana.entries.some((e) => (e.body || "").includes("foreman " + TAG)),
  "the note lands in the person's history");

/* -------------------------------------------- the link bar offers people */
await p.click('[data-ctx="work"]');
await p.fill("#body", "Dana " + TAG + " says the pump is loud");
await p.click("#save");
await p.waitForSelector("#linkBar:not([hidden])", { timeout: 5000 });
const chip = p.locator('#linkChips [data-kind="person"]', { hasText: "Dana " + TAG });
check(await chip.count() === 1, "a person named in the note is offered as a link");
await chip.click();
await p.waitForTimeout(2500);
const nowDana = (await api("/api/people/" + dana.id)).body;
check(nowDana.entries.some((e) => (e.body || "").includes("pump is loud")),
  "tapping the chip links the note to the person");

/* ------------------------------------------- spoken "new item" and "new person" */
await p.fill("#body", "New item Widget " + TAG + ". Squeaks on start. New person Bob " + TAG + ", operator.");
await p.click("#save");
await p.waitForTimeout(2500);
const found = (await api("/api/lookup?q=" + encodeURIComponent(TAG))).body;
const widget = found.items.find((x) => x.name === "Widget " + TAG);
const bob = found.people.find((x) => x.name === "Bob " + TAG);
check(!!widget, "\"new item X\" in a note adds the item");
check(widget && widget.context === "work" && widget.type === "equipment", "a work item is equipment by default");
check(!!bob, "\"new person X\" in a note adds the person");
const wd = widget && (await api("/api/subjects/" + widget.id)).body;
check(wd && wd.entries.some((e) => (e.body || "").includes("Squeaks")), "the note is linked to the new item");
const bd = bob && (await api("/api/people/" + bob.id)).body;
check(bd && bd.entries.length === 1, "and to the new person");

// Saying it again links the existing record rather than making a twin.
await p.fill("#body", "New item Widget " + TAG + ". Still squeaks.");
await p.click("#save");
await p.waitForTimeout(2500);
const again = (await api("/api/lookup?q=" + encodeURIComponent("Widget " + TAG))).body;
check(again.items.length === 1, "a second \"new item\" with the same name does not duplicate it");
check((await api("/api/subjects/" + widget.id)).body.entries.length === 2, "it links the existing one");

/* ------------------------------------------------------------ search */
await p.click('nav [data-view="search"]');
await p.fill("#q", TAG);
await p.waitForTimeout(1200);
const list = await p.locator("#searchList").innerText();
check(list.includes("Widget " + TAG) && list.includes("Dana " + TAG), "search finds items and people by name");
const detailRow = p.locator("#searchList .entry", { hasText: "pump is loud" });
await detailRow.click();
await p.waitForSelector("#saveEdit", { timeout: 8000 });
check((await p.locator("#detailBody").innerText()).includes("Dana " + TAG), "the entry page names the person");
await p.click("#detailBack");

/* ------------------------------------------------------------ delete */
const gone = await del("/api/people/" + dana.id);
check(gone.status === 200, "a person can be removed");
check((await api("/api/people/" + dana.id)).status === 404, "and is gone");
const stillThere = (await api("/api/entries?view=search&q=" + encodeURIComponent("pump is loud"))).body.entries;
check(stillThere.length >= 1, "their notes survive");

/* ------------------------------------------------------------ cleanup */
if (bob) await del("/api/people/" + bob.id);
if (widget) await del("/api/subjects/" + widget.id);
await del("/api/places/" + lease);
await del("/api/places/" + battery);

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
