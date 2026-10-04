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
