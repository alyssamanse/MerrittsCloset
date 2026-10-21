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
  await p.waitForSelector("main");
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
  await step("Top Print and Top Style badges", async () => {
    const card = g.locator("#item-i9");
    must(await card.locator(".chip.top", { hasText: "Top Print" }).count() === 1, "no Top Print on a favorite print");
    must(await card.locator(".chip.top", { hasText: "Top Style" }).count() === 1, "no Top Style on a favorite style");
    must(await g.locator("#item-i1 .chip.top").count() === 0, "badge on a wish that isn't a favorite");
  });
  await step("Current Obsessions: guests read only", async () => {
    await tab(g, "sizes");
    must(await g.locator(".obsessions .obs-chip").count() > 0, "no obsession chips");
    must(/Updated \w{3} \d+, \d{4}/.test(await g.locator(".obs-updated").textContent()), "no Updated date");
    must(await g.locator("[data-act=edit-obsessions]").count() === 0, "guest sees Edit");
    await tab(g, "wishlist");
  });
  await step("Sold out: own section, notify me, remembered on this device", async () => {
    const card = g.locator(".wl-fold[data-wl=soldout] #item-i10");
    must(await card.count() === 1, "sold-out item not in Sold Out Right Now");
    must(await g.locator(".wl-fold:not([data-wl=soldout]) #item-i10").count() === 0, "sold-out item also in another section");
    await card.locator("[data-act=notify]").click(); await g.waitForTimeout(250);
    await g.fill("#nt-email", "not-an-email"); await g.click('.sheet-bg [data-act="save"]'); await g.waitForTimeout(200);
    must((await g.locator(".sheet-err").textContent()).includes("doesn't look right"), "bad email accepted");
    await g.fill("#nt-email", "aunt.jen@example.com"); await g.click('.sheet-bg [data-act="save"]'); await g.waitForTimeout(600);
    must((await g.locator("#item-i10").innerText()).includes("We'll email you"), "no confirmation on the card");
    must(!(await g.locator("main").innerText()).toLowerCase().includes("aunt.jen"), "email shown on the page");
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
  await step("Current Obsessions: edit, reorder, save", async () => {
    await tab(o, "sizes");
    await o.click("[data-act=edit-obsessions]"); await o.waitForTimeout(250);
    const labels = () => o.locator('.obs-row [data-f="label"]').evaluateAll((e) => e.map((x) => x.value));
    const before = await labels();
    await o.locator('.obs-row[data-i="0"] [data-m="drag"]').focus(); await o.keyboard.press("ArrowDown");
    must((await labels())[1] === before[0], "keyboard reorder didn't move the first entry");
    await o.click('.sheet-bg [data-m="add"]'); await o.locator('.obs-row:last-child [data-f="label"]').fill("Peekaboo");
    await o.click('.sheet-bg [data-act="save"]'); await o.waitForTimeout(500);
    const chips = await o.locator(".obs-chip b").allTextContents();
    must(chips[1] === before[0] && chips.includes("Peekaboo"), `chips were ${chips.join(", ")}`);
    await tab(o, "wishlist");
  });
  await step("Find Photos: search, pick one, saved", async () => {
    await tab(o, "closet");
    const n = await o.locator("[data-act=find-photos]").textContent();
    await o.click("[data-act=find-photos]"); await o.waitForTimeout(250);
    const row = o.locator(".pf-row").first();
    await row.locator('[data-m="search"]').click(); await o.waitForTimeout(700);
    must(await row.locator(".pf-choice").count() === 3, "expected 3 photo choices");
    await row.locator(".pf-choice").first().click(); await o.waitForTimeout(600);
    await o.click('.sheet-bg [data-act="cancel"]'); await o.waitForTimeout(200);
    const after = await o.locator("[data-act=find-photos]").textContent().catch(() => "Find Photos (0)");
    must(parseInt(after.match(/\d+/)) === parseInt(n.match(/\d+/)) - 1, `${n} → ${after}`);
    await tab(o, "wishlist");
  });
  await step("owner sees how many are waiting", async () => {
    await tab(o, "wishlist");
    must((await o.locator("#item-i10").innerText()).includes("waiting for it"), "no waiting count for the owner");
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

  console.log("Luca's wishlist");
  const l = await page(browser, "luca/?demo");
  await step("Luca's page: own name, wishlist only, his wording", async () => {
    must((await l.title()) === "Luca's Wishlist", `title was ${await l.title()}`);
    must((await l.locator("nav.tabs .tab").allTextContents()).join("|").match(/^Wishlist\|(Under the Tree|Already Got)$/), "tabs should be Wishlist + Under the Tree");
    must(await l.locator("[data-to=family]").count() === 0, "family link shown");
    must((await l.locator("h1.logo").innerText()).toLowerCase().includes("luca"), "logo isn't Luca's");
    must((await l.locator(".nav-mark").innerText()).trim() === "L", "tab-bar monogram isn't L");
    must(await l.locator(".chip.top").count() === 0, "closet badges on a wishlist-only site");
    must((await l.locator("footer").innerText()).includes("Sign in to edit"), "no sign-in link for the owner");
    must(await l.locator(".guide").count() === 0, "a guest got the owner tutorial");
  });
  await step("Under the Tree: guest searches, adds, sees duplicate warning, removes own", async () => {
    await l.click("[data-tab=gifted]"); await l.waitForTimeout(200);
    must(await l.locator(".gifted-row").count() === 2, "sample entries missing");
    await l.fill("#gifted-search", "dinosaur"); await l.waitForTimeout(100);
    must(await l.locator(".gifted-row").count() === 1, "search didn't filter");
    await l.fill("#gifted-search", "rocket ship"); await l.waitForTimeout(100);
    must((await l.locator("#gifted-results").innerText()).includes("looks safe to buy"), "no 'safe to buy' message");
    await l.fill("#gifted-search", "");
    await l.click("[data-act=add-gifted]"); await l.waitForTimeout(200);
    await l.fill("#gf-link", "https://www.walmart.com/ip/Radio-Flyer-Classic-Red-Wagon/12345"); await l.waitForTimeout(100);
    must((await l.inputValue("#gf-what")) === "Radio Flyer Classic Red Wagon", "pasted link didn't fill the name");
    await l.fill("#gf-link", "");
    await l.fill("#gf-what", "Wooden train set with bridge"); await l.waitForTimeout(100);
    must((await l.locator("#gf-similar").innerText()).includes("Someone already added"), "no duplicate warning");
    await l.fill("#gf-what", "Toddler rain boots"); await l.click('.seg[data-g="cat"] [data-v="clothes"]');
    must(await l.locator("#gf-size-row").isVisible(), "no size for clothes");
    must(await l.locator("#gf-url").count() === 0, "link field still offered to guests");
    await l.fill("#gf-from", "Aunt Jen");
    await l.click('.sheet-bg [data-act="save"]'); await l.waitForTimeout(600);
    const row = l.locator(".gifted-row", { hasText: "Toddler rain boots" });
    must(await row.count() === 1, "entry not shown");
    must(!(await l.locator("main").innerText()).includes("Aunt Jen"), "name shown to guests");
    must(await row.locator("[data-act=remove-gifted]").count() === 1, "can't remove own entry");
    must(await l.locator(".gifted-row", { hasText: "Wooden train set" }).locator("[data-act=remove-gifted]").count() === 0, "can remove someone else's");
    must(await l.locator(".gifted-row", { hasText: "Wooden train set" }).locator("[data-act=edit-gifted]").count() === 0, "can edit someone else's");
    await row.locator("[data-act=edit-gifted]").click(); await l.waitForTimeout(250);
    must((await l.inputValue("#gf-what")) === "Toddler rain boots", "edit form not prefilled");
    await l.fill("#gf-what", "Toddler rain boots (navy)"); await l.click('.sheet-bg [data-act="save"]'); await l.waitForTimeout(600);
    must(await l.locator(".gifted-row", { hasText: "Toddler rain boots (navy)" }).count() === 1, "edit not saved");
    await l.locator(".gifted-row", { hasText: "Toddler rain boots" }).locator("[data-act=remove-gifted]").click(); await l.waitForTimeout(500);
    must(await l.locator(".gifted-row", { hasText: "Toddler rain boots" }).count() === 0, "not removed");
  });
  await step("Luca's page: claimed wishlist items show under the tree; owner can add a photo", async () => {
    const lo = await page(browser, "luca/?demo&admin");
    const s = lo.locator("[data-act=signin]"); if (await s.count()) { await s.first().click(); await lo.waitForTimeout(400); }
    for (let k = 0; k < 8 && await lo.locator(".guide").count(); k++) await lo.click('.guide [data-m="next"]');
    await lo.click("[data-act=add-starters]"); await lo.waitForTimeout(800);
    await lo.locator("footer [data-act=signout], [data-act=signout]").first().click(); await lo.waitForTimeout(500);
    const claimBtn = lo.locator("[data-act=claim]").first();
    must(await claimBtn.count() === 1, "no claim button");
    await claimBtn.click(); await lo.waitForTimeout(300);
    const ok = lo.locator('.sheet-bg [data-act="save"], .sheet-bg [data-act="claim-ok"], .sheet-bg .btn:not(.ghost)').first();
    if (await ok.count()) { await ok.click(); await lo.waitForTimeout(600); }
    await lo.click("[data-tab=gifted]"); await lo.waitForTimeout(250);
    must(await lo.locator(".gifted-row.from-list").count() === 1, "claimed item not under the tree");
    await lo.click("[data-tab=wishlist]"); await lo.waitForTimeout(200);
    must(await lo.locator(".thanks").count() === 0, "thank-you notes shown on Luca's page");
    await lo.click("[data-tab=gifted]"); await lo.waitForTimeout(200);
    must(await lo.locator(".gifted-row.from-list [data-act]").count() === 0, "claimed rows should have no buttons here");
    must(!(await lo.locator("main").innerText()).includes("Grandpa Joe"), "gifter name shown to a guest");
    await lo.locator("[data-act=signin]").first().click(); await lo.waitForTimeout(500);
    for (let k = 0; k < 8 && await lo.locator(".guide").count(); k++) await lo.click('.guide [data-m="next"]');
    if (!(await lo.locator(".gifted-row").first().isVisible().catch(() => false))) { await lo.click("[data-tab=gifted]"); await lo.waitForTimeout(250); }
    must(await lo.locator(".gifted-row", { hasText: "Wooden train set" }).locator("[data-act=gifted-photo]").count() === 0, "Add Photo shown without a link");
    must(await lo.locator(".gifted-row", { hasText: "Wooden train set" }).locator("[data-act=edit-gifted]").count() === 1, "owner can't edit");
    must((await lo.locator(".gifted-row", { hasText: "Wooden train set" }).innerText()).includes("From Grandpa Joe"), "admin can't see who added it");
    must(!(await lo.locator("#gifted-results").innerText()).includes("Added "), "added date still shown");
    await lo.locator(".gifted-row", { hasText: "Dinosaur pajamas" }).locator("[data-act=gifted-photo]").click(); await lo.waitForTimeout(800);
    await lo.locator(".pf-choice").first().click(); await lo.waitForTimeout(600);
    must(await lo.locator(".sheet-bg").count() === 0, "photo picker didn't close after saving");
    must(await lo.locator(".gifted-row", { hasText: "Dinosaur pajamas" }).locator(".gifted-img").count() === 1, "photo not shown");
    await lo.close();
  });
  await step("Luca's page: owner adds the example gifts in one tap", async () => {
    const lo = await page(browser, "luca/?demo&admin");
    const s = lo.locator("[data-act=signin]"); if (await s.count()) { await s.first().click(); await lo.waitForTimeout(400); }
    // First sign-in: the tutorial opens by itself; walk through it.
    await lo.waitForSelector(".guide", { timeout: 5000 });
    for (let k = 0; k < 8 && await lo.locator(".guide").count(); k++) await lo.click('.guide [data-m="next"]');
    must(await lo.locator(".guide").count() === 0, "guide didn't close");
    must(await lo.locator(".owner-bar [data-act=add]").count() === 1, "no big Add button");
    // simple form: extra fields folded away until "More details"
    await lo.click(".owner-bar [data-act=add]"); await lo.waitForTimeout(250);
    must(!(await lo.locator("#f-image").isVisible()), "image address shown in the simple form");
    await lo.click(".more-details"); must(await lo.locator("#f-image").isVisible(), "More details didn't open");
    await lo.click('.sheet-bg [data-act="cancel"]'); await lo.waitForTimeout(200);
    must(await lo.locator("[data-act=add-starters]").count() === 1, "no example-gifts button on an empty list");
    await lo.click("[data-act=add-starters]");
    await lo.waitForFunction(() => document.querySelectorAll("article.card").length >= 10, null, { timeout: 30000 }).catch(() => {});
    const n = await lo.locator("article.card").count();
    must(n === 10, `expected 10 example gifts, got ${n}`);
    must((await lo.locator("article.card").first().innerText()).includes("Example: keep or delete"), "examples aren't labeled");
    must(await lo.locator("[data-act=receive]").first().innerText() === "Received", "received label");
    await lo.close();
  });
  await step("no script errors anywhere", async () => must(!errors.length, errors.join(" | ")));
  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
