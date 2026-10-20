const test = require("node:test");
const f = require('../importer.js');
const assert = require('assert');
// Shopify .js shape
const shop = f.parseShopify(JSON.stringify({ title: "Bamboo Zip Romper in Strawberry Patch", vendor: "Little Sleepies", price: 3400, featured_image: "//cdn.shopify.com/a.jpg", options: [{ name: "Size", values: ["0-3M","3-6M","6-12M"] }] }), "https://littlesleepies.com/products/x");
console.log(shop);
assert.equal(shop.printName, "Strawberry Patch"); assert.equal(shop.price, "$34"); assert.equal(shop.image, "https://cdn.shopify.com/a.jpg"); assert.equal(shop.sizes.length, 3);
// Generic HTML with JSON-LD
const html = `<html><head><title>Ruffle Romper - Pink Stripe | Posh Peanut</title>
<meta property="og:site_name" content="Posh Peanut"><meta property="og:image" content="/img/r.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Ruffle Romper &amp; Bow - Pink Stripe","brand":{"@type":"Brand","name":"Posh Peanut"},"image":["https://x.com/p.jpg"],"offers":{"@type":"Offer","price":"42.00","priceCurrency":"USD"}}]}</script></head></html>`;
const g = f.parseHtml(html, "https://poshpeanut.com/p/1"); console.log(g);
assert.equal(g.title, "Ruffle Romper & Bow - Pink Stripe"); assert.equal(g.brand, "Posh Peanut"); assert.equal(g.price, "$42"); assert.equal(g.printName, "Pink Stripe");
// OG only
const o = f.parseHtml(`<meta content="Cozy Sleeper" property="og:title"><meta property="og:image" content="https://a/b.png"><meta property="product:price:amount" content="29.5"><meta property="og:site_name" content="Kyte BABY">`, "https://kytebaby.com/x");
console.log(o); assert.equal(o.price, "$29.50"); assert.equal(o.title, "Cozy Sleeper");
for (const bad of ["http://localhost/x","http://169.254.169.254/","ftp://a.com","http://10.0.0.1/","http://[::1]/"]) assert.throws(() => f.checkUrl(bad));
f.checkUrl("https://www.target.com/p/x");
console.log("ALL PASS");

test("retired product page falls back to the Wayback Machine", async () => {
  const { importLink } = require("../importer");
  const real = global.fetch;
  const resp = (status, body, url, type = "text/html") => ({ ok: status < 400, status, url, headers: { get: () => type }, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
  const calls = [];
  global.fetch = async (u, opts = {}) => {
    const href = String(u); calls.push(`${opts.method || "GET"} ${href}`);
    if (href.includes("/products/retired-zippy.js")) return resp(404, "", href);
    if (href.startsWith("https://shop.example/products/retired-zippy")) return resp(404, "", href);
    if (href.startsWith("https://archive.org/wayback/available")) return resp(200, JSON.stringify({ archived_snapshots: { closest: { available: true, status: "200", url: "http://web.archive.org/web/20240501000000/https://shop.example/products/retired-zippy" } } }), href, "application/json");
    if (href === "https://web.archive.org/web/20240501000000id_/https://shop.example/products/retired-zippy")
      return resp(200, `<html><head><meta property="og:title" content="Moon Zippy"><meta property="og:image" content="https://cdn.example/moon.jpg"></head></html>`, href);
    if (href === "https://cdn.example/moon.jpg") return resp(404, "", href, "text/html"); // original photo gone too
    return resp(404, "", href);
  };
  try {
    const r = await importLink("https://shop.example/products/retired-zippy");
    assert.equal(r.title, "Moon Zippy");
    assert.equal(r.fromArchive, true);
    assert.equal(r.image, "https://web.archive.org/web/20240501000000im_/https://cdn.example/moon.jpg", "uses the archive's copy when the original photo is gone");
  } finally { global.fetch = real; }
});

test("shoe sizes: sold out only if her size and bigger are gone", () => {
  const { shopifyInStock, sizeWant } = require("../importer");
  const p = (avail) => ({ options: ["Size"], variants: Object.entries(avail).map(([option1, available]) => ({ option1, available })) });
  const min = sizeWant("4C", true);
  assert.deepEqual(min, { shoe: true, n: 4, orBigger: true });
  assert.equal(shopifyInStock(p({ "3": true, "4": false, "5": false }), min), false);
  assert.equal(shopifyInStock(p({ "3": false, "4": false, "5 Toddler": true }), min), true);
  assert.equal(shopifyInStock(p({ "4C": false, "4.5C": true }), min), true);
});


// The Sleepy Sloth "Ribbed Zip Jammies - Toadstool Grove" as listed Oct 2026:
// only TEENIE (smaller than newborn) in stock; she asked for 12–18M or bigger.
const sloth = { options: [{ name: "Size", values: ["TEENIE", "NEWBORN", "0/3", "3/6", "6/12", "12/18", "18/24"] }], available: true,
  variants: ["TEENIE", "NEWBORN", "0/3", "3/6", "6/12", "12/18", "18/24"].map((s, i) => ({ option1: s, available: i === 0 })) };
const withStock = (avail) => ({ ...sloth, variants: sloth.variants.map((v) => ({ ...v, available: avail.includes(v.option1) })) });

test("stock: store labels line up with the app's sizes", () => {
  const { sizeRange } = require("../importer");
  const same = [["6-12M", "6/12", "6 to 12 mo", "6M-12M", "6–12 Months", "6-12", "6-12 Months (17-22 lbs)"], ["2T", "2Y", "2 years", "2-3", "2"], ["Newborn", "NB", "NEWBORN", "Newborn (5-8 lbs)"]];
  for (const group of same) for (const x of group) assert.deepEqual(sizeRange(x), sizeRange(group[0]), x);
  assert.ok(sizeRange("TEENIE").lo < sizeRange("Newborn").lo);
  assert.equal(sizeRange("One Size"), null);
});

test("stock: only-TEENIE is OUT for a 12–18M-or-bigger wish (the reported bug)", () => {
  const { shopifyInStock, sizeWant } = require("../importer");
  assert.equal(shopifyInStock(sloth, sizeWant("12–18M", true)), false);
  assert.equal(shopifyInStock(withStock(["18/24"]), sizeWant("12–18M", true)), true, "bigger size counts when bigger is OK");
  assert.equal(shopifyInStock(withStock(["12/18"]), sizeWant("12–18M", true)), true);
});

test("stock: without 'bigger size OK' only her size counts", () => {
  const { shopifyInStock, sizeWant } = require("../importer");
  assert.equal(shopifyInStock(withStock(["18/24"]), sizeWant("12–18M", false)), false);
  assert.equal(shopifyInStock(withStock(["12/18"]), sizeWant("12–18M", false)), true);
  assert.equal(shopifyInStock(withStock(["3/6", "6/12"]), sizeWant("6–12M", false)), true);
  assert.equal(shopifyInStock(withStock(["3/6"]), sizeWant("6–12M", false)), false);
});

test("stock: unrecognized sizes don't count once a product has normal sizes; all-unrecognized → product availability", () => {
  const { shopifyInStock, sizeWant } = require("../importer");
  const odd = { options: ["Size"], available: true, variants: [{ option1: "Bundle", available: true }, { option1: "12-18M", available: false }] };
  assert.equal(shopifyInStock(odd, sizeWant("12–18M", true)), false);
  const oneSize = { options: ["Size"], available: true, variants: [{ option1: "One Size", available: true }] };
  assert.equal(shopifyInStock(oneSize, sizeWant("12–18M", true)), null, "can't tell → unknown, not 'in stock'");
  const gone = { options: ["Size"], available: false, variants: [{ option1: "One Size", available: false }] };
  assert.equal(shopifyInStock(gone, sizeWant("12–18M", true)), false);
});

test("stock: a non-Shopify store with /products/ links isn't marked sold out (Lovevery)", async () => {
  const { checkStock } = require("../importer");
  const real = global.fetch;
  const page = (status, body = "") => ({ ok: status < 400, status, url: "", headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from(body) });
  try {
    // .js → 404 (not Shopify), page → 200 with no stock data: can't tell, so "unknown", never "out"
    global.fetch = async (u) => ({ ...page(String(u).endsWith(".js") ? 404 : 200, "<html><title>Play Every Way Table</title></html>"), url: String(u) });
    assert.equal(await checkStock("https://lovevery.com/products/the-play-every-way-table"), "unknown");
    // a pre-order page that says so in its product data counts as available
    const ld = `<script type="application/ld+json">{"@type":"Product","name":"Table","offers":{"availability":"https://schema.org/PreOrder"}}</script>`;
    global.fetch = async (u) => ({ ...page(String(u).endsWith(".js") ? 404 : 200, ld), url: String(u) });
    assert.equal(await checkStock("https://lovevery.com/products/the-play-every-way-table"), "in");
    // the product page itself is gone → out
    global.fetch = async (u) => ({ ...page(404), url: String(u) });
    assert.equal(await checkStock("https://lovevery.com/products/retired-thing"), "out");
  } finally { global.fetch = real; }
});
