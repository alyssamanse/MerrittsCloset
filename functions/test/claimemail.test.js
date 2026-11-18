// "Someone's getting it" emails to the owner. Own file: these env settings must exist before the server loads.
process.env.CLAIM_EMAIL_TO = "owner@example.com";
process.env.RESEND_API_KEY = "re_test";
const test = require("node:test");
const assert = require("node:assert");
const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith("https://api.resend.com/")) { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; }
  return realFetch(url, opts);
};
const { store, MAIN, call, key, item, logic } = require("./harness");

function setup(n = 1) {
  const ctx = { isOwner: true, now: 1 };
  let { state } = logic.reduce(null, "init", {}, ctx);
  for (let i = 0; i < n; i++) ({ state } = logic.reduce(state, "upsertItem", { item: item(`item_mail${String(i).padStart(4, "0")}`, { title: `Sun Hat ${i}` }) }, ctx));
  store.docs = { [MAIN]: state };
}

test("claiming emails the owner, with the name only if one was left; undo and repeats don't", async () => {
  setup(2); sent.length = 0;
  const k = key();
  assert.equal((await call("claim", { itemId: "item_mail0000", key: k, from: "Aunt Jen" })).status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["owner@example.com"]);
  assert.match(sent[0].subject, /Aunt Jen is getting Kyte Baby Sun Hat 0/);
  assert.match(sent[0].html, /#item-item_mail0000/);
  await call("claim", { itemId: "item_mail0000", key: k });          // already theirs: no change, no email
  assert.equal(sent.length, 1);
  await call("claim", { itemId: "item_mail0001", key: key() });       // no name
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /^🎁 Someone is getting/);
  assert.match(sent[1].text, /didn't leave a name/);
  assert.ok(!/<script/i.test(sent[1].html));
});

test("a name can't inject HTML into the email", async () => {
  setup(1); sent.length = 0;
  await call("claim", { itemId: "item_mail0000", key: key(), from: "<img src=x onerror=1>" });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].html.includes("<img src=x"), "name not escaped");
});

test("at most 20 claim emails a day", async () => {
  setup(25); sent.length = 0;
  for (let i = 0; i < 25; i++) await call("claim", { itemId: `item_mail${String(i).padStart(4, "0")}`, key: key() });
  assert.ok(sent.length <= 20, `sent ${sent.length}`);
});
