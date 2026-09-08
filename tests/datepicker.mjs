// The month-grid date picker: it must open, pick, and hand back the same ISO
// string the native input used to, or every field that reads one breaks quietly.
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

// capture an appointment line so the datetime fields render
await p.evaluate(() => applyView("capture"));
await p.waitForTimeout(300);
await p.fill("#body", "Meet Bob tomorrow at 2pm");
await p.waitForTimeout(400);
await p.evaluate(() => { cap.kind = "appt"; paintFields(); paintParsed(); });
await p.waitForTimeout(200);
const btns = await p.$$("#kfields .dtbtn");
check(btns.length === 2, `appt shows two date buttons (got ${btns.length})`);
check(await p.$("#kfields input[type=datetime-local]") === null, "no native datetime-local input left");
await btns[0].click();
await p.waitForTimeout(200);
check(await p.isVisible("#dtpick"), "picker sheet opens");
const dow = await p.$$eval(".dtdow span", (n) => n.map((x) => x.textContent));
check(dow.join(",") === "Sun,Mon,Tue,Wed,Thu,Fri,Sat", "weekday header row present");
check((await p.$$(".dtgrid button")).length === 42, "six-week month grid");
check(await p.isVisible("#dtTime"), "time row shown for datetime fields");
// pick the 15th of the shown month, set 3:30 PM
await p.click(".dtquick [data-jump='0']");
const month = await p.textContent("#dtMonth");
await p.$$eval(".dtgrid button", (n) => n.find((x) => !x.classList.contains("out") && x.textContent === "15").click());
await p.selectOption("#dtHour", "3"); await p.selectOption("#dtMin", "30"); await p.selectOption("#dtAp", "PM");
await p.click("#dtSet");
await p.waitForTimeout(250);
check(await p.isHidden("#dtpick"), "sheet closes on Set");
const v = await p.$eval("#kfields [data-f=starts]", (n) => n.value);
check(/^\d{4}-\d{2}-15T15:30$/.test(v), `hidden input holds ISO value (got ${v})`);
const lbl = await p.textContent("#kfields .dtbtn");
check(/15.*3:30 PM/.test(lbl), `button shows the date in words (got ${lbl})`);
check(await p.evaluate(() => cap.touched.starts) === v, "the input event still reached the capture state");
// back gesture closes only the sheet
await p.click("#kfields .dtbtn");
await p.waitForTimeout(200);
await p.goBack();
await p.waitForTimeout(300);
check(await p.isHidden("#dtpick"), "back closes the sheet");
check(await p.isVisible("#view-capture"), "back leaves the capture screen up");
// date-only field: no time row
await p.evaluate(() => { cap.kind = "todo"; paintFields(); });
await p.click("#kfields .dtbtn");
await p.waitForTimeout(200);
check(await p.isHidden("#dtTime"), "no time row on a date-only field");
await p.click("#dtSet");
await p.waitForTimeout(250);
const dv = await p.$eval("#kfields [data-f=due]", (n) => n.value);
check(/^\d{4}-\d{2}-\d{2}$/.test(dv), `date-only field stays date-only (got ${dv})`);
await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
