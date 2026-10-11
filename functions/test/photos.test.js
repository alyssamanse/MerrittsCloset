// Find Photos search, with every network call replaced by a fake.
const test = require("node:test");
const assert = require("node:assert");
const { findPhotoChoices, siteFor, shopifySearch } = require("../photos");

const shopifyJson = (products) => ({ text: JSON.stringify({ resources: { results: { products } } }), finalUrl: "https://littlesleepies.com/search/suggest.json" });
const P = (title, handle, img) => ({ title, url: `/products/${handle}?_pos=1&_sid=x`, image: img });

test("brand → store site, by brand key or the brand's own setting", () => {
  assert.equal(siteFor("Little Sleepies"), "littlesleepies.com");
  assert.equal(siteFor("Kyte Baby Co"), "kytebaby.com");
  assert.equal(siteFor("The Sleepy Sloth"), "thesleepysloth.com");
  assert.equal(siteFor("Unknown Brand"), "");
  assert.equal(siteFor("Unknown Brand", "shop.example.com"), "shop.example.com");
});

test("Shopify search: best matches first, absolute https links, at most 3, nothing saved", async () => {
  const calls = [];
  const get = async (u) => { calls.push(u); return shopifyJson([
    P("Strawberry Patch Zippy", "strawberry-zippy", "//cdn.shopify.com/s/a.jpg"),
    P("Bunny Meadow Bamboo Zippy", "bunny-meadow-zippy", "//cdn.shopify.com/s/b.jpg"),
    P("Bunny Meadow Shorty", "bunny-meadow-shorty", "https://cdn.shopify.com/s/c.jpg"),
    P("Bunny Meadow Two-Piece", "bunny-meadow-2pc", "//cdn.shopify.com/s/d.jpg"),
  ]); };
  const r = await findPhotoChoices({ brand: "Little Sleepies", name: "Bunny Meadow" }, { deps: { get, braveGet: async () => assert.fail("no web search needed") } });
  assert.match(calls[0], /^https:\/\/littlesleepies\.com\/search\/suggest\.json\?q=Bunny%20Meadow&resources\[type\]=product/);
  assert.equal(r.choices.length, 3);
  assert.ok(r.choices.every((c) => c.title.includes("Bunny Meadow")), "matching prints ranked first");
  assert.equal(r.choices[0].image, "https://cdn.shopify.com/s/b.jpg");
  assert.equal(r.choices[0].url, "https://littlesleepies.com/products/bunny-meadow-zippy");
  assert.deepEqual(r.searched, ["store"]);
});

test("not Shopify / no match → web search, brand's own site first, og:image of each page", async () => {
  const get = async () => ({ text: "<html>not json</html>" });
  const braveGet = async (u, key) => {
    assert.equal(key, "test-key");
    assert.match(u, /q=Janie%20and%20Jack%20Ruffle%20Romper/);
    return { web: { results: [
      { url: "https://www.pinterest.com/pin/1", title: "pin" },
      { url: "https://www.poshmark.com/listing/1", title: "resale" },
      { url: "https://www.janieandjack.com/ruffle-romper-1.html", title: "Ruffle Romper" },
    ] } };
  };
  const opened = [];
  const importLink = async (u) => { opened.push(u); return { title: "x", image: u.includes("janieandjack") ? "https://img.janieandjack.com/r.jpg" : "https://poshmark.com/p.jpg" }; };
  const r = await findPhotoChoices({ brand: "Janie and Jack", name: "Ruffle Romper" }, { key: "test-key", deps: { get, braveGet, importLink } });
  assert.equal(opened[0], "https://www.janieandjack.com/ruffle-romper-1.html", "brand site opened first");
  assert.ok(!opened.some((u) => u.includes("pinterest")), "social sites skipped");
  assert.equal(r.choices[0].image, "https://img.janieandjack.com/r.jpg");
  assert.equal(r.choices[0].url, "https://www.janieandjack.com/ruffle-romper-1.html");
  assert.deepEqual(r.searched, ["store", "web"]);
});

test("no web search key: says so instead of failing", async () => {
  const r = await findPhotoChoices({ brand: "Carter's", name: "Floral Bodysuit" }, { key: "", deps: { get: async () => null } });
  assert.deepEqual(r.choices, []);
  assert.equal(r.webConfigured, false);
});

test("errors and timeouts become 'no results', never a crash", async () => {
  const r = await findPhotoChoices({ brand: "Little Sleepies", name: "Anything" }, { key: "k", deps: {
    get: async () => { throw new Error("boom"); }, braveGet: async () => null, importLink: async () => { throw new Error("nope"); },
  } }).catch((e) => ({ crashed: e.message }));
  assert.ok(!r.crashed, `crashed: ${r.crashed}`);
  assert.deepEqual(r.choices, []);
});

test("the record's own product link is tried first", async () => {
  const r = await findPhotoChoices({ brand: "Little Sleepies", name: "Bunny Meadow", url: "https://littlesleepies.com/products/own" }, { deps: {
    importLink: async () => ({ title: "Own", image: "https://cdn.shopify.com/own.jpg" }),
    get: async () => shopifyJson([P("Bunny Meadow Zippy", "z", "//cdn.shopify.com/z.jpg")]),
  } });
  assert.equal(r.choices[0].image, "https://cdn.shopify.com/own.jpg");
  assert.equal(r.choices.length, 2);
});
