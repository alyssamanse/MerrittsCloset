// Shared fake firebase-admin + request helper for the API tests. Each test file
// runs in its own process, so each gets fresh rate limits.
const assert = require("node:assert");
const path = require("path");
const crypto = require("crypto");
// ── fake firebase-admin ─────────────────────────────────────────────
const MAIN = "wishlists/w_test1234";
const store = {
  docs: {}, reads: 0, writes: 0,
  get doc() { return this.docs[MAIN] ?? null; }, set doc(v) { this.docs[MAIN] = v; },
};
const snapOf = (path) => { const d = store.docs[path]; return { exists: !!d, data: () => structuredClone(d) }; };
const mkRef = (path) => ({ path, collection: (c) => ({ doc: (id) => mkRef(`${path}/${c}/${id}`) }), async get() { store.reads++; return snapOf(path); } });
const fakeAdmin = {
  apps: [1],
  initializeApp() {},
  firestore: Object.assign(() => ({
    collection: (c) => ({ doc: (id) => mkRef(`${c}/${id}`) }),
    async runTransaction(fn) {
      const pending = {};
      const tx = { async get(ref) { store.reads++; return snapOf(ref.path); }, set(ref, data) { pending[ref.path] = data; } };
      const r = await fn(tx);
      for (const [path, data] of Object.entries(pending)) { store.writes++; const { updatedAt, ...rest } = data; store.docs[path] = rest; }
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


module.exports = { store, MAIN, call, key, item, logic, api };
