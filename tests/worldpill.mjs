// The world switch: one pill in the chrome, plus a sideways swipe. Work sits
// left of personal, so dragging left goes to personal and right comes back.
import { chromium } from "playwright";
const B = process.env.NOTE_URL || "http://127.0.0.1:8787";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 },
  serviceWorkers: "block", hasTouch: true, isMobile: true });
const p = await ctx.newPage();
p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
await p.goto(B, { waitUntil: "networkidle" });
await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(700);

check(await p.$("#chips") === null, "the full-width world strip is gone");
const hdr = await p.$eval("header", (n) => n.getBoundingClientRect().height);
check(hdr < 90, `the header is back to one row (${Math.round(hdr)}px)`);
check((await p.textContent("#worldPill")).trim() === "work", "the pill names the world you are in");

const swipe = async (from, to) => p.evaluate(([a, b]) => {
  const t = (x) => [{ identifier: 1, target: document.querySelector("main"), clientX: x, clientY: 500 }];
  const mk = (type, pts) => new TouchEvent(type, { bubbles: true, cancelable: true,
    touches: type === "touchend" ? [] : pts.map((q) => new Touch(q)),
    changedTouches: pts.map((q) => new Touch(q)) });
  const main = document.querySelector("main");
  main.dispatchEvent(mk("touchstart", t(a)));
  main.dispatchEvent(mk("touchend", t(b)));
}, [from, to]);

await swipe(330, 60);      // drag left
await p.waitForTimeout(500);
check((await p.textContent("#worldPill")).trim() === "personal", "swiping left goes to personal");
await swipe(60, 330);      // drag right
await p.waitForTimeout(500);
check((await p.textContent("#worldPill")).trim() === "work", "swiping right comes back to work");

await swipe(330, 300);     // too short
await p.waitForTimeout(300);
check((await p.textContent("#worldPill")).trim() === "work", "a short drag is not a swipe");

await p.click("#worldPill");
await p.waitForTimeout(500);
check((await p.textContent("#worldPill")).trim() === "personal", "tapping the pill switches too");
check(await p.evaluate(() => document.documentElement.dataset.world) === "personal", "the world tint follows");
await p.click("#worldPill");
await p.waitForTimeout(400);

// an open sheet owns the gesture
await p.evaluate(() => applyView("capture"));
await p.waitForTimeout(300);
await p.evaluate(() => { cap.kind = "appt"; paintFields(); paintParsed(); });
await p.waitForTimeout(150);
await p.click("#kfields .dtbtn");
await p.waitForTimeout(300);
await swipe(330, 60);
await p.waitForTimeout(400);
check((await p.textContent("#worldPill")).trim() === "work", "a swipe over an open sheet does not switch worlds");
await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
