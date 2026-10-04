// Run with:  node --test test/
// Exercises the real function handler with a fake Firestore/Auth/App Check,
// plus the pure reducer, so no Firebase project or emulator is needed.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const crypto = require("crypto");

// ── fake firebase-admin ─────────────────────────────────────────────
const store = { doc: null, reads: 0, writes: 0 };
const fakeAdmin = {
  apps: [1],
  initializeApp() {},
  firestore: Object.assign(() => ({
    collection: (c) => ({ doc: (id) => ({ path: `${c}/${id}`, async get() { store.reads++; return { exists: !!store.doc, data: () => structuredClone(store.doc) }; } }) }),
    async runTransaction(fn) {
      const tx = {
        async get() { store.reads++; return { exists: !!store.doc, data: () => structuredClone(store.doc) }; },
        set(_ref, data) { store.pending = data; },
      };
      store.pending = undefined;
      const r = await fn(tx);
      if (store.pending) { store.writes++; const { updatedAt, ...rest } = store.pending; store.doc = rest; }
      return r;
    },
  }), { FieldValue: { serverTimestamp: () => "ts" } }),
  auth: () => ({
    async verifyIdToken(t) {
      if (t === "owner") return { uid: "u1", email: "owner@example.com", email_verified: true, firebase: { sign_in_provider: "google.com" } };
      if (t === "stranger") return { uid: "u2", email: "someone@example.com", email_verified: true, firebase: { sign_in_provider: "google.com" } };
      if (t === "spoof") return { uid: "u3", email: "owner@example.com", email_verified: false, firebase: { sign_in_provider: "password" } };
      throw new Error("bad token");
    },
  }),
  appCheck: () => ({ async verifyToken(t) { if (t !== "good-appcheck") throw new Error("bad"); } }),
};
require.cache[require.resolve("firebase-admin")] = { id: "fa", filename: "fa", loaded: true, exports: fakeAdmin };

Object.assign(process.env, {
  WISHLIST_ID: "w_test1234", OWNER_EMAIL: "owner@example.com",
  ALLOWED_ORIGINS: "https://site.example", REQUIRE_APP_CHECK: "true",
});
require(path.join(__dirname, "..", "index.js"));
const { getFunction } = require("@google-cloud/functions-framework/testing");
const api = getFunction("api");
const logic = require("../logic");

let ipCounter = 0;
async function call(action, payload, { token, appCheck = "good-appcheck", origin = "https://site.example", method = "POST", ip, raw } = {}) {
  const headers = {
    origin, "x-forwarded-for": `9.9.9.9, ${ip || `10.0.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`}`,
    ...(token && { authorization: `Bearer ${token}` }), ...(appCheck && { "x-firebase-appcheck": appCheck }),
  };
  const req = { method, body: raw ?? { action, payload }, ip: "1.1.1.1", get: (h) => headers[h.toLowerCase()] };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      set(k, v) { this.headers[k] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
      send(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
    };
    api(req, res);
  });
}
const key = () => crypto.randomBytes(32).toString("hex");
const item = (id, extra = {}) => ({ id, title: "Zip Romper", brand: "Kyte Baby", size: "12–18M", priority: "most", ...extra });

test("owner can set up and add items; guests cannot", async () => {
  assert.equal((await call("init", {}, { token: "owner" })).status, 200);
  const r = await call("upsertItem", { item: item("item_00000001") }, { token: "owner" });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.items.item_00000001);
  assert.ok(!Object.values(r.body.data.brands).some((b) => b.name === "Kyte Baby"), "items never add Favorite Brands");

  for (const [action, payload] of [
    ["upsertItem", { item: item("item_00000002") }],              // #4 create arbitrary items
    ["deleteItem", { id: "item_00000001" }],                       // #5 delete
    ["upsertItem", { item: item("item_00000001", { price: "$1" }) }], // #6 edit price
    ["setVisibility", { visibility: "private" }],                  // #7 config
    ["resetClaim", { itemId: "item_00000001" }],
  ]) {
    assert.equal((await call(action, payload)).status, 403, `anonymous ${action}`);
    assert.equal((await call(action, payload, { token: "stranger" })).status, 403, `non-owner ${action} (#9)`);
    assert.equal((await call(action, payload, { token: "spoof" })).status, 403, `unverified same-email ${action}`);
  }
  assert.equal(Object.keys(store.doc.items).length, 1);
});

test("guest claim touches only the claim, is idempotent, and only the claimer can undo", async () => {
  const k = key(), other = key();
  const before = structuredClone(store.doc);
  const writes0 = store.writes;
  const r = await call("claim", { itemId: "item_00000001", key: k });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.items, before.items, "item fields unchanged (#8)");
  assert.deepEqual(r.body.data.brands, before.brands);
  assert.equal(store.writes, writes0 + 1);

  // Retry of the same claim (#16): no extra write.
  assert.equal((await call("claim", { itemId: "item_00000001", key: k })).status, 200);
  assert.equal(store.writes, writes0 + 1);

  assert.equal((await call("claim", { itemId: "item_00000001", key: other })).status, 409);
  assert.equal((await call("unclaim", { itemId: "item_00000001", key: other })).status, 403);
  store.doc.claims.item_00000001.at -= 5000; // pass the cooldown
  assert.equal((await call("unclaim", { itemId: "item_00000001", key: k })).status, 200);
  assert.equal(store.doc.claims.item_00000001.h, null);
});

test("guests cannot create documents or claim non-existent items (#15)", async () => {
  const r = await call("claim", { itemId: "made_up_item_1", key: key() });
  assert.equal(r.status, 404);
  assert.ok(!store.doc.claims.made_up_item_1);
});

test("invalid types, unexpected fields and oversized payloads are rejected (#11-13)", async () => {
  const o = { token: "owner" };
  assert.equal((await call("upsertItem", { item: item("item_00000003", { title: 42 }) }, o)).status, 400);
  assert.equal((await call("upsertItem", { item: item("item_00000003", { sizeFlexible: "yes" }) }, o)).status, 400);
  assert.equal((await call("upsertItem", { item: item("item_00000003", { priority: "urgent" }) }, o)).status, 400);
  assert.equal((await call("upsertItem", { item: item("item_00000003", { isAdmin: true }) }, o)).status, 400);
  assert.equal((await call("upsertItem", { item: item("item_00000003"), extra: 1 }, o)).status, 400);
  assert.equal((await call("upsertItem", { item: item("item_00000003", { url: "javascript:alert(1)" }) }, o)).status, 400);
  assert.equal((await call("upsertPrint", { print: { id: "print_000001", brand: "K", types: "Zippy" } }, o)).status, 400);
  assert.equal((await call("upsertPrint", { print: { id: "print_000001", brand: "K", types: Array(9).fill("x").map((x, i) => x + i) } }, o)).status, 400);
  assert.equal((await call("upsertPrint", { print: { id: "print_000001", brand: "K", types: [{}] } }, o)).status, 400);
  assert.equal((await call("upsertItem", { item: item("item_00000003", { title: "x".repeat(121) }) }, o)).status, 400);
  assert.equal((await call("upsertItem", { item: item("../../other") }, o)).status, 400);
  assert.equal((await call("claim", { itemId: "item_00000001", key: "not-a-key" })).status, 400);
  assert.equal((await call("claim", { itemId: "item_00000001", key: key(), owner: true })).status, 400);
  assert.equal((await call(null, null, { raw: { action: "upsertItem", payload: { item: item("item_00000003", { notes: "x".repeat(20000) }) } }, token: "owner" })).status, 413);
  assert.ok(!store.doc.items.item_00000003);
});

test("App Check, origin and method are enforced before any database access", async () => {
  const reads0 = store.reads;
  assert.equal((await call("claim", { itemId: "item_00000001", key: key() }, { appCheck: null })).status, 401);
  assert.equal((await call("claim", { itemId: "item_00000001", key: key() }, { appCheck: "forged" })).status, 401);
  assert.equal((await call("claim", { itemId: "item_00000001", key: key() }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("claim", {}, { method: "GET" })).status, 405);
  assert.equal(store.reads, reads0, "rejected requests cost zero Firestore reads");
});

test("a caller cannot target another wishlist (#2, #14)", async () => {
  // There is no wishlist id in the request at all; extra fields are rejected.
  assert.equal((await call("claim", { itemId: "item_00000001", key: key(), wishlistId: "someone_else" })).status, 400);
  assert.equal((await call(null, null, { raw: { action: "claim", wishlistId: "x", payload: {} } })).status, 400);
});

test("private wishlist is hidden from guests", async () => {
  assert.equal((await call("setVisibility", { visibility: "private" }, { token: "owner" })).status, 200);
  assert.equal((await call("claim", { itemId: "item_00000001", key: key() })).status, 404);
  assert.equal((await call("setVisibility", { visibility: "public" }, { token: "owner" })).status, 200);
});

test("per-IP and global guest write limits cap a script (#15, #16)", async () => {
  const writes0 = store.writes;
  let limited = 0;
  for (let i = 0; i < 60; i++) {
    const r = await call("claim", { itemId: "item_00000001", key: key() }, { ip: "6.6.6.6" });
    if (r.status === 429) { limited++; assert.ok(r.headers["Retry-After"]); }
  }
  assert.ok(limited >= 29, `one IP was throttled (${limited} of 60 refused)`);
  assert.ok(store.writes - writes0 <= 1, "at most one claim actually written");

  // Many IPs (or a forged X-Forwarded-For prefix) still hit the global guest cap.
  let ok = 0;
  for (let i = 0; i < 100; i++) if ((await call("unclaim", { itemId: "item_00000001", key: key() })).status !== 429) ok++;
  assert.ok(ok <= logic.RATES.guestWrites, `global cap held (${ok} got through)`);
});

test("owner retries are idempotent: same item id never duplicates, receive is safe to repeat", async () => {
  const s0 = structuredClone(store.doc);
  const w0 = store.writes;
  const r1 = logic.reduce(s0, "upsertItem", { item: item("item_retry_01") }, { isOwner: true, now: 1 });
  const r2 = logic.reduce(r1.state, "upsertItem", { item: item("item_retry_01") }, { isOwner: true, now: 2 });
  assert.equal(r2.changed, false);
  assert.equal(Object.keys(r2.state.items).length, Object.keys(s0.items).length + 1);
  const m1 = logic.reduce(r1.state, "receive", { id: "item_retry_01" }, { isOwner: true, now: 3 });
  const m2 = logic.reduce(m1.state, "receive", { id: "item_retry_01" }, { isOwner: true, now: 4 });
  assert.equal(m2.changed, false);
  assert.equal(Object.keys(m2.state.prints).length, Object.keys(s0.prints).length + 1);

  // Same brand + print received in a new style: pills merge, no duplicate tile.
  const a = logic.reduce(m2.state, "upsertItem", { item: item("item_zippy_01", { printName: "Strawberry", type: "Zippy" }) }, { isOwner: true, now: 5 });
  const b = logic.reduce(a.state, "receive", { id: "item_zippy_01" }, { isOwner: true, now: 6 });
  const c = logic.reduce(b.state, "upsertItem", { item: item("item_dress_01", { printName: "strawberry", type: "Dress" }) }, { isOwner: true, now: 7 });
  const d = logic.reduce(c.state, "receive", { id: "item_dress_01" }, { isOwner: true, now: 8 });
  const straw = Object.values(d.state.prints).filter((x) => x.printName.toLowerCase() === "strawberry");
  assert.equal(straw.length, 1);
  assert.deepEqual(straw[0].types, ["Zippy", "Dress"]);
  assert.equal(store.writes, w0);
});

test("toys: guests can't add them; received toys go to 'Toys she has' without duplicates", async () => {
  const o = { token: "owner" };
  assert.equal((await call("upsertToy", { toy: { id: "toy_0000001", name: "Stacking cups" } })).status, 403);
  assert.equal((await call("upsertToy", { toy: { id: "toy_0000001", name: "Stacking cups" } }, { token: "stranger" })).status, 403);
  assert.equal((await call("upsertToy", { toy: { id: "toy_0000001", name: "Cups", price: "$5" } }, o)).status, 400, "unexpected field");
  assert.equal((await call("upsertItem", { item: item("toy_item_001", { category: "gadget" }) }, o)).status, 400, "bad category");
  let s = { v: 1, visibility: "public", brands: {}, items: {}, prints: {}, toys: {}, claims: {} };
  const own = { isOwner: true, now: 1 };
  s = logic.reduce(s, "upsertToy", { toy: { id: "toy_0000001", name: "Stacking Cups", brand: "Green Toys" } }, own).state;
  s = logic.reduce(s, "upsertItem", { item: { id: "toy_item_001", category: "toy", title: "Stacking cups", brand: "Green Toys", ageRange: "6m+" } }, own).state;
  s = logic.reduce(s, "upsertItem", { item: { id: "toy_item_002", category: "toy", title: "Bath boat", type: "Bath" } }, own).state;
  s = logic.reduce(s, "receive", { id: "toy_item_001" }, own).state;
  s = logic.reduce(s, "receive", { id: "toy_item_002" }, own).state;
  assert.equal(Object.keys(s.toys).length, 2, "duplicate toy not added twice");
  assert.equal(Object.keys(s.items).length, 0);
  assert.equal(Object.keys(s.prints).length, 0, "toys never land in the clothes closet");
  assert.equal(Object.values(s.toys).find((x) => x.name === "Bath boat").type, "Bath");
});

test("favorites: owner-only, validated", async () => {
  const o = { token: "owner" };
  assert.equal((await call("setFavoriteStyles", { styles: ["Zippy"] })).status, 403);
  assert.equal((await call("setFavoriteStyles", { styles: "Zippy" }, o)).status, 400);
  assert.equal((await call("setFavoriteStyles", { styles: Array.from({ length: 9 }, (_, i) => `S${i}`) }, o)).status, 400);
  const r = await call("setFavoriteStyles", { styles: ["Zippy", "zippy", "Footie"] }, o);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.favoriteStyles, ["Zippy", "Footie"]);
  assert.equal((await call("upsertPrint", { print: { id: "print_fav_01", brand: "K", printName: "Cloud", favorite: "yes" } }, o)).status, 400);
  const p = await call("upsertPrint", { print: { id: "print_fav_01", brand: "K", printName: "Cloud", favorite: true } }, o);
  assert.equal(p.body.data.prints.print_fav_01.favorite, true);
  assert.equal((await call("upsertPrint", { print: { id: "print_fav_01", brand: "K", printName: "Cloud", favorite: false } })).status, 403);
});

test("'other' category: validated, received into 'what she has' with its category", () => {
  const own = { isOwner: true, now: 1 };
  let s = { v: 1, visibility: "public", brands: {}, items: {}, prints: {}, toys: {}, claims: {} };
  assert.throws(() => logic.reduce(s, "upsertToy", { toy: { id: "oth_000001", name: "Quilt", category: "clothes" } }, own), /toy or other/);
  s = logic.reduce(s, "upsertItem", { item: { id: "oth_item_01", category: "other", title: "Muslin blanket", type: "Blanket" } }, own).state;
  s = logic.reduce(s, "receive", { id: "oth_item_01" }, own).state;
  const got = Object.values(s.toys);
  assert.equal(got.length, 1);
  assert.equal(got[0].category, "other");
  assert.equal(Object.keys(s.prints).length, 0);
});

test("style types: owner can add, rename (updating records) and delete (records keep labels)", async () => {
  assert.equal((await call("addType", { category: "clothes", name: "Kimono" })).status, 403);
  assert.equal((await call("deleteType", { category: "clothes", name: "Bow" }, { token: "stranger" })).status, 403);
  const own = { isOwner: true, now: 1 };
  let s = { v: 1, visibility: "public", brands: {}, items: {}, prints: {}, toys: {}, claims: {}, favoriteStyles: ["Zippy"] };
  s = logic.reduce(s, "upsertPrint", { print: { id: "print_typ_01", brand: "K", printName: "Cloud", types: ["Zippy", "Bow"] } }, own).state;
  s = logic.reduce(s, "upsertItem", { item: { id: "item_typ_001", title: "Zip", type: "Zippy" } }, own).state;
  s = logic.reduce(s, "addType", { category: "clothes", name: "Kimono" }, own).state;
  assert.ok(s.typeLists.clothes.includes("Kimono"));
  assert.equal(logic.reduce(s, "addType", { category: "clothes", name: "kimono" }, own).changed, false, "case-insensitive duplicate is a no-op");
  s = logic.reduce(s, "renameType", { category: "clothes", from: "zippy", to: "Zip Romper" }, own).state;
  assert.ok(s.typeLists.clothes.includes("Zip Romper") && !s.typeLists.clothes.includes("Zippy"));
  assert.deepEqual(s.prints.print_typ_01.types, ["Zip Romper", "Bow"]);
  assert.equal(s.items.item_typ_001.type, "Zip Romper");
  assert.deepEqual(s.favoriteStyles, ["Zip Romper"]);
  assert.throws(() => logic.reduce(s, "renameType", { category: "clothes", from: "Footie", to: "dress" }, own), /already in the list/);
  s = logic.reduce(s, "deleteType", { category: "clothes", name: "Bow" }, own).state;
  assert.ok(!s.typeLists.clothes.includes("Bow"));
  assert.deepEqual(s.prints.print_typ_01.types, ["Zip Romper", "Bow"], "existing tags kept");
  assert.throws(() => logic.reduce(s, "addType", { category: "shoes", name: "x" }, own), /Category/);
  assert.throws(() => logic.reduce(s, "addType", { category: "toy", name: "x".repeat(25) }, own), /too long/);
});

test("hard caps stop unbounded growth", () => {
  let s = { v: 1, visibility: "public", brands: {}, items: {}, prints: {}, claims: {} };
  for (let i = 0; i < logic.LIMITS.items; i++) s = logic.reduce(s, "upsertItem", { item: item(`cap_item_${String(i).padStart(4, "0")}`) }, { isOwner: true, now: i }).state;
  assert.throws(() => logic.reduce(s, "upsertItem", { item: item("cap_item_over") }, { isOwner: true, now: 0 }), /up to/);
  const k = key();
  for (let i = 0; i < logic.LIMITS.activeClaimsPerKey; i++) s = logic.reduce(s, "claim", { itemId: `cap_item_${String(i).padStart(4, "0")}`, key: k }, { isOwner: false, now: 1e6 }).state;
  assert.throws(() => logic.reduce(s, "claim", { itemId: "cap_item_0100", key: k }, { isOwner: false, now: 1e6 }), /Undo one first/);
});


test("importBatch: owner-only, bounded, validated, idempotent, one write", async () => {
  const batch = {
    prints: [
      { brand: "Little Sleepies", printName: "Mystic Mermaids", types: ["Zippy", "Bubble"], url: "https://littlesleepies.com/products/mystic-mermaids-zippy" },
      { brand: "Little One Shop", printName: "Sourdough", types: ["Two-piece", "Swim"] },
    ],
    toys: [{ category: "toy", name: "The Looker Play Kit", brand: "Lovevery", type: "Activity" }, { category: "other", name: "Disco Rainbows Fitted Crib Sheet", brand: "Little Sleepies", type: "Bedding" }],
  };
  assert.equal((await call("importBatch", batch)).status, 403, "guests can't import");
  assert.equal((await call("importBatch", batch, { token: "stranger" })).status, 403);
  const o = { token: "owner" };
  assert.equal((await call("importBatch", { prints: Array(41).fill(batch.prints[0]) }, o)).status, 400, "batch cap");
  assert.equal((await call("importBatch", { prints: [{ ...batch.prints[0], price: "$1" }] }, o)).status, 400, "unknown field");
  assert.equal((await call("importBatch", { prints: [{ brand: "K" }] }, o)).status, 400, "print name required");
  assert.equal((await call("importBatch", { toys: [{ name: "x", category: "shoes" }] }, o)).status, 400);
  assert.equal((await call("importBatch", { prints: [], extra: 1 }, o)).status, 400);

  const w0 = store.writes;
  const r = await call("importBatch", batch, o);
  assert.equal(r.status, 200);
  assert.equal(store.writes, w0 + 1, "one write for the whole batch");
  const prints = Object.values(r.body.data.prints).filter((p) => p.printName === "Mystic Mermaids");
  assert.equal(prints.length, 1);
  assert.deepEqual(prints[0].types, ["Zippy", "Bubble"]);
  assert.ok(Object.values(r.body.data.toys).some((t) => t.name === "The Looker Play Kit"));
  assert.ok(r.body.data.typeLists.clothes.includes("Swim"), "new styles join her list"); assert.ok(!r.body.data.typeLists.other, "existing choices untouched");

  const w1 = store.writes;
  assert.equal((await call("importBatch", batch, o)).status, 200);
  assert.equal(store.writes, w1, "re-running the same batch writes nothing");

  const r2 = await call("importBatch", { prints: [{ brand: "little sleepies", printName: "MYSTIC MERMAIDS", types: ["Dress"] }] }, o);
  const merged = Object.values(r2.body.data.prints).filter((p) => p.printName.toLowerCase() === "mystic mermaids");
  assert.equal(merged.length, 1, "merges by brand + print, ignoring case");
  assert.deepEqual(merged[0].types, ["Zippy", "Bubble", "Dress"]);
});

test("outgrown: owner sets it, imports carry it, a received gift clears it", async () => {
  const o = { token: "owner" };
  assert.equal((await call("upsertPrint", { print: { id: "print_out_01", brand: "K", printName: "Moon", outgrown: "yes" } }, o)).status, 400);
  assert.equal((await call("upsertPrint", { print: { id: "print_out_01", brand: "K", printName: "Moon", outgrown: true } })).status, 403);
  const r = await call("upsertPrint", { print: { id: "print_out_01", brand: "K", printName: "Moon", types: ["Zippy"], outgrown: true } }, o);
  assert.equal(r.body.data.prints.print_out_01.outgrown, true);
  const r2 = await call("importBatch", { prints: [{ brand: "K", printName: "Sun", types: ["Zippy"], outgrown: true }] }, o);
  assert.equal(Object.values(r2.body.data.prints).find((p) => p.printName === "Sun").outgrown, true);
  assert.equal((await call("importBatch", { prints: [{ brand: "K", printName: "Sun", outgrown: "no" }] }, o)).status, 400);
  const own = { isOwner: true, now: 1 };
  let s = { v: 1, visibility: "public", brands: {}, items: {}, prints: { print_out_02: { id: "print_out_02", brand: "K", printName: "Moon", types: ["Zippy"], outgrown: true } }, toys: {}, claims: {} };
  s = logic.reduce(s, "upsertItem", { item: { id: "item_out_001", title: "Moon dress", brand: "K", printName: "Moon", type: "Dress" } }, own).state;
  s = logic.reduce(s, "receive", { id: "item_out_001" }, own).state;
  assert.equal(s.prints.print_out_02.outgrown, false);
  assert.deepEqual(s.prints.print_out_02.types, ["Zippy", "Dress"]);
});

test("setColors: owner-only, validated, ordered, no-op when unchanged", async () => {
  const o = { token: "owner" };
  const colors = [{ name: "Lavender", hex: "#cdb8d9" }, { name: "Sage", hex: "#A7B8A0" }];
  assert.equal((await call("setColors", { colors })).status, 403);
  assert.equal((await call("setColors", { colors }, { token: "stranger" })).status, 403);
  assert.equal((await call("setColors", { colors: [{ name: "Red", hex: "red" }] }, o)).status, 400);
  assert.equal((await call("setColors", { colors: [{ name: "Red", hex: "#ff0000", note: "x" }] }, o)).status, 400);
  assert.equal((await call("setColors", { colors: [{ name: "", hex: "#ff0000" }] }, o)).status, 400);
  assert.equal((await call("setColors", { colors: [colors[0], { name: "lavender", hex: "#000000" }] }, o)).status, 400, "duplicate names");
  assert.equal((await call("setColors", { colors: Array.from({ length: 25 }, (_, i) => ({ name: "C" + i, hex: "#111111" })) }, o)).status, 400);
  const r = await call("setColors", { colors }, o);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.colors, [{ name: "Lavender", hex: "#CDB8D9" }, { name: "Sage", hex: "#A7B8A0" }]);
  const w = store.writes;
  await call("setColors", { colors }, o);
  assert.equal(store.writes, w, "unchanged list writes nothing");
  const r2 = await call("setColors", { colors: [] }, o);
  assert.deepEqual(r2.body.data.colors, []);
});

test("findPhotos / checkStock: owner-only, bounded, save results in one write", async () => {
  const o = { token: "owner" };
  // Seed a print and two wishlist items with links.
  await call("upsertPrint", { print: { id: "print_photo1", brand: "LS", printName: "Petals", url: "https://shop.example/products/petals-zippy" } }, o);
  await call("upsertItem", { item: { id: "item_stock01", title: "Gone", url: "https://shop.example/products/gone" } }, o);
  await call("upsertItem", { item: { id: "item_stock02", title: "Here", url: "https://shop.example/products/here" } }, o);
  const realFetch = global.fetch;
  global.fetch = async (u) => {
    const href = String(u);
    const resp = (status, body) => ({ ok: status < 400, status, url: href, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
    if (href.endsWith("/petals-zippy.js")) return resp(200, JSON.stringify({ title: "Petals Zippy", featured_image: "//cdn.example/petals.jpg", available: true }));
    if (href.endsWith("/gone.js")) return resp(404, "");
    if (href.endsWith("/here.js")) return resp(200, JSON.stringify({ title: "Here", available: true }));
    if (href.endsWith("/small-only.js")) return resp(200, JSON.stringify({ title: "Small", available: true, options: ["Size"], variants: [{ option1: "Newborn", available: true }, { option1: "12-18M", available: false }] }));
    if (href.endsWith("/big-left.js")) return resp(200, JSON.stringify({ title: "Big", available: true, options: ["Size"], variants: [{ option1: "0-3M", available: false }, { option1: "18-24M", available: true }] }));
    return resp(404, "");
  };
  try {
    assert.equal((await call("findPhotos", { ids: ["print_photo1"] })).status, 403);
    assert.equal((await call("checkStock", { ids: ["item_stock01"] }, { token: "stranger" })).status, 403);
    assert.equal((await call("findPhotos", { ids: [] }, o)).status, 400);
    assert.equal((await call("findPhotos", { ids: Array(11).fill("print_photo1") }, o)).status, 400);
    assert.equal((await call("findPhotos", { ids: ["../x"] }, o)).status, 400);
    assert.equal((await call("findPhotos", { ids: ["print_photo1"], url: "x" }, o)).status, 400);
    const w = store.writes;
    const r = await call("findPhotos", { ids: ["print_photo1"] }, o);
    assert.equal(r.status, 200);
    assert.equal(r.body.found, 1);
    assert.equal(r.body.data.prints.print_photo1.image, "https://cdn.example/petals.jpg");
    assert.equal(store.writes, w + 1);
    const s = await call("checkStock", { ids: ["item_stock01", "item_stock02"] }, o);
    assert.equal(s.status, 200);
    assert.equal(s.body.found, 1);
    assert.equal(s.body.data.items.item_stock01.stock, "out");
    assert.equal(s.body.data.items.item_stock02.stock, "in");
    // Size-aware: she's in 6–12M at this brand.
    await call("upsertBrand", { brand: { id: "brand_sz_0001", name: "Sizey", currentSize: "6–12M" } }, o);
    await call("upsertItem", { item: { id: "item_stock03", title: "Small", brand: "Sizey", url: "https://shop.example/products/small-only" } }, o);
    await call("upsertItem", { item: { id: "item_stock04", title: "Big", brand: "Sizey", url: "https://shop.example/products/big-left" } }, o);
    const z = await call("checkStock", { ids: ["item_stock03", "item_stock04"] }, o);
    assert.equal(z.body.data.items.item_stock03.stock, "out", "only newborn left counts as sold out");
    assert.equal(z.body.data.items.item_stock04.stock, "in", "a bigger size left counts as in stock");
  } finally { global.fetch = realFetch; }
  // Direct result writes are owner-only and validated.
  assert.equal((await call("setStock", { results: [{ id: "item_stock01", stock: "in" }] })).status, 403);
  assert.equal((await call("setStock", { results: [{ id: "item_stock01", stock: "maybe" }] }, o)).status, 400);
  assert.equal((await call("setImages", { images: [{ id: "print_photo1", image: "javascript:alert(1)" }] }, o)).status, 400);
});

test("plans: owner-only, validated, capped", async () => {
  const o = { token: "owner" };
  const plan = { id: "plan_christmas", name: "Christmas", date: "2026-12-25", note: "", rows: [
    { brand: "Little Sleepies", style: "Two-piece PJs", size: "12–18M" },
    { brand: "Little Sleepies", style: "Dress", size: "18–24M" },
    { brand: "Little Sleepies", style: "Zippy", skip: true },
  ] };
  assert.equal((await call("setPlan", { plan })).status, 403);
  assert.equal((await call("setPlan", { plan: { ...plan, date: "Dec 25" } }, o)).status, 400);
  assert.equal((await call("setPlan", { plan: { ...plan, rows: [{ brand: "LS" }] } }, o)).status, 400);
  assert.equal((await call("setPlan", { plan: { ...plan, rows: [{ brand: "LS", size: "2T", skip: true }] } }, o)).status, 400);
  assert.equal((await call("setPlan", { plan: { ...plan, rows: Array(81).fill(plan.rows[0]) } }, o)).status, 400);
  assert.equal((await call("setPlan", { plan: { ...plan, extra: 1 } }, o)).status, 400);
  const r = await call("setPlan", { plan }, o);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.plans.length, 1);
  assert.equal(r.body.data.plans[0].rows[2].skip, true);
  const w = store.writes;
  await call("setPlan", { plan }, o);
  assert.equal(store.writes, w, "unchanged plan writes nothing");
  for (let i = 0; i < 7; i++) await call("setPlan", { plan: { ...plan, id: `plan_extra_${i}`, name: "P" + i } }, o);
  assert.equal((await call("setPlan", { plan: { ...plan, id: "plan_too_many", name: "X" } }, o)).status, 400);
  const d = await call("deletePlan", { id: "plan_christmas" }, o);
  assert.ok(!d.body.data.plans.some((p) => p.id === "plan_christmas"));
});

test("family wishlist: owner adds, guests claim anonymously, validated and capped", async () => {
  const o = { token: "owner" };
  const item = { id: "fam_item_0001", person: "Penny", category: "other", title: "Squeaky Duck", brand: "BARK", url: "https://shop.example/products/duck" };
  assert.equal((await call("upsertFamilyItem", { item })).status, 403, "guests can't add");
  assert.equal((await call("upsertFamilyItem", { item: { ...item, person: "" } }, o)).status, 400);
  assert.equal((await call("upsertFamilyItem", { item: { ...item, category: "toy" } }, o)).status, 400);
  assert.equal((await call("upsertFamilyItem", { item: { ...item, sizes: Array(9).fill("M") } }, o)).status, 400);
  assert.equal((await call("upsertFamilyItem", { item: { ...item, extra: 1 } }, o)).status, 400);
  const r = await call("upsertFamilyItem", { item: { ...item, id: "fam_item_0002", person: "Lys", category: "clothes", title: "Linen Shirt", sizes: ["M", "m", "Tall"] } }, o);
  assert.deepEqual(r.body.data.family.fam_item_0002.sizes, ["M", "Tall"], "sizes de-duplicated");
  await call("upsertFamilyItem", { item }, o);
  // Claims go through the same reducer as wishlist claims (HTTP guest bucket is used up by earlier tests).
  const k = key();
  const st = structuredClone(store.doc);
  const claimed = logic.reduce(st, "claim", { itemId: "fam_item_0001", key: k }, { isOwner: false, now: 5e9 });
  assert.ok(claimed.state.claims.fam_item_0001.h, "guests can claim family items");
  assert.throws(() => logic.reduce(claimed.state, "claim", { itemId: "fam_item_0001", key: key() }, { isOwner: false, now: 5e9 + 10 }), /already claimed/);
  store.doc = claimed.state;
  const d = await call("deleteFamilyItem", { id: "fam_item_0001" }, o);
  assert.ok(!d.body.data.family.fam_item_0001 && !d.body.data.claims.fam_item_0001, "delete clears the claim too");
  assert.equal((await call("deleteFamilyItem", { id: "fam_item_0002" })).status, 403);
});

test("brand spellings: imports merge across variants and don't fill Favorite Brands", () => {
  const own = { isOwner: true, now: 1 };
  let s = { v: 1, visibility: "public", brands: {}, items: {}, prints: {}, toys: {}, claims: {} };
  s = logic.reduce(s, "importBatch", { prints: [{ brand: "The Sleepy Sloth", printName: "Bootanicals", types: ["Zippy"] }] }, own).state;
  s = logic.reduce(s, "importBatch", { prints: [{ brand: "Sleepy Sloth", printName: "bootanicals", types: ["Dress"] }] }, own).state;
  const ps = Object.values(s.prints);
  assert.equal(ps.length, 1, "same print under two spellings merges");
  assert.deepEqual(ps[0].types, ["Zippy", "Dress"]);
  assert.equal(Object.keys(s.brands).length, 0, "imports leave Favorite Brands alone");
  assert.equal(logic.brandKey("Little One Shop"), logic.brandKey("Little One Co"));
  s = logic.reduce(s, "upsertBrand", { brand: { id: "brand_los_001", name: "Little One Shop", currentSize: "", notes: "" } }, own).state;
  s = logic.reduce(s, "upsertItem", { item: { id: "item_los_0001", title: "Set", brand: "Little One Co" } }, own).state;
  assert.equal(Object.keys(s.brands).length, 1, "a variant spelling doesn't add a second brand");
});

test("bulkCloset: owner-only, validated, one write for many prints", async () => {
  const o = { token: "owner" };
  for (const n of ["bulk_print_01", "bulk_print_02", "bulk_print_03"]) await call("upsertPrint", { print: { id: n, brand: "B", printName: n } }, o);
  assert.equal((await call("bulkCloset", { kind: "prints", ids: ["bulk_print_01"], op: "delete" })).status, 403);
  assert.equal((await call("bulkCloset", { kind: "prints", ids: ["bulk_print_01"], op: "explode" }, o)).status, 400);
  assert.equal((await call("bulkCloset", { kind: "toys", ids: ["bulk_print_01"], op: "favorite" }, o)).status, 400);
  assert.equal((await call("bulkCloset", { kind: "prints", ids: [], op: "favorite" }, o)).status, 400);
  assert.equal((await call("bulkCloset", { kind: "prints", ids: ["../x"], op: "favorite" }, o)).status, 400);
  const w = store.writes;
  const f = await call("bulkCloset", { kind: "prints", ids: ["bulk_print_01", "bulk_print_02"], op: "favorite" }, o);
  assert.equal(store.writes, w + 1);
  assert.ok(f.body.data.prints.bulk_print_01.favorite && f.body.data.prints.bulk_print_02.favorite && !f.body.data.prints.bulk_print_03.favorite);
  const d = await call("bulkCloset", { kind: "prints", ids: ["bulk_print_02", "bulk_print_03", "not_there_99"], op: "delete" }, o);
  assert.ok(!d.body.data.prints.bulk_print_02 && !d.body.data.prints.bulk_print_03 && d.body.data.prints.bulk_print_01);
});
