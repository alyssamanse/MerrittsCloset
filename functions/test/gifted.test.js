// "Already Under the Tree": guests note gifts they already bought.
const test = require("node:test");
const assert = require("node:assert");
process.env.GUEST_GIFTED = "true";
const { store, MAIN, call, key, logic } = require("./harness");
const PRIV = `${MAIN}/private/owner`;
const fresh = () => { store.docs = { [MAIN]: logic.reduce(null, "init", {}, { isOwner: true, now: 1 }).state }; };
const gift = (id, extra = {}) => ({ id, what: "Wooden train set", cat: "toy", ...extra });

test("a guest adds an entry; it shows publicly, their name stays private", async () => {
  fresh();
  const k = key();
  const r = await call("addGifted", { item: gift("gift_00000001"), key: k, from: "Uncle Bo" });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.gifted.gift_00000001.what, "Wooden train set");
  assert.ok(!JSON.stringify(store.docs[MAIN]).includes("Uncle Bo"), "name never in the public doc");
  assert.ok(!JSON.stringify(r.body).includes("Uncle Bo"));
  const t = Object.values(store.docs[PRIV].thanks);
  assert.deepEqual([t[0].title, t[0].from], ["Wooden train set", "Uncle Bo"], "goes on the thank-you list");
  // only that device can remove it
  assert.equal((await call("removeGifted", { id: "gift_00000001", key: key() })).status, 403);
  assert.equal((await call("removeGifted", { id: "gift_00000001", key: k })).status, 200);
  assert.equal(store.docs[MAIN].gifted.gift_00000001, undefined);
  assert.equal(Object.keys(store.docs[PRIV].thanks).length, 0, "its thank-you goes too");
});

test("validation: text only (links refused), short, known categories", async () => {
  fresh();
  const bad = [
    gift("gift_00000002", { what: "" }), gift("gift_00000003", { what: "x".repeat(81) }),
    gift("gift_00000004", { url: "https://example.com/x" }), gift("gift_00000005", { url: "javascript:alert(1)" }),
    gift("gift_00000006", { cat: "car" }), gift("gift_00000007", { image: "https://x.com/a.jpg" }),
  ];
  for (const item of bad) assert.equal((await call("addGifted", { item, key: key() })).status, 400, JSON.stringify(item));
  const ok = await call("addGifted", { item: gift("gift_00000008", { cat: "clothes", size: "2T" }), key: key() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.gifted.gift_00000008.size, "2T");
});

test("limits: per-address rate limit and a cap on the list", async () => {
  fresh();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call("addGifted", { item: gift(`gift_r000000${i}`), key: key() }, { ip: "7.7.7.7" })).status);
  assert.ok(codes.includes(429), `rate-limited: ${codes}`);
  fresh();
  store.docs[MAIN].gifted = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`gift_c${String(i).padStart(7, "0")}`, { id: `gift_c${String(i).padStart(7, "0")}`, what: "x", cat: "toy", h: "x", at: 1 }]));
  assert.equal((await call("addGifted", { item: gift("gift_full0001"), key: key() })).status, 400, "list full");
});

test("owners can delete any entry or start fresh; guests can't", async () => {
  fresh();
  await call("addGifted", { item: gift("gift_00000009"), key: key() });
  assert.equal((await call("deleteGifted", { id: "gift_00000009" })).status, 403);
  assert.equal((await call("clearGifted", {})).status, 403);
  assert.equal((await call("deleteGifted", { id: "gift_00000009" }, { token: "owner" })).status, 200);
  await call("addGifted", { item: gift("gift_00000010"), key: key() });
  assert.equal((await call("clearGifted", {}, { token: "owner" })).status, 200);
  assert.equal(store.docs[MAIN].gifted && Object.keys(store.docs[MAIN].gifted).length, 0);
});

test("switched off unless the server enables it (Merritt's list never takes guest entries)", async () => {
  fresh();
  process.env.GUEST_GIFTED = "";
  try { assert.equal((await call("addGifted", { item: gift("gift_00000011"), key: key() })).status, 404); }
  finally { process.env.GUEST_GIFTED = "true"; }
});


test("the guest who added an entry can edit it; nobody else can", async () => {
  fresh();
  const k = key();
  await call("addGifted", { item: gift("gift_edit0001"), key: k, from: "Uncle Bo" });
  const r = await call("editGifted", { item: gift("gift_edit0001", { what: "Wooden train set + bridge", cat: "toy" }), key: k });
  assert.equal(r.status, 200);
  assert.equal(store.docs[MAIN].gifted.gift_edit0001.what, "Wooden train set + bridge");
  assert.equal(Object.values(store.docs[PRIV].thanks)[0].title, "Wooden train set + bridge", "thank-you follows the edit");
  assert.equal((await call("editGifted", { item: gift("gift_edit0001", { what: "Hacked" }), key: key() })).status, 403);
  assert.equal((await call("editGifted", { item: gift("gift_edit0001", { url: "https://x.com" }), key: k })).status, 400, "still no links");
  assert.equal((await call("editGifted", { item: gift("gift_nope0001"), key: k })).status, 404);
  assert.equal(store.docs[MAIN].gifted.gift_edit0001.what, "Wooden train set + bridge");
});


test("owner can add a photo to an Under the Tree entry; guests can't, and a guest edit keeps it", async () => {
  fresh();
  const k = key();
  await call("addGifted", { item: gift("gift_photo001"), key: k });
  assert.equal((await call("setPhoto", { kind: "gifted", id: "gift_photo001", image: "https://cdn.example.com/a.jpg" })).status, 403);
  const r = await call("setPhoto", { kind: "gifted", id: "gift_photo001", image: "https://cdn.example.com/a.jpg", url: "https://shop.example.com/p" }, { token: "owner" });
  assert.equal(r.status, 200);
  assert.equal(store.docs[MAIN].gifted.gift_photo001.image, "https://cdn.example.com/a.jpg");
  assert.equal(store.docs[MAIN].gifted.gift_photo001.url, undefined, "no link stored");
  await call("editGifted", { item: gift("gift_photo001", { what: "Renamed" }), key: k });
  assert.equal(store.docs[MAIN].gifted.gift_photo001.image, "https://cdn.example.com/a.jpg");
});
