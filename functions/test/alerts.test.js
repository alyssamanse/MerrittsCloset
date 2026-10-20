// "Notify me when it's back": sign-up privacy, limits, and one-email-only sending.
const test = require("node:test");
const assert = require("node:assert");
const { store, MAIN, call, key, item, logic, api } = require("./harness");
const { sendDueAlerts, buildEmail } = require("../alerts");
const admin = require("firebase-admin");
const PRIV = `${MAIN}/private/owner`;

function setup(stock = "out") {
  const ctx = { isOwner: true, now: 1 };
  let { state } = logic.reduce(null, "init", {}, ctx);
  ({ state } = logic.reduce(state, "upsertItem", { item: item("item_alert0001", { title: "Toadstool Jammies", url: "https://thesleepysloth.com/products/x", sizeFlexible: true }) }, ctx));
  state.items.item_alert0001.stock = stock;
  store.docs = { [MAIN]: state };
}

test("sign-up: guest can join, address never appears in the public list or response", async () => {
  setup("out");
  const r = await call("subscribe", { itemId: "item_alert0001", email: "Aunt.Jen@Example.com" });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(store.docs[MAIN]).includes("aunt.jen"), "not in the public doc");
  assert.ok(!JSON.stringify(r.body).includes("aunt.jen"), "not echoed to the guest");
  assert.deepEqual(store.docs[PRIV].alerts.item_alert0001.map((x) => x.e), ["aunt.jen@example.com"]);
  // same address twice → still one entry
  await call("subscribe", { itemId: "item_alert0001", email: "aunt.jen@example.com" });
  assert.equal(store.docs[PRIV].alerts.item_alert0001.length, 1);
});

test("sign-up: rejects bad input and items that aren't sold out", async () => {
  setup("out");
  for (const email of ["not-an-email", "a@b", "x@y.com, z@w.com", "<a@b.com>", ""]) {
    assert.equal((await call("subscribe", { itemId: "item_alert0001", email })).status, 400, email);
  }
  assert.equal((await call("subscribe", { itemId: "item_alert0001", email: "a@b.com", extra: 1 })).status, 400);
  assert.equal((await call("subscribe", { itemId: "item_nothere01", email: "a@b.com" })).status, 404);
  setup("in");
  assert.equal((await call("subscribe", { itemId: "item_alert0001", email: "a@b.com" })).status, 400, "in stock → no sign-up");
});

test("sign-up: per-item cap and per-address rate limit", async () => {
  setup("out");
  for (let i = 0; i < 25; i++) store.docs[PRIV] = { ...(store.docs[PRIV] || {}), alerts: { item_alert0001: Array.from({ length: i + 1 }, (_, k) => ({ e: `p${k}@x.com`, at: 1 })) } };
  assert.equal((await call("subscribe", { itemId: "item_alert0001", email: "late@x.com" })).status, 400, "list full");
  setup("out");
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await call("subscribe", { itemId: "item_alert0001", email: `r${i}@x.com` }, { ip: "5.5.5.5" })).status);
  assert.ok(codes.includes(429), `one address is rate-limited: ${codes}`);
});

test("waiting list is dropped (no email) when the item is deleted", async () => {
  setup("out");
  await call("subscribe", { itemId: "item_alert0001", email: "a@b.com" });
  await call("deleteItem", { id: "item_alert0001" }, { token: "owner" });
  assert.equal(store.docs[PRIV].alerts.item_alert0001, undefined);
});

test("sending: one email per address, addresses removed first, never repeats", async () => {
  setup("out");
  await call("subscribe", { itemId: "item_alert0001", email: "a@b.com" });
  await call("subscribe", { itemId: "item_alert0001", email: "c@d.com" });
  const db = admin.firestore();
  const ref = db.collection("wishlists").doc("w_test1234"), privRef = ref.collection("private").doc("owner");
  const sent = [];
  const send = async (m) => { sent.push(m.to); return true; };
  assert.deepEqual(await sendDueAlerts({ db, ref, privRef, key: "k", send }), { sent: 0 }, "still sold out: nothing sent");
  store.docs[MAIN].items.item_alert0001.stock = "in";
  const r = await sendDueAlerts({ db, ref, privRef, key: "k", send });
  assert.equal(r.sent, 2);
  assert.deepEqual(sent.sort(), ["a@b.com", "c@d.com"]);
  assert.equal(store.docs[PRIV].alerts.item_alert0001, undefined, "addresses deleted");
  await sendDueAlerts({ db, ref, privRef, key: "k", send });
  assert.equal(sent.length, 2, "no repeat on the next check");
});

test("sending: a failed send retries (max 3 tries); no key → nothing sent, list kept", async () => {
  setup("in");
  store.docs[PRIV] = { alerts: { item_alert0001: [{ e: "a@b.com", at: 1 }] } };
  const db = admin.firestore();
  const ref = db.collection("wishlists").doc("w_test1234"), privRef = ref.collection("private").doc("owner");
  assert.equal((await sendDueAlerts({ db, ref, privRef, key: "", send: async () => true })).skipped, "no email key");
  assert.equal(store.docs[PRIV].alerts.item_alert0001.length, 1);
  const fail = async () => false;
  await sendDueAlerts({ db, ref, privRef, key: "k", send: fail });
  assert.equal(store.docs[PRIV].alerts.item_alert0001[0].tries, 1);
  await sendDueAlerts({ db, ref, privRef, key: "k", send: fail });
  await sendDueAlerts({ db, ref, privRef, key: "k", send: fail });
  assert.equal(store.docs[PRIV].alerts.item_alert0001, undefined, "gives up after 3 tries");
});

test("email content: escaped, shows size, links to the item and the store", () => {
  const m = buildEmail({ id: "item_x", title: "<b>Jammies</b>", brand: "The Sleepy Sloth", size: "12–18M", sizeFlexible: true, url: "https://thesleepysloth.com/products/x" });
  assert.match(m.subject, /Back in stock/);
  assert.ok(!m.html.includes("<b>Jammies</b>"), "title is escaped");
  assert.match(m.text, /12–18M or bigger/);
  assert.match(m.html, /#item-item_x/);
  assert.match(m.html, /thesleepysloth\.com\/products\/x/);
  assert.match(m.text, /address has now been deleted/);
});

test("daily route: refuses anyone without the scheduler's signed token", async () => {
  const hit = (headers = {}, method = "POST") => new Promise((resolve) => {
    const req = { method, path: "/cron/daily", body: {}, get: (h) => headers[h.toLowerCase()] };
    const res = { statusCode: 200, set() { return this; }, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); }, send(b) { resolve({ status: this.statusCode, body: b }); } };
    api(req, res);
  });
  assert.equal((await hit()).status, 401);
  assert.equal((await hit({ authorization: "Bearer owner" })).status, 401, "a site sign-in is not the scheduler");
  assert.equal((await hit({ authorization: "Bearer garbage" })).status, 401);
  assert.equal((await hit({}, "GET")).status, 405);
});
