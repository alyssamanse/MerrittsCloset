// Own file: a fresh process, so the shared guest-write limit starts at zero.
// "Already Under the Tree": guests note gifts they already bought.
const test = require("node:test");
const assert = require("node:assert");
process.env.GUEST_GIFTED = "true";
const { store, MAIN, call, key, logic } = require("./harness");
const PRIV = `${MAIN}/private/owner`;
const fresh = () => { store.docs = { [MAIN]: logic.reduce(null, "init", {}, { isOwner: true, now: 1 }).state }; };
const gift = (id, extra = {}) => ({ id, what: "Wooden train set", cat: "toy", ...extra });


test("a guest's link is kept only in the private record; owners can edit any entry", async () => {
  fresh();
  const k = key();
  const r = await call("addGifted", { item: gift("gift_link0001"), key: k, link: "https://shop.example.com/products/train" });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(store.docs[MAIN]).includes("shop.example.com"), "link leaked into the public doc");
  assert.ok(!JSON.stringify(r.body).includes("shop.example.com"), "link sent back to a guest");
  assert.equal(store.docs[PRIV].giftLinks.gift_link0001, "https://shop.example.com/products/train");
  assert.equal((await call("addGifted", { item: gift("gift_link0002"), key: k, link: "javascript:alert(1)" })).status, 400);
  // guest edit with no link leaves it; a new link replaces it
  await call("editGifted", { item: gift("gift_link0001", { what: "Train" }), key: k });
  assert.equal(store.docs[PRIV].giftLinks.gift_link0001, "https://shop.example.com/products/train");
  await call("editGifted", { item: gift("gift_link0001", { what: "Train" }), key: k, link: "https://shop.example.com/products/train-2" });
  assert.equal(store.docs[PRIV].giftLinks.gift_link0001, "https://shop.example.com/products/train-2");
  // owner edits without a key, and can clear the link
  assert.equal((await call("editGifted", { item: gift("gift_link0001", { what: "Big train" }), link: "" }, { token: "owner" })).status, 200);
  assert.equal(store.docs[MAIN].gifted.gift_link0001.what, "Big train");
  assert.equal(store.docs[PRIV].giftLinks.gift_link0001, undefined);
  // a stranger without the key still can't
  assert.equal((await call("editGifted", { item: gift("gift_link0001", { what: "x" }), key: key() })).status, 403);
  // removing the entry drops its link
  await call("editGifted", { item: gift("gift_link0001", { what: "Big train" }), key: k, link: "https://shop.example.com/a" });
  await call("removeGifted", { id: "gift_link0001", key: k });
  assert.equal(store.docs[PRIV].giftLinks.gift_link0001, undefined);
});
