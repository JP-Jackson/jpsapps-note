import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };

// Run-scoped: the subject this attaches to must be this run's, not one left behind.
const TAG = "run" + Math.random().toString(36).slice(2, 8);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block" });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
await p.goto(B, { waitUntil: "networkidle" });
await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(700);
await p.click('nav [data-view="capture"]');
await p.waitForTimeout(300);
// Boot lands on Today when online (§ the landing choice in boot()); every check
// below is about the capture screen, so go there first.
await p.click('nav [data-view="capture"]');
await p.waitForTimeout(300);

// ---------- attach at capture, OFFLINE, so it must ride the queue ----------
await ctx.setOffline(true);
await p.evaluate(() => window.dispatchEvent(new Event("offline")));
await p.setInputFiles("#docPick", ["/tmp/fx/IR-2475-manual.pdf", "/tmp/fx/points.csv"]);
await p.waitForTimeout(300);
check(await p.isVisible("#pending"), "capture shows what is attached");
check(/2 files attached/.test(await p.textContent("#pending")), `names the count (got "${(await p.textContent("#pending")).trim()}")`);

await p.fill("#body", "pulled the manual and the point list");
await p.click("#save");
await p.waitForTimeout(3500);      // coords() waits up to 2.5s for a fix before the write
check(await p.isHidden("#pending"), "attachment list clears after save");
const queued = await p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("note", 2);
  r.onsuccess = () => r.result.transaction("queue").objectStore("queue").getAll().onsuccess = (e) => res(e.target.result);
}));
check((queued[0]?.files || []).length === 2, `both files are durable in the queue offline (${(queued[0]?.files || []).length})`);

// ---------- back online: they should upload behind the entry ----------
await ctx.setOffline(false);
await p.evaluate(() => window.dispatchEvent(new Event("online")));
await p.waitForTimeout(3000);
const landed = await p.evaluate(async () => {
  const recent = await (await fetch("/api/entries")).json();
  const mine = recent.entries.find((e) => /point list/.test(e.body || ""));
  const d = await (await fetch("/api/entries/" + mine.id)).json();
  return d.files.map((f) => f.title);
});
check(landed.length === 2 && landed.includes("IR-2475-manual.pdf"),
  `queued files uploaded after the entry (${JSON.stringify(landed)})`);

// ---------- they render as download links on the entry ----------
await p.click('nav button[data-view="log"]');
await p.waitForTimeout(700);
// Its own note, not the first of the day: a seeded or leftover entry earlier
// today would otherwise be the one opened (tests/README.md).
await p.locator('#dayList .entry', { hasText: 'point list' }).first().click();
await p.waitForTimeout(800);
const links = await p.$$eval(".file", (n) => n.map((a) => [a.textContent.trim(), a.getAttribute("href"), a.hasAttribute("download")]));
check(links.length === 2, `entry detail lists both files (${links.length})`);
check(links.every(([, href, dl]) => /^\/api\/files\//.test(href) && dl),
  "files link through the Worker and are marked download");

// ---------- attach to a thing ----------
await p.evaluate(() => history.back());
await p.waitForTimeout(500);
const sub = await p.evaluate(async (tag) => {
  const r = await fetch("/api/subjects", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Attach Target " + tag, type: "equipment", context: "work" }) });
  return (await r.json()).id;
}, TAG);
await p.click('nav button[data-view="subjects"]');
await p.waitForTimeout(800);
// By id: the list carries subjects left by every earlier run.
await p.click(`[data-subject-id="${sub}"]`);
await p.waitForSelector("#attachHere", { timeout: 4000 });
const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.click("#attachHere")]);
await chooser.setFiles("/tmp/fx/b44-log.html");
await p.waitForTimeout(2500);
// Scoped to the overlay: the entry detail is still in the DOM behind it, and an
// unscoped .file would happily pass on the wrong overlay's files.
const subjFiles = await p.$$eval("#subject .file .ft", (n) => n.map((x) => x.textContent.trim()));
check(subjFiles.length === 1 && subjFiles[0] === "b44-log.html",
  `the thing shows only its own file (${JSON.stringify(subjFiles)})`);

// ---------- the HTML file downloads, it does not render ----------
const res = await p.evaluate(async () => {
  const a = document.querySelector("#subject .file");   // the HTML one, specifically
  const r = await fetch(a.getAttribute("href"));
  return { cd: r.headers.get("content-disposition"), csp: r.headers.get("content-security-policy"),
           nosniff: r.headers.get("x-content-type-options"),
           type: r.headers.get("content-type"), body: (await r.text()).slice(0, 40) };
});
check(/^attachment/.test(res.cd || ""), `served as a download, not inline (${res.cd})`);
check(/sandbox/.test(res.csp || ""), `sandboxed by CSP (${res.csp})`);
check(res.nosniff === "nosniff", "nosniff set");
check(/text\/html/.test(res.type || ""), `and it really is the HTML file (${res.type})`);
check(/<script>/.test(res.body || ""), "script tags come back untouched — inert only because it downloads");

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
