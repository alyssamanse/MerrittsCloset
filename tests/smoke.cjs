// Smoke test: opens the site in demo mode (sample data, nothing saved) at phone size,
// visits every page as a guest and as the owner, opens every form, and fails on any
// script error or anything missing. Run: node tests/smoke.cjs http://localhost:8765/
const { chromium, devices } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const BASE = process.argv[2] || "http://localhost:8765/";
let failed = 0;
const errors = [];

async function step(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e.message || e).split("\n")[0]}`); }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

async function page(browser, query) {
  const p = await browser.newPage({ ...devices["iPhone 13"], acceptDownloads: true });
  p.on("pageerror", (e) => errors.push(`${query}: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::|fonts\\.g/.test(m.text())) errors.push(`${query}: ${m.text()}`); });
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await p.goto(BASE + query);
  await p.waitForSelector("nav.tabs");
  await p.waitForTimeout(700);
  return p;
}
const tab = async (p, t) => { await p.click(`[data-tab=${t}]`); await p.waitForTimeout(150); };
const cancelSheet = async (p) => { await p.locator('.sheet-bg [data-act="cancel"]').first().click(); await p.waitForTimeout(150); };
const openSheet = async (p, sel, expectTitle) => {
  await p.locator(sel).first().click(); await p.waitForTimeout(250);
  const h = (await p.locator(".sheet-bg h2").first().textContent()) || "";
  must(h.includes(expectTitle), `sheet title was "${h}"`);
  await cancelSheet(p);
};

(async () => {
  const browser = await chromium.launch();

  console.log("Guest");
  const g = await page(browser, "?demo");
  await step("guests never see hidden items", async () => {
    must(await g.locator(".wl-fold[data-wl=hidden]").count() === 0, "hidden section shown to a guest");
    must(!(await g.locator("main").innerText()).includes("Wooden Play Kitchen"), "hidden item visible to a guest");
  });
  await step("wishlist shows sections", async () => {
    must(await g.locator(".wl-fold[data-wl=most] .card").count() > 0, "no Most Wanted cards");
    must(await g.locator(".wl-fold[data-wl=claimed]").count() === 1, "no Already Claimed section");
  });
  await step("'She has this print' appears", async () => must((await g.locator("#item-i1 .has-print").textContent()).includes("Zippy"), "missing"));
  await step("budget filter", async () => {
    await g.selectOption("#wl-budget", "u25"); await g.waitForTimeout(100);
    must(await g.locator("#item-i1").count() === 0, "$38 item still shown under $25");
    await g.selectOption("#wl-budget", "any");
  });
  await step("every sort", async () => { for (const v of ["price", "brand", "newest", "most"]) { await g.selectOption("#wl-sort", v); await g.waitForTimeout(80); must(await g.locator(".wl-fold").count() > 0, v); } });
  await step("tile layout", async () => {
    await g.click('[data-act=wl-view][data-v=grid]'); await g.waitForTimeout(100);
    must(await g.locator(".wl-grid").count() > 0, "no grid"); await g.click('[data-act=wl-view][data-v=list]');
  });
  await step("claim with a name", async () => {
    const btn = g.locator('.wl-fold:not([data-wl=claimed]) [data-act=claim]').first();
    const id = await btn.getAttribute("data-id");
    await btn.click(); await g.waitForTimeout(200);
    await g.fill("#cl-from", "Test Gifter"); await g.click('.sheet-bg [data-act="save"]'); await g.waitForTimeout(700);
    must((await g.locator(`#item-${id} .status`).textContent()).includes("You're getting this"), "not claimed");
    must(!(await g.content()).includes("Test Gifter"), "guest page shows the name");
  });
  await step("share an item", async () => { await g.locator("[data-act=share-item]").first().click(); await g.waitForTimeout(200); });
  await step("closet: favorites, brands, search, photo", async () => {
    await tab(g, "closet");
    must(await g.locator("details.favs .style-fav").count() > 0, "no favorite styles");
    must(await g.locator(".brand-fold").count() > 0, "no brands");
    await g.fill("#closet-search", "cloud"); await g.waitForTimeout(200);
    must(await g.locator("#closet-results .print").count() > 0, "search found nothing"); await g.fill("#closet-search", "");
    await g.locator(".tile-img[data-act=zoom]").first().click(); await g.waitForTimeout(200); await g.keyboard.press("Escape");
  });
  await step("sizes page", async () => { await tab(g, "sizes"); must(await g.locator(".size-row").count() > 0, "no brands"); must(await g.locator(".size-nudge").count() === 0, "guest sees reminder"); });
  await step("family link and page", async () => {
    await g.locator("[data-to=family]").click(); await g.waitForTimeout(250);
    must((await g.locator("main h2").first().textContent()).includes("Family"), "family page missing");
  });
  await step("compact header after scrolling", async () => {
    await tab(g, "wishlist"); await g.evaluate(() => window.scrollTo(0, 900)); await g.waitForTimeout(250);
    must(await g.evaluate(() => document.body.classList.contains("compact")), "no compact header");
    await tab(g, "closet");
    must(await g.evaluate(() => window.scrollY > 100), "tab switch scrolled back to the logo");
  });
  await g.close();

  console.log("Item link");
  const d = await page(browser, "?demo#item-i2");
  await step("opens and highlights the item", async () => { await d.waitForTimeout(300); must(await d.locator("#item-i2.flash").count() === 1, "not highlighted"); });
  await d.close();

  console.log("Owner");
  const o = await page(browser, "?demo&admin");
  await o.locator("[data-act=signin]").first().click(); await o.waitForTimeout(500);
  await step("gifter name visible to owner", async () => must((await o.locator("#item-i3 .status").textContent()).includes("Aunt Jen"), "no name"));
  await step("thank-you list", async () => {
    await o.locator("details.thanks > summary").click();
    must((await o.locator(".thank-row").first().textContent()).includes("Grandma Sue"), "missing");
    await o.locator(".thank-row input[type=checkbox]").first().check(); await o.waitForTimeout(400);
    must(await o.locator(".thank-row.done").count() === 1, "not ticked");
  });
  await step("received gift moves the name to thank-yous", async () => {
    await o.locator('.wl-fold[data-wl=claimed] > summary').click();
    await o.locator('#item-i3 [data-act=receive]').click(); await o.waitForTimeout(600);
    must((await o.locator(".thanks").textContent()).includes("Aunt Jen"), "no thank-you for Aunt Jen");
  });
  await step("hide and show wishlist items", async () => {
    await tab(o, "wishlist");
    must(await o.locator(".wl-fold[data-wl=hidden] .card.draft").count() === 1, "owner doesn't see the hidden item");
    // hide a public item from its Edit form
    const card = o.locator(".wl-fold[data-wl=toy] .card").first();
    const title = (await card.locator("h3").innerText()).trim();
    await card.locator("[data-act=edit-item]").click(); await o.waitForTimeout(250);
    await o.check("#f-hidden"); await o.click('.sheet-bg [data-act="save"]'); await o.waitForTimeout(700);
    must((await o.locator(".wl-fold[data-wl=hidden]").innerText()).includes(title), `"${title}" didn't move to Hidden`);
    // show it again
    await o.locator(".wl-fold[data-wl=hidden] .card", { hasText: title }).locator("[data-act=show-item]").click(); await o.waitForTimeout(700);
    must(!(await o.locator(".wl-fold[data-wl=hidden]").innerText()).includes(title), "still hidden after Show to Guests");
    must(await o.locator(`.wl-fold:not([data-wl=hidden]) .card:has-text("${title}")`).count() === 1, "not back on the list");
  });
  await step("wishlist forms", async () => { await openSheet(o, "[data-act=add]", "Add"); await openSheet(o, "[data-act=add-thank]", "Thank"); });
  await step("closet: bulk delete and undo", async () => {
    await tab(o, "closet");
    const before = await o.locator(".brand-fold .print").count();
    await o.click("[data-act=select-mode]"); await o.waitForTimeout(150);
    await o.evaluate(() => document.querySelectorAll(".brand-fold").forEach((d) => (d.open = true)));
    await o.locator(".brand-fold [data-act=pick]").first().click(); await o.waitForTimeout(100);
    await o.locator(".bulk-bar [data-op=delete]").click(); await o.waitForTimeout(200);
    await o.locator(".modal-bg button", { hasText: "Delete" }).click(); await o.waitForTimeout(700);
    must(await o.locator(".undo-bar").count() === 1, "no undo bar");
    must(await o.locator(".toast .toast-btn", { hasText: "Undo" }).count() === 1, "no Undo in the message at the bottom");
    await o.locator(".toast .toast-btn").click(); await o.waitForTimeout(700);
    const after = await o.locator(".brand-fold .print").count();
    must(after === before, `not restored (${before} before, ${after} after)`);
  });
  if (await o.locator("[data-act=select-mode]", { hasText: "Done" }).count()) await o.click("[data-act=select-mode]");
  await step("backup download", async () => {
    const [dl] = await Promise.all([o.waitForEvent("download"), o.click("[data-act=backup]")]);
    must(/\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  });
  await step("closet forms", async () => {
    await o.locator("details.favs").evaluate((el) => (el.open = true));
    await openSheet(o, "[data-act=add-stylefav]", "Favorite Style");
    await openSheet(o, "[data-act=import-list]", "Import");
    await openSheet(o, "[data-act=add]", "Add");
  });
  await step("size reminder", async () => {
    await tab(o, "sizes");
    must(await o.locator(".size-nudge").count() === 1, "no reminder");
    await o.click("[data-act=confirm-sizes]"); await o.waitForTimeout(600);
    must(await o.locator(".size-nudge").count() === 0, "reminder stayed");
  });
  await step("sizes forms", async () => {
    await openSheet(o, "[data-act=add-brand]", "Brand");
    await openSheet(o, "[data-act=add-plan]", "Occasion");
    await openSheet(o, "[data-act=edit-colors]", "Color");
  });
  await step("share sheet has the family link", async () => {
    await o.click("[data-act=share]"); await o.waitForTimeout(200);
    must((await o.inputValue("#share-fam")).endsWith("#family"), "no family link"); await cancelSheet(o);
  });
  await step("family page forms", async () => { await o.locator("[data-to=family]").click(); await o.waitForTimeout(200); await openSheet(o, "[data-act=add]", "Family"); });
  await step("Get Latest Version is there", async () => must(await o.locator("[data-act=force-update]").count() === 1, "missing"));
  await o.close();

  await step("no script errors anywhere", async () => must(!errors.length, errors.join(" | ")));
  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
