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

