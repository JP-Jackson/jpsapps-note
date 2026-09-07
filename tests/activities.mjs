import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block" });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
p.on("dialog", (d) => d.accept());
// Every run leaves rows behind, so anything matched by text needs to be unique to
// this run -- otherwise find() picks up a previous run's entry and the mismatch
// looks like a bug in the app rather than in the test.
const TAG = "run" + Math.random().toString(36).slice(2, 8);

const boot = async () => {
  await p.goto(B, { waitUntil: "networkidle" });
  await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(900);
};
const api = (u, o) => p.evaluate(async ([u, o]) => {
  const r = await fetch(u, o); let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}, [u, o || {}]);
const start = (label, opts) => api("/api/activities", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ label, context: "work", ...opts }) });

await boot();
// clean slate for activities
await p.evaluate(async () => {
  const b = new Date(); b.setHours(0,0,0,0);
  const list = (await (await fetch("/api/activities?from=" + (b.getTime() - 7*864e5) + "&to=" + (Date.now() + 864e5))).json()).activities || [];
  for (const a of list) if (!a.ended_at) await fetch("/api/activities/" + a.id + "/end", { method: "POST" });
});
await boot();

// ---------- nothing running ----------
check(await p.isVisible("#actStrip"), "the strip is on the capture screen");
check(/Nothing running/.test(await p.textContent("#actStrip")), "and says nothing is running");

// ---------- start, then nest ----------
const root = (await start("At the shop")).body;
await boot();
check(/At the shop/.test(await p.textContent("#actStrip")), "starting one shows it in the strip");
check(/\d+m|\dh/.test(await p.textContent("#actStrip")), "with elapsed time");

const child = (await start("Compressor 2 — contactor", { nest: true })).body;
await boot();
const strip = await p.textContent("#actStrip");
check(/At the shop.*Compressor 2/.test(strip), `nested shows parent then child (${strip.trim()})`);
check(child.parent_id === root.id, "and the child records its parent");

// ---------- a capture is stamped with what was running ----------
await p.fill("#body", "swapped the contactor " + TAG);
await p.click("#save"); await p.waitForTimeout(3500);
const stamped = await p.evaluate(async (tag) => {
  const e = (await (await fetch("/api/entries")).json()).entries.find((x) => (x.body || "").includes(tag));
  return (await (await fetch("/api/entries/" + e.id)).json()).activity_id;
}, TAG);
check(stamped === child.id, "the note is stamped with the running activity, not the parent");
const label = await p.evaluate(async (tag) => {
  const e = (await (await fetch("/api/entries")).json()).entries.find((x) => (x.body || "").includes(tag));
  return (await (await fetch("/api/entries/" + e.id)).json()).activity_label;
}, TAG);
check(label === "Compressor 2 — contactor", `and the detail names it rather than showing an id (${label})`);

// ---------- ending the child hands back to the parent ----------
await api("/api/activities/" + child.id + "/end", { method: "POST" });
let cur = (await api("/api/activities/current")).body;
check(cur.current.id === root.id && cur.parent === null,
  "ending the child makes its parent current again");

// ---------- ending a parent ends its children too ----------
const r2 = (await start("Second site")).body;
const c2 = (await start("Panel swap", { nest: true })).body;
await api("/api/activities/" + r2.id + "/end", { method: "POST" });
const after = await api("/api/activities/current");
check(after.body.current === null, "ending the root leaves nothing running");
const kid = await p.evaluate(async (id) => {
  const b = new Date(); b.setHours(0,0,0,0);
  const l = (await (await fetch("/api/activities?from=" + b.getTime() + "&to=" + (Date.now()+864e5))).json()).activities;
  return l.find((a) => a.id === id);
}, c2.id);
check(kid && kid.ended_at !== null, "a child cannot outlive its parent — it closed too");

// starting a new top-level one closed the previous root
const closedRoot = await p.evaluate(async (id) => {
  const b = new Date(); b.setHours(0,0,0,0);
  const l = (await (await fetch("/api/activities?from=" + b.getTime() + "&to=" + (Date.now()+864e5))).json()).activities;
  return (l.find((a) => a.id === id) || {}).ended_at;
}, root.id);
check(closedRoot !== null && closedRoot !== undefined, "starting a new top-level one closed the old stack");

// ---------- the prompt after a capture with nothing running ----------
await boot();
check(await p.isHidden("#actPrompt"), "no prompt before anything happens");
await p.fill("#body", "note with nothing running " + TAG);
await p.click("#save"); await p.waitForTimeout(3800);
check(await p.isVisible("#actPrompt"), "capturing with nothing running asks about the day's start");
const promptText = await p.textContent("#actPrompt");
check(/When did you start today/.test(promptText), `and asks the §11 question (${promptText.split("When")[0].trim()}…)`);
const opts = await p.$$eval("#actPrompt button", (n) => n.map((x) => x.textContent.trim()));
check(opts.length >= 4 && /Just now/.test(opts.join("|")), `offering times plus "just now" (${JSON.stringify(opts)})`);
check(await p.isHidden("#actStrip"), "the prompt replaces the strip rather than stacking on it");

await p.click('#actPrompt button:has-text("Just now")'); await p.waitForTimeout(1200);
check(await p.isHidden("#actPrompt"), "answering dismisses it");
check(/At work/.test(await p.textContent("#actStrip")), "and starts one named from the context");

// ---------- a backdated start ----------
const backdated = (await api("/api/activities/current")).body.current;
await api("/api/activities/" + backdated.id + "/end", { method: "POST" });
const twoHoursAgo = await p.evaluate(() => Date.now() - 2 * 3600e3);
await start("Backdated", { started_at: twoHoursAgo });
await boot();
check(/1h 5[0-9]m|2h 0[0-9]m/.test(await p.textContent("#actStrip")),
  `a backdated start shows the real elapsed time (${(await p.textContent("#actStrip")).trim()})`);

// ---------- removing one started by mistake ----------
{
  const oops = (await start("Started by mistake " + TAG)).body;
  const kept = await p.evaluate(async (tag) => {
    const id = crypto.randomUUID();
    await fetch("/api/entries", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, created_at: Date.now(), context: "work",
        body: "note during the mistake " + tag, activity_id: (await (await fetch("/api/activities/current")).json()).current.id }) });
    return id;
  }, TAG);
  check((await api("/api/entries/" + kept)).body.activity_id === oops.id, "a note was stamped with it");

  await boot();
  await p.click("#actStrip"); await p.waitForSelector("[data-delact]", { timeout: 4000 });
  await p.click(`[data-delact="${oops.id}"]`); await p.waitForTimeout(1200);
  check((await api("/api/activities/current")).body.current === null, "removing it leaves nothing running");
  const note = await api("/api/entries/" + kept);
  check(note.status === 200, "the note captured during it survives");
  check(note.body.activity_id === null, "with only its stamp cleared");
  await p.evaluate(() => history.back()); await p.waitForTimeout(400);
}

// ---------- the date format, everywhere it is written out ----------
{
  const WANT = /^[A-Z][a-z]+day, \d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} (AM|PM)$/;
  await p.evaluate(async (tag) => {
    await fetch("/api/entries", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), created_at: Date.now(), context: "work",
        body: "format check " + tag }) });
  }, TAG);
  await boot();
  await p.click('nav button[data-view="log"]'); await p.waitForTimeout(900);
  const heading = (await p.textContent("#dayLabel")).trim();
  check(/^[A-Z][a-z]+day, \d{1,2}\/\d{1,2}\/\d{4}$/.test(heading) || heading === "Today",
    `the day heading reads as a date (${heading})`);
  await p.click(`#dayList .entry:has-text("format check ${TAG}")`); await p.waitForTimeout(900);
  const when = await p.$$eval("#detailBody .meta dd", (n) => n.map((x) => x.textContent.trim()));
  check(WANT.test(when[0]), `entry detail shows "Monday, 9/7/2026 1:10 PM" form (${when[0]})`);
}

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
