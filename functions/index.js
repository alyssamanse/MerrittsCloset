// Merritt's Closet API — the ONLY way anything gets written.
// Firestore rules deny every client write; this function uses the Admin SDK.
//
// Deploy settings (Cloud Run functions console):
//   entry point: api · Node.js 22 · max instances: 1 · concurrency: 20
//   memory: 256 MiB · timeout: 30 s · allow unauthenticated invocations
//
// Every request passes, in order:
//   1. origin + method + size checks       (cheap rejects, no Firestore)
//   2. per-IP rate limit                   (no Firestore)
//   3. App Check token                      (no Firestore)
//   4. owner ID token for owner actions     (no Firestore)
//   5. action rate limit                    (no Firestore)
//   6. validation + change: reads the list (and the owner-only private doc) and
//      writes only what changed, in one transaction

const functions = require("@google-cloud/functions-framework");
const admin = require("firebase-admin");
const { reduce, sizeForStyle, brandKey, reducePrivate, PRIVATE_ACTIONS, publicView, Limiter, RATES, ApiError, GUEST_ACTIONS, OWNER_ACTIONS } = require("./logic");
const crypto = require("crypto");
const { importLink, checkStock } = require("./importer");

const ENV = {
  wishlistId: process.env.WISHLIST_ID || "",
  ownerEmail: (process.env.OWNER_EMAIL || "").toLowerCase(),
  ownerUid: process.env.OWNER_UID || "",                 // optional: pin to one account once known
  requireAppCheck: process.env.REQUIRE_APP_CHECK === "true",
  origins: (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
};
const MAX_BODY = 16 * 1024;
const LOOKUP_MAX = 10;

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const limiter = new Limiter();

function clientIp(req) {
  // Cloud Run appends the connecting address as the LAST X-Forwarded-For entry;
  // earlier entries can be forged, so they're ignored. Best effort only —
  // the global guest-write cap is the real ceiling.
  const xff = (req.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.ip || "unknown";
}

function limit(key, perMinute) {
  const wait = limiter.take(key, perMinute);
  if (wait) { const e = new ApiError(429, "Too many requests — please wait a moment."); e.retryAfter = wait; throw e; }
}

async function checkAppCheck(req) {
  const token = req.get("X-Firebase-AppCheck");
  if (!token) {
    if (ENV.requireAppCheck) throw new ApiError(401, "Please refresh the page and try again.");
    console.warn("app-check: missing token (not enforced)");
    return;
  }
  try {
    await admin.appCheck().verifyToken(token);
  } catch {
    if (ENV.requireAppCheck) throw new ApiError(401, "Please refresh the page and try again.");
    console.warn("app-check: invalid token (not enforced)");
  }
}

async function isOwner(req) {
  const raw = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!raw) return false;
  let t;
  try { t = await admin.auth().verifyIdToken(raw, true); } catch { throw new ApiError(401, "Please sign in again."); }
  const ok =
    !!ENV.ownerEmail &&
    (t.email || "").toLowerCase() === ENV.ownerEmail &&
    t.email_verified === true &&
    t.firebase?.sign_in_provider === "google.com" &&
    (!ENV.ownerUid || t.uid === ENV.ownerUid);
  return ok;
}

const trim = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");

functions.http("api", async (req, res) => {
  const origin = req.get("Origin") || "";
  const allowed = ENV.origins.includes(origin);
  if (allowed) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Firebase-AppCheck");
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Max-Age", "3600");
  }
  if (req.method === "OPTIONS") return res.status(allowed ? 204 : 403).send("");

  try {
    if (!ENV.wishlistId || !ENV.ownerEmail) throw new ApiError(503, "The wishlist isn't configured yet.");
    if (!allowed) throw new ApiError(403, "Not allowed from this site.");
    if (req.method !== "POST") throw new ApiError(405, "POST only");
    if (Number(req.get("content-length") || 0) > MAX_BODY || Buffer.byteLength(JSON.stringify(req.body || {})) > MAX_BODY) {
      throw new ApiError(413, "That's too much data.");
    }

    limit(`ip:${clientIp(req)}`, RATES.perIp);
    await checkAppCheck(req);

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "Bad request");
    for (const k of Object.keys(body)) if (k !== "action" && k !== "payload") throw new ApiError(400, `Unexpected field "${k}"`);
    const { action, payload } = body;
    if (typeof action !== "string") throw new ApiError(400, "Missing action");
    const owner = await isOwner(req);

    if (action === "import") {
      if (!owner) throw new ApiError(403, "Only the owner can import links.");
      limit("imports", RATES.imports);
      const r = await importLink(payload?.url);
      return res.json({
        ok: true,
        product: {
          url: trim(r.url, 600), title: trim(r.title, 120), brand: trim(r.brand, 60), printName: trim(r.printName, 80),
          price: trim(r.price, 20), image: trim(r.image, 600),
          sizes: (r.sizes || []).slice(0, 30).map((s) => trim(s, 20)),
          fromArchive: !!r.fromArchive,
        },
      });
    }

    // Owner-only lookups that read store pages, then save what they found in one write.
    // At most LOOKUP_MAX pages per call (fetched in parallel, 9 s timeout each) and 8 calls a minute.
    if (action === "findPhotos" || action === "checkStock") {
      if (!owner) throw new ApiError(403, "Only the owner can do that.");
      limit("lookups", RATES.lookups);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ApiError(400, "Bad request");
      for (const k of Object.keys(payload)) if (k !== "ids") throw new ApiError(400, `Unexpected field "${k}"`);
      const ids = payload.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > LOOKUP_MAX || !ids.every((x) => typeof x === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(x))) {
        throw new ApiError(400, `Send 1 to ${LOOKUP_MAX} ids`);
      }
      const ref = db.collection("wishlists").doc(ENV.wishlistId);
      const snap = await ref.get();
      if (!snap.exists) throw new ApiError(404, "This wishlist isn't set up yet.");
      const doc = snap.data();
      const recs = ids.map((x) => (action === "findPhotos" ? doc.prints : doc.items)?.[x]).filter((r) => r && r.url);
      let reduceAction, reducePayload, found = 0;
      if (action === "findPhotos") {
        const images = (await Promise.all(recs.map(async (r) => {
          // Each lookup gets 24 s (live page, then the Wayback Machine) so the call ends inside Cloud Run's 30 s limit.
          const deadline = new Promise((res) => setTimeout(() => res(null), 24000));
          try { const p = await Promise.race([importLink(r.url), deadline]); return p?.image ? { id: r.id, image: trim(p.image, 600) } : null; } catch { return null; }
        }))).filter(Boolean);
        found = images.length;
        reduceAction = "setImages"; reducePayload = { images };
      } else {
        // Sold out only if nothing is left in the size gifters should buy (the item's size,
        // else her current size for that brand) or bigger.
        const brandOf = (name) => Object.values(doc.brands || {}).find((b) => brandKey(b.name) === brandKey(name));
        const results = await Promise.all(recs.map(async (r) => ({ id: r.id, stock: await checkStock(r.url, r.size || sizeForStyle(brandOf(r.brand), r.type, r.title)).catch(() => "unknown") })));
        found = results.filter((r) => r.stock === "out").length;
        reduceAction = "setStock"; reducePayload = { results, at: Date.now() };
      }
      const result = await db.runTransaction(async (tx) => {
        const s2 = await tx.get(ref);
        const prev = s2.exists ? s2.data() : null;
        const { state, changed } = reduce(prev, reduceAction, reducePayload, { isOwner: true, now: Date.now() });
        if (changed) tx.set(ref, { ...state, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        return state;
      }, { maxAttempts: 3 });
      return res.json({ ok: true, checked: recs.length, found, data: publicView(result) });
    }

    const ref = db.collection("wishlists").doc(ENV.wishlistId);
    // Owner-only private doc (gifter names, thank-you list). Firestore rules deny
    // every client read/write of subcollections, so only this API can reach it.
    const privRef = ref.collection("private").doc("owner");
    const newId = () => crypto.randomBytes(10).toString("hex");

    if (PRIVATE_ACTIONS.has(action)) {
      if (!owner) throw new ApiError(403, "Only the owner can do that.");
      limit("owner-writes", RATES.ownerWrites);
      const priv = await db.runTransaction(async (tx) => {
        const ps = await tx.get(privRef);
        const prevPriv = ps.exists ? ps.data() : null;
        if (action === "getPrivate") return prevPriv;
        const { priv: next, changed } = reducePrivate(prevPriv, action, payload, { isOwner: true, now: Date.now(), newId });
        if (changed) tx.set(privRef, next);
        return next;
      }, { maxAttempts: 3 });
      return res.json({ ok: true, private: priv || { givers: {}, thanks: {}, drafts: {} } });
    }

    if (GUEST_ACTIONS.has(action)) limit("guest-writes", RATES.guestWrites);
    else if (OWNER_ACTIONS.has(action)) {
      if (!owner) throw new ApiError(403, "Only the owner can do that.");
      limit("owner-writes", RATES.ownerWrites);
    } else throw new ApiError(400, "Unknown action");

    // The wishlist id comes from server config, never from the request,
    // so a caller cannot point this at any other document.
    // Only actions that can touch gifter names read the private doc.
    const touchesPrivate = ["claim", "unclaim", "resetClaim", "deleteItem", "receive", "deleteFamilyItem", "hideItem", "showItem"].includes(action);
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const ps = touchesPrivate ? await tx.get(privRef) : null;
      const prev = snap.exists ? snap.data() : null;
      if (prev && prev.visibility !== "public" && !owner) throw new ApiError(404, "This wishlist isn't available.");
      const now = Date.now();
      // "from" (a gifter's name) is validated by reduce but stored only in the private doc.
      const prevPriv = ps?.exists ? ps.data() : null;
      const { state, changed } = reduce(prev, action, payload, { isOwner: owner, now, priv: prevPriv });
      let priv = null;
      if (touchesPrivate) {
        const r = reducePrivate(prevPriv, action, payload, { prevPublic: prev, nextPublic: state, publicChanged: changed, isOwner: owner, now, newId });
        priv = r.priv;
        if (r.changed) tx.set(privRef, r.priv);
      }
      if (changed) tx.set(ref, { ...state, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { state, priv };
    }, { maxAttempts: 3 });

    // Gifter names go back only to the owner; guests get the public view only.
    res.json({ ok: true, data: publicView(out.state), ...(owner && out.priv && { private: out.priv }) });
  } catch (e) {
    const status = e.status || 500;
    if (e.retryAfter) res.set("Retry-After", String(e.retryAfter));
    if (status >= 500) console.error(e);
    else console.warn(`rejected ${status}: ${e.message}`);
    res.status(status).json({ ok: false, error: e.status ? e.message : "Something went wrong — try again later." });
  }
});
