import { chromium } from "playwright";
const B = "http://127.0.0.1:8792";
let fails = 0;
const check = (c, m) => { if (!c) fails++; console.log((c ? "  PASS  " : "  FAIL  ") + m); };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block", ...opts });
  if (opts.standalone) {
    await ctx.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => /display-mode:\s*standalone/.test(q)
        ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
        : real(q);
    });
  }
  const p = await ctx.newPage();
  p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
  await p.goto(B, { waitUntil: "networkidle" });
  await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(600);
  return { ctx, p };
}
const settings = async (p) => { await p.click("#gear"); await p.waitForTimeout(500); };

// ---------------- 1. plain desktop Chromium: no event, no iOS ----------------
{
  const { ctx, p } = await open();
  await settings(p);
  const t = await p.textContent("#install");
  check(/Install app|Add to Home screen/.test(t), "no prompt available -> points at the browser menu");
  check(await p.$("#doInstall") === null, "and shows no button that could not work");
  await ctx.close();
}

// ---------------- 2. a real beforeinstallprompt, synthesised ----------------
{
  const { ctx, p } = await open();
  const fired = await p.evaluate(() => {
    window.__promptCalls = 0;
    const e = new Event("beforeinstallprompt");
    e.prompt = () => { window.__promptCalls++; return Promise.resolve(); };
    Object.defineProperty(e, "userChoice", { value: Promise.resolve({ outcome: "accepted" }) });
    dispatchEvent(e);
    return !!window.__install;
  });
  check(fired, "the head script catches the event and stashes it");
  await settings(p);
  check(await p.isVisible("#doInstall"), "Settings offers a real Add to home screen button");
  await p.click("#doInstall");
  await p.waitForTimeout(400);
  const calls = await p.evaluate(() => window.__promptCalls);
  check(calls === 1, `pressing it calls the browser's own prompt (${calls}x)`);
  const after = await p.textContent("#install");
  check(await p.$("#doInstall") === null && /browser|menu/i.test(after),
    "the button goes after use — a prompt can only be spent once");
  await ctx.close();
}

// ------- 3. installed as a WebAPK but viewed in a tab: say so, don't shrug -------
{
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block" });
  await ctx.addInitScript(() => {
    navigator.getInstalledRelatedApps = async () => [{ platform: "webapp", url: "/manifest.webmanifest" }];
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
  await p.goto(B, { waitUntil: "networkidle" });
  await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(600);
  await settings(p);
  await p.waitForTimeout(400);
  const t = await p.textContent("#install");
  check(/already installed on this device/i.test(t), "detects the WebAPK is still installed");
  check(/Uninstall/.test(t), "and says how to uninstall it, instead of a vague browser-menu shrug");
  check(await p.$("#doInstall") === null, "no button, because Chrome will not honour one");
  await ctx.close();
}

// ---------------- 4. iPhone: instructions, never a button ----------------
{
  const { ctx, p } = await open({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    isMobile: true, hasTouch: true,
  });
  await settings(p);
  const t = await p.textContent("#install");
  check(/Add to Home Screen/.test(t), "iOS gets the Share -> Add to Home Screen steps");
  check((await p.$$("#install .steps li")).length === 3, "three numbered steps");
  check(await p.$("#doInstall") === null, "and no install button, because iOS cannot honour one");
  check((await p.$$("#install .steps svg")).length === 1, "the Share glyph is drawn, not described");
  await ctx.close();
}

// ---------------- 5. running from the home screen ----------------
{
  const { ctx, p } = await open({ standalone: true });
  await settings(p);
  const t = await p.textContent("#install");
  check(/home screen/i.test(t) && /Updates arrive/.test(t), "installed: says so instead of re-offering");
  check(await p.$("#doInstall") === null, "no install button when already installed");
  await ctx.close();
}

// ================= the bar on the capture screen =================

// 6. Android: visible, and one tap installs — no detour through Settings
{
  const { ctx, p } = await open();
  check(await p.isHidden("#installBar"), "bar stays hidden until the browser says it is installable");
  await p.evaluate(() => {
    window.__promptCalls = 0;
    const e = new Event("beforeinstallprompt");
    e.prompt = () => { window.__promptCalls++; return Promise.resolve(); };
    Object.defineProperty(e, "userChoice", { value: Promise.resolve({ outcome: "accepted" }) });
    dispatchEvent(e);
  });
  await p.waitForTimeout(300);
  check(await p.isVisible("#installBar"), "bar appears on the capture screen when installable");
  check(await p.isVisible("#view-capture"), "and it is on the first screen, not buried");
  await p.click("#installGo");
  await p.waitForTimeout(400);
  check(await p.evaluate(() => window.__promptCalls) === 1, "one tap reaches the browser prompt directly");
  check(await p.isHidden("#settings"), "no detour through Settings on Android");
  await ctx.close();
}

// 7. iPhone: the bar routes to the steps, since it cannot prompt
{
  const { ctx, p } = await open({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    isMobile: true, hasTouch: true,
  });
  await p.waitForTimeout(300);
  check(await p.isVisible("#installBar"), "iPhone sees the bar too — no beforeinstallprompt needed");
  await p.click("#installGo");
  await p.waitForTimeout(500);
  check(await p.isVisible("#settings"), "tapping it opens Settings");
  check(/Add to Home Screen/.test(await p.textContent("#install")), "landing on the Safari steps");
  await ctx.close();
}

// 8. dismissal sticks across a reload
{
  const { ctx, p } = await open({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    isMobile: true, hasTouch: true,
  });
  await p.waitForTimeout(300);
  await p.click("#installNo");
  check(await p.isHidden("#installBar"), "dismissing hides it");
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(700);
  check(await p.isHidden("#installBar"), "and it stays gone after a reload");
  await settings(p);
  check(/Add to Home Screen/.test(await p.textContent("#install")), "but Settings still offers it");
  await ctx.close();
}

// 9. never shown when already running from the home screen
{
  const { ctx, p } = await open({ standalone: true });
  await p.waitForTimeout(300);
  check(await p.isHidden("#installBar"), "no bar when already installed");
  await ctx.close();
}

// 10. desktop says "install as an app", phone says "home screen" — same mechanism
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => { console.log("  JS ERROR:", e.message); fails++; });
  await p.goto(B, { waitUntil: "networkidle" });
  await p.evaluate(() => sessionStorage.setItem("note-splash", "1"));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    window.__promptCalls = 0;
    const e = new Event("beforeinstallprompt");
    e.prompt = () => { window.__promptCalls++; return Promise.resolve(); };
    Object.defineProperty(e, "userChoice", { value: Promise.resolve({ outcome: "accepted" }) });
    dispatchEvent(e);
  });
  await p.waitForTimeout(300);
  const bar = await p.textContent("#installBar");
  check(/Install Note as an app/.test(bar), `desktop bar reads as an install, not a home screen (${bar.trim().split("\n")[0]})`);
  check(/pin/i.test(bar), "and mentions pinning, which is the bit you actually wanted");
  await settings(p);
  check(/taskbar or dock/i.test(await p.textContent("#install")), "Settings says taskbar or dock on desktop");
  check((await p.textContent("#doInstall")).trim() === "Install Note", "and the button is labelled for a desktop");
  await ctx.close();
}

console.log(fails ? `\n${fails} FAILURES` : "\nall green");
await browser.close();
process.exit(fails ? 1 : 0);
