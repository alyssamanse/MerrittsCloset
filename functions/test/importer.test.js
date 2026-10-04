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
  const { shopifyInStock, shoeRank } = require("../importer");
  const p = (avail) => ({ options: ["Size"], variants: Object.entries(avail).map(([option1, available]) => ({ option1, available })) });
  const min = shoeRank("4C");
  assert.deepEqual(min, { shoe: true, n: 4 });
  assert.equal(shopifyInStock(p({ "3": true, "4": false, "5": false }), min), false);
  assert.equal(shopifyInStock(p({ "3": false, "4": false, "5 Toddler": true }), min), true);
  assert.equal(shopifyInStock(p({ "4C": false, "4.5C": true }), min), true);
});
