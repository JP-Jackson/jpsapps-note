import { chromium } from "playwright";
const B = "http://127.0.0.1:8791";
const ok = (c, m) => console.log((c ? "  PASS  " : "  FAIL  ") + m);
let fails = 0;
const check = (c, m) => { if (!c) fails++; ok(c, m); };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 },
  permissions: [], serviceWorkers: "block" });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });

await p.goto(B, { waitUntil: "networkidle" });
await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(800);

// ---------------------------------------------------------------- contexts
const chips = await p.$$eval("#chips .chip", (n) => n.map((x) => x.textContent.trim()));
check(JSON.stringify(chips) === '["Work","Home"]', `capture chips are Work/Home only (got ${JSON.stringify(chips)})`);

// ------------------------------------------------------- create two things
for (const [name, type, ctxv] of [["White truck","vehicle","work"],["Shop Compressor","equipment","work"]]) {
  await p.evaluate(async ([n,t,c]) => {
    await fetch("/api/subjects", { method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({ name:n, type:t, context:c }) });
  }, [name, type, ctxv]);
}
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(600);

// ------------------------------------- no pre-save picker, no bar until saved
check(await p.$("#subjChips") === null, "pre-save subject picker is gone");
check(await p.isHidden("#linkBar"), "link bar hidden before any save");

// ---------------------------------------------- capture a note naming a thing
await p.fill("#body", "truck wouldn't start this morning, jumped it");
await p.click("#save");
await p.waitForSelector("#linkBar:not([hidden])", { timeout: 4000 });
const cands = await p.$$eval("#linkChips .chip", (n) => n.map((x) => x.textContent.trim()));
check(cands[0] === "White truck", `"truck" ranks White truck first (got ${JSON.stringify(cands)})`);
check(await p.inputValue("#body") === "", "textarea cleared — the note saved first");

// ------------------------------------------------------------- tap to link
await p.click('#linkChips [data-link]');
await p.waitForTimeout(1200);
const linked = await p.evaluate(async () => {
  const r = await fetch("/api/subjects");
  const subs = (await r.json()).subjects;
  const t = subs.find((s) => s.name === "White truck");
  const d = await (await fetch("/api/subjects/" + t.id)).json();
  return d.entries.map((e) => e.body);
});
check(linked.length === 1 && /wouldn't start/.test(linked[0]), `link landed on the thing (${JSON.stringify(linked)})`);

// --------------------------------------------------- + Note from a thing page
await p.click('nav button[data-view="subjects"]');
await p.waitForTimeout(500);
await p.click('[data-subject-id]:has-text("Shop Compressor")');
await p.waitForSelector("#noteAgainst", { timeout: 4000 });
await p.click("#noteAgainst");
await p.waitForTimeout(500);
check(await p.isVisible("#againstChip"), "capture shows the 'Against …' chip");
const against = (await p.textContent("#againstChip")).trim();
check(/Shop Compressor/.test(against), `chip names the thing (got "${against}")`);
check(await p.isVisible("#view-capture"), "landed on the capture screen");

await p.fill("#body", "replaced the pressure switch");
await p.click("#save");
await p.waitForTimeout(1500);
check(await p.isHidden("#againstChip"), "'Against' chip clears after saving");
const comp = await p.evaluate(async () => {
  const subs = (await (await fetch("/api/subjects")).json()).subjects;
  const c = subs.find((s) => s.name === "Shop Compressor");
  return (await (await fetch("/api/subjects/" + c.id)).json()).entries.map((e) => e.body);
});
check(comp.length === 1 && /pressure switch/.test(comp[0]), `pre-linked note landed (${JSON.stringify(comp)})`);
check(await p.isHidden("#linkBar"), "no link bar offered when it was already linked");

// ---- back button after "+ Note": one step back, no stray history entry ----
await p.goBack();
await p.waitForTimeout(600);
check(await p.isVisible("#view-subjects"), "back from +Note capture returns to the Subjects list");
check(await p.isHidden("#subject"), "the thing overlay is not re-shown");
await p.goBack();
await p.waitForTimeout(600);
check(await p.isVisible("#view-capture"), "one more back reaches Capture, not a dead entry");

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
