// Tag suggestions must follow the caret, not the whole field: a datalist goes
// silent once there is a comma, which is exactly when duplicates get typed.
import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block" });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
await p.goto(B, { waitUntil: "networkidle" });
await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(700);
await p.evaluate(() => applyView("capture"));
await p.waitForTimeout(300);

// A known set of tags, so the assertions do not depend on what the db holds.
await p.evaluate(() => {
  knownTags = [{ name: "automation", count: 9 }, { name: "auto-repair", count: 2 },
    { name: "new-hire", count: 4 }, { name: "corpus", count: 6 }];
});
const chips = () => p.$$eval(".tagsug button", (n) => n.map((x) => x.firstChild.textContent + x.textContent.replace(x.firstChild.textContent, "")).map((t) => t.replace(/\d+$/, "")));
const names = () => p.$$eval(".tagsug [data-tag]", (n) => n.map((x) => x.dataset.tag));

await p.click("#tagsIn");
await p.waitForTimeout(150);
check((await names()).length === 4, "focusing an empty field offers every known tag");
check((await names())[0] === "automation", "most-used tag comes first");

await p.fill("#tagsIn", "auto");
await p.dispatchEvent("#tagsIn", "input");
await p.waitForTimeout(150);
check(JSON.stringify(await names()) === '["automation","auto-repair"]', "typing filters to matches");

// the whole point: a second tag still gets suggestions
await p.fill("#tagsIn", "corpus, new");
await p.dispatchEvent("#tagsIn", "input");
await p.waitForTimeout(150);
check(JSON.stringify(await names()) === '["new-hire"]', "the tag after a comma is matched too");
check(!(await names()).includes("corpus"), "a tag already in the field is not offered again");

// tap a chip
await p.click(".tagsug [data-tag=new-hire]");
await p.waitForTimeout(150);
check(await p.inputValue("#tagsIn") === "corpus, new-hire, ", `chip completes the fragment (got ${await p.inputValue("#tagsIn")})`);
check(await p.evaluate(() => document.activeElement.id) === "tagsIn", "focus stays in the field after a tap");

// duplicates and stray # are tidied on the way out
await p.fill("#tagsIn", "Corpus, #corpus,  new-hire ,");
await p.dispatchEvent("#tagsIn", "input");
await p.evaluate(() => $("tagsIn").blur());
await p.waitForTimeout(150);
check(await p.inputValue("#tagsIn") === "corpus, new-hire", `blur de-duplicates and normalises (got ${await p.inputValue("#tagsIn")})`);
check(await p.isHidden(".tagsug"), "the strip closes on blur");

// the picked day stays bright in the work world
await p.evaluate(() => { cap.kind = "appt"; paintFields(); paintParsed(); });
await p.waitForTimeout(150);
await p.click("#kfields .dtbtn");
await p.waitForTimeout(250);
const world = await p.evaluate(() => document.documentElement.dataset.world);
const [pick, tint] = await p.evaluate(() => {
  const cs = getComputedStyle(document.querySelector(".dtgrid button.on"));
  return [cs.backgroundColor, getComputedStyle(document.documentElement).getPropertyValue("--blue").trim()];
});
check(world === "work", "test runs in the work world");
check(!/^#?2E3A45$/i.test(tint) || pick !== "rgb(46, 58, 69)", `the selected day is not the work charcoal (got ${pick})`);
check(/^rgb\(/.test(pick) && pick !== "rgba(0, 0, 0, 0)", `the selected day has a solid fill (got ${pick})`);
await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
