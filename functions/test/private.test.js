// Gifter names: stored only in the owner-only private document.
const test = require("node:test");
const assert = require("node:assert");
const { store, MAIN, call, key, item, logic } = require("./harness");

test("gifter names stay private: never in the public doc, only returned to the owner", async () => {
  const ctx = { isOwner: true, now: 1 };
  let { state } = logic.reduce(null, "init", {}, ctx);
  ({ state } = logic.reduce(state, "upsertItem", { item: item("item_priv0001", { title: "Sun Hat" }) }, ctx));
  store.docs = { [MAIN]: state };
  const k = key();
  const r = await call("claim", { itemId: "item_priv0001", key: k, from: "Aunt Jen" });
  assert.equal(r.status, 200);
  assert.equal(r.body.private, undefined, "guest response has no names");
  assert.ok(!JSON.stringify(store.docs[MAIN]).includes("Aunt Jen"), "public doc never holds the name");
  assert.ok(!JSON.stringify(r.body).includes("Aunt Jen"));
  assert.equal(store.docs[`${MAIN}/private/owner`].givers.item_priv0001.from, "Aunt Jen");
  assert.equal((await call("getPrivate", {}, { token: "stranger" })).status, 403);
  assert.equal((await call("getPrivate", {})).status, 403);
  const own = await call("getPrivate", {}, { token: "owner" });
  assert.equal(own.body.private.givers.item_priv0001.from, "Aunt Jen");
  // a too-long name is rejected; "from" is not allowed on unclaim
  assert.equal((await call("claim", { itemId: "item_priv0001", key: key(), from: "x".repeat(41) })).status, 400);
  // gift arrives → name moves to the thank-you list
  const rec = await call("receive", { id: "item_priv0001" }, { token: "owner" });
  assert.equal(rec.status, 200);
  const thanks = Object.values(rec.body.private.thanks);
  assert.equal(thanks.length, 1);
  assert.deepEqual([thanks[0].title, thanks[0].from, thanks[0].done], ["Sun Hat", "Aunt Jen", false]);
  assert.equal(rec.body.private.givers.item_priv0001, undefined);
  const done = await call("setThank", { id: thanks[0].id, done: true }, { token: "owner" });
  assert.equal(Object.values(done.body.private.thanks)[0].done, true);
  const added = await call("addThank", { title: "Board books", from: "Grandma" }, { token: "owner" });
  assert.equal(Object.keys(added.body.private.thanks).length, 2);
  assert.equal((await call("addThank", { title: "x", from: "y", extra: 1 }, { token: "owner" })).status, 400);
  const del = await call("deleteThank", { id: thanks[0].id }, { token: "owner" });
  assert.equal(Object.keys(del.body.private.thanks).length, 1);
});


test("hidden wishlist items: kept out of the public doc entirely, owner-only", async () => {
  const ctx = { isOwner: true, now: 1 };
  let { state } = logic.reduce(null, "init", {}, ctx);
  ({ state } = logic.reduce(state, "upsertItem", { item: item("item_hide0001", { title: "Wooden Kitchen" }) }, ctx));
  store.docs = { [MAIN]: state };
  // a hidden item saved directly
  assert.equal((await call("upsertDraft", { item: item("item_hide0002", { title: "Secret Stroller" }) }, { token: "owner" })).status, 200);
  assert.equal((await call("upsertDraft", { item: item("item_hide0003") })).status, 403, "guests can't save hidden items");
  assert.ok(!JSON.stringify(store.docs[MAIN]).includes("Secret Stroller"), "hidden item never in the public doc");
  // hide a public item: it leaves the public doc and lands in the private one
  const h = await call("hideItem", { id: "item_hide0001" }, { token: "owner" });
  assert.equal(h.status, 200);
  assert.ok(!JSON.stringify(store.docs[MAIN]).includes("Wooden Kitchen"));
  assert.equal(h.body.private.drafts.item_hide0001.title, "Wooden Kitchen");
  assert.equal((await call("hideItem", { id: "item_hide0001" })).status, 403, "guests can't hide");
  // a guest can't claim a hidden item
  assert.equal((await call("claim", { itemId: "item_hide0002", key: key() })).status, 404);
  // show it again
  const s = await call("showItem", { id: "item_hide0001" }, { token: "owner" });
  assert.equal(s.body.data.items.item_hide0001.title, "Wooden Kitchen");
  assert.equal(s.body.private.drafts.item_hide0001, undefined);
  // a claimed item can't be hidden (so nobody's claim silently vanishes)
  assert.equal((await call("claim", { itemId: "item_hide0001", key: key() })).status, 200);
  assert.equal((await call("hideItem", { id: "item_hide0001" }, { token: "owner" })).status, 400);
  // delete a hidden item
  const d = await call("deleteDraft", { id: "item_hide0002" }, { token: "owner" });
  assert.equal(d.body.private.drafts.item_hide0002, undefined);
});
