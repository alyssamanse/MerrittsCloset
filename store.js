// Data layer. Two interchangeable back ends with the same API:
//   createFirebaseStore() — real: one Firestore document read + the `api` function for every change
//   createDemoStore()     — in-memory sample data for ?demo previews (nothing saved)
//
// Cost rules this file follows:
//   • A page load reads ONE document (or zero, if a fresh cached copy exists).
//   • No real-time listeners and no polling. Refresh happens on load, when the tab
//     comes back after 10+ minutes, or on a manual refresh (at most every 30 s).
//   • Every change returns the updated wishlist, so no re-read after writes.
//   • Retries are capped (2) with backoff, only for transient errors, and every
//     change is idempotent on the server, so a retry can't double a write.
//   • Identical in-flight requests are merged (double taps send one request).
import { CONFIG } from "./config.js?v=1004-0819";

const SDK = "https://www.gstatic.com/firebasejs/11.0.2";
const CACHE_KEY = `closet:${CONFIG.wishlistId}`;
const CACHE_FRESH_MS = 2 * 60_000;
const REFRESH_ON_RETURN_MS = 10 * 60_000;
const MANUAL_REFRESH_MS = 30_000;
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => 800 * 2 ** n + Math.random() * 400;

const storage = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: no cache */ } },
};

// A random key that lives in this browser. Claims store only a hash of it,
// so only this browser can undo its own claim.
function claimKey() {
  let k = storage.get("closet:claimKey");
  if (typeof k !== "string" || !/^[0-9a-f]{64}$/.test(k)) {
    k = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    storage.set("closet:claimKey", k);
  }
  return k;
}
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function mineFrom(data) {
  const key = claimKey();
  const mine = new Set();
  for (const [itemId, c] of Object.entries(data?.claims || {})) {
    if (c?.h && c.h === (await sha256hex(`${key}:${itemId}`))) mine.add(itemId);
  }
  return mine;
}

class FriendlyError extends Error {}

export async function createFirebaseStore() {
  const [{ initializeApp }, fa, fs, ac] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore-lite.js`), // REST reads only; no listeners
    CONFIG.appCheckSiteKey ? import(`${SDK}/firebase-app-check.js`) : Promise.resolve(null),
  ]);
  const app = initializeApp(CONFIG.firebase, "closet");
  const appCheck = ac
    ? ac.initializeAppCheck(app, { provider: new ac.ReCaptchaEnterpriseProvider(CONFIG.appCheckSiteKey), isTokenAutoRefreshEnabled: true })
    : null;
  const auth = fa.getAuth(app);
  const db = fs.getFirestore(app);
  const ref = fs.doc(db, "wishlists", CONFIG.wishlistId);

  let notify = () => {};
  let state = { data: null, user: null, mine: new Set(), status: "loading" };
  let lastFetch = 0;
  let loading = null;
  const inflight = new Map();

  const emit = (patch) => { state = { ...state, ...patch }; notify(state); };
  const isOwnerUser = (u) => !!u && (u.email || "").toLowerCase() === CONFIG.ownerEmail.toLowerCase();

  async function setData(data, fromCache = false) {
    if (!fromCache && data) storage.set(CACHE_KEY, { at: Date.now(), data });
    emit({ data, mine: await mineFrom(data), status: data ? "ok" : "empty", setupError: null });
    if (!data) ownerSetup();
  }

  // When the owner is signed in but the list can't be read (it doesn't exist yet,
  // or the rules aren't published), ask the API: "init" creates the list if needed
  // and returns it either way. Runs at most once per page load.
  let setupTried = false;
  function ownerSetup() {
    if (setupTried || !state.user?.isOwner || state.data) return;
    setupTried = true;
    emit({ status: "loading" });
    mutate("init", {}).catch((e) => emit({ status: "setup-error", setupError: e.message }));
  }

  // One document read, with at most MAX_RETRIES retries for transient errors.
  function load({ force = false } = {}) {
    if (loading) return loading;
    const cached = storage.get(CACHE_KEY);
    if (!force && cached && Date.now() - cached.at < CACHE_FRESH_MS) {
      lastFetch = cached.at;
      return setData(cached.data, true);
    }
    if (cached && !state.data) setData(cached.data, true); // show something while loading
    loading = (async () => {
      for (let n = 0; ; n++) {
        try {
          const snap = await fs.getDoc(ref);
          lastFetch = Date.now();
          await setData(snap.exists() ? snap.data() : null);
          return;
        } catch (e) {
          const code = String(e?.code || "");
          if (code.includes("permission-denied")) { lastFetch = Date.now(); emit({ status: "unavailable" }); ownerSetup(); return; }
          const transient = /unavailable|deadline|internal|resource-exhausted/.test(code) || !code;
          if (!transient || n >= MAX_RETRIES) { emit({ status: state.data ? "ok" : "error" }); throw new FriendlyError("Couldn't load the list. Check your connection and try again."); }
          await sleep(backoff(n));
        }
      }
    })().finally(() => { loading = null; });
    return loading;
  }

  async function headers() {
    const h = { "Content-Type": "application/json" };
    if (auth.currentUser) h.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
    if (appCheck) {
      try { h["X-Firebase-AppCheck"] = (await ac.getToken(appCheck, false)).token; } catch { /* server decides */ }
    }
    return h;
  }

  // Calls the API. Same action + payload while one is in flight → same promise.
  function call(action, payload) {
    if (!CONFIG.apiUrl) return Promise.reject(new FriendlyError("Changes aren't switched on yet (the site's API address isn't set)."));
    const dedupeKey = `${action}:${JSON.stringify(payload)}`;
    if (inflight.has(dedupeKey)) return inflight.get(dedupeKey);
    const p = (async () => {
      for (let n = 0; ; n++) {
        let res, body;
        try {
          res = await fetch(CONFIG.apiUrl, { method: "POST", headers: await headers(), body: JSON.stringify({ action, payload }) });
          body = await res.json().catch(() => ({}));
        } catch {
          if (n >= MAX_RETRIES) throw new FriendlyError("Couldn't reach the server. Check your connection and try again.");
          await sleep(backoff(n));
          continue;
        }
        if (res.ok) return body;
        const wait = Number(res.headers.get("Retry-After")) * 1000;
        const retryable = res.status === 429 || res.status >= 502;
        if (retryable && n < MAX_RETRIES && (!wait || wait <= 8000)) { await sleep(wait || backoff(n)); continue; }
        const err = new FriendlyError(body.error || "That didn't work. Try again in a minute.");
        err.status = res.status;
        if (wait) err.retryAfter = wait / 1000;
        throw err;
      }
    })().finally(() => inflight.delete(dedupeKey));
    inflight.set(dedupeKey, p);
    return p;
  }

  async function mutate(action, payload) {
    try {
      const body = await call(action, payload);
      if (body.data !== undefined) await setData(body.data);
      return body;
    } catch (e) {
      // Our copy was out of date (someone else claimed it, or it was removed): re-read once.
      if (e.status === 409 || e.status === 404) await load({ force: true }).catch(() => {});
      throw e;
    }
  }

  return {
    mode: "firebase",
    start(onChange) {
      notify = onChange;
      fa.getRedirectResult(auth).catch(() => {});
      fa.onAuthStateChanged(auth, (u) => {
        emit({ user: u ? { isOwner: isOwnerUser(u), email: u.email } : null });
        if (isOwnerUser(u) && !state.data && state.status !== "loading") ownerSetup();
      });
      load().catch((e) => console.warn(e.message));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastFetch > REFRESH_ON_RETURN_MS) load({ force: true }).catch(() => {});
      });
    },
    refresh() {
      if (Date.now() - lastFetch < MANUAL_REFRESH_MS) return Promise.resolve(false);
      return load({ force: true }).then(() => true);
    },
    async signInOwner() {
      const provider = new fa.GoogleAuthProvider();
      provider.setCustomParameters({ login_hint: CONFIG.ownerEmail, prompt: "select_account" });
      try { await fa.signInWithPopup(auth, provider); }
      catch (e) { if (String(e.code).includes("popup")) await fa.signInWithRedirect(auth, provider); else throw e; }
    },
    signOut: () => fa.signOut(auth),

    claim: (itemId) => mutate("claim", { itemId, key: claimKey() }),
    unclaim: (itemId) => mutate("unclaim", { itemId, key: claimKey() }),
    resetClaim: (itemId) => mutate("resetClaim", { itemId }),
    upsertItem: (item) => mutate("upsertItem", { item }),
    deleteItem: (id) => mutate("deleteItem", { id }),
    receive: (id) => mutate("receive", { id }),
    upsertPrint: (print) => mutate("upsertPrint", { print }),
    deletePrint: (id) => mutate("deletePrint", { id }),
    upsertToy: (toy) => mutate("upsertToy", { toy }),
    deleteToy: (id) => mutate("deleteToy", { id }),
    setFavoriteStyles: (styles) => mutate("setFavoriteStyles", { styles }),
    addType: (category, name) => mutate("addType", { category, name }),
    renameType: (category, from, to) => mutate("renameType", { category, from, to }),
    deleteType: (category, name) => mutate("deleteType", { category, name }),
    importBatch: (prints, toys) => mutate("importBatch", { prints, toys }),
    setColors: (colors) => mutate("setColors", { colors }),
    setPlan: (plan) => mutate("setPlan", { plan }),
    deletePlan: (id) => mutate("deletePlan", { id }),
    findPhotos: (ids) => mutate("findPhotos", { ids }),
    checkStock: (ids) => mutate("checkStock", { ids }),
    upsertBrand: (brand) => mutate("upsertBrand", { brand }),
    deleteBrand: (id) => mutate("deleteBrand", { id }),
    async importLink(url) { return (await call("import", { url })).product; },
  };
}

// ── Demo store: same behavior, in memory ─────────────────────────────
export function createDemoStore() {
  const img = (bg, fg) =>
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><rect width='120' height='120' fill='${bg}'/>` +
        Array.from({ length: 9 }, (_, i) => `<circle cx='${20 + (i % 3) * 40}' cy='${20 + Math.floor(i / 3) * 40}' r='9' fill='${fg}'/>`).join("") +
        `</svg>`
    );
  const now = Date.now();
  const data = {
    v: 1, visibility: "public",
    brands: {
      b1: { id: "b1", name: "Kyte Baby", currentSize: "6–12M", notes: "Zippers only, please" },
      b2: { id: "b2", name: "Little Sleepies", currentSize: "6–12M", notes: "" },
      b3: { id: "b3", name: "Posh Peanut", currentSize: "9–12M", notes: "Runs small, size up" },
    },
    items: {
      i1: { id: "i1", url: "https://example.com/products/strawberry-footie", title: "Zippered Footie", printName: "Strawberry Patch", type: "Footie", brand: "Kyte Baby", size: "12–18M", price: "$38", priority: "most", image: img("#F3D3CF", "#C9787A"), sizeFlexible: true, createdAt: now },
      i2: { id: "i2", url: "https://example.com/products/woodland-set", title: "Bamboo Two-Piece Set", printName: "Woodland Friends", type: "Two-piece PJs", brand: "Little Sleepies", size: "12–18M", price: "$36", priority: "nice", image: img("#E5E6D2", "#8E9A6F"), printFlexible: true, createdAt: now },
      i4: { id: "i4", category: "toy", title: "Silicone Stacking Cups", brand: "Mushie", type: "Stacker", ageRange: "6m+", price: "$16", priority: "most", image: img("#E8EBDA", "#A7B8A0"), url: "", createdAt: now },
      i5: { id: "i5", category: "toy", title: "Board Book Set", brand: "Usborne", type: "Book", ageRange: "0–2y", price: "$24", priority: "nice", image: img("#F6DCD8", "#C48E93"), url: "", createdAt: now },
      i6: { id: "i6", category: "other", title: "Knit Stroller Blanket", brand: "Quincy Mae", type: "Blanket", price: "$58", priority: "nice", image: img("#EBD6D3", "#D4AEAA"), url: "", createdAt: now },
      i3: { id: "i3", title: "Twirl Dress", printName: "Honey Bears", type: "Dress", brand: "Posh Peanut", size: "12M", price: "$42", priority: "nice", image: img("#EBDCCD", "#C9A3A0"), url: "", createdAt: now },
    },
    prints: {
      p1: { id: "p1", brand: "Kyte Baby", printName: "Cloud", types: ["Zippy", "Swaddle"], image: img("#F1ECE6", "#B9A99B") },
      p2: { id: "p2", brand: "Kyte Baby", printName: "Blush", types: ["Footie"], outgrown: true, image: img("#F4D6D3", "#E8B7B3") },
      p3: { id: "p3", brand: "Little Sleepies", printName: "Bunny Meadow", types: ["Zippy"], favorite: true, image: img("#E3E6D3", "#FFFFFF") },
      p4: { id: "p4", brand: "Posh Peanut", printName: "Honey Bears", types: ["Romper", "Bow"], image: img("#EADFD3", "#B9A58C") },
      p5: { id: "p5", brand: "Posh Peanut", printName: "Pink Stripe", types: ["Dress"], image: img("#F8E3E1", "#D99A97") },
    },
    toys: {
      t1: { id: "t1", name: "Wooden Rattle", brand: "Lovevery", type: "Rattle", image: img("#EADFD3", "#A7B8A0") },
      t2: { id: "t2", name: "Sensory Ball Set", brand: "Infantino", type: "Activity", image: img("#E3E6D3", "#8E9A6F") },
      o1: { id: "o1", category: "other", name: "Muslin Swaddle Set", brand: "Aden + Anais", type: "Swaddle", image: img("#E3D5C2", "#FFFFFF") },
      t3: { id: "t3", name: "Bunny Lovey", brand: "Jellycat", type: "Plush", image: img("#F8E3E1", "#FFFFFF") },
    },
    favoriteStyles: ["Zippy", "Two-piece PJs"],
    plans: [{ id: "plan_demo_xmas", name: "Christmas", date: "2026-12-25", note: "She'll be crawling everywhere by then!", rows: [
      { brand: "Little Sleepies", style: "Two-piece PJs", size: "12–18M", skip: false },
      { brand: "Little Sleepies", style: "Dress", size: "18–24M", skip: false },
      { brand: "Little Sleepies", style: "Zippy", size: "", skip: true },
      { brand: "Kyte Baby", style: "", size: "12–18M", skip: false },
    ] }],
    claims: { i2: { h: "someone-else", at: now } },
  };
  const mine = new Set(["i3"]);
  data.typeLists = {};
  const DEMO_DEFAULTS = {
    clothes: ["Zippy", "Shorty", "Footie", "Romper", "Bodysuit", "Two-piece PJs", "Two-piece daywear", "Pajamas", "Dress", "Bubble", "Swim", "Outerwear", "Separates", "Swaddle", "Sleep bag", "Blanket", "Bib", "Hat", "Bow", "Shoes", "Accessory"],
    toy: ["Rattle", "Teether", "Stacker", "Blocks", "Book", "Plush", "Bath", "Music", "Activity", "Push & ride", "Puzzle", "Pretend play", "Outdoor"],
    other: ["Blanket", "Swaddle", "Lovey", "Bedding", "Bath", "Feeding", "Books", "Room decor", "Gear", "Keepsake"],
  };
  const demoList = (cat) => [...(data.typeLists[cat] || DEMO_DEFAULTS[cat])];
  data.claims.i3 = { h: "mine", at: now };
  let user = null;
  let notify = () => {};
  const emit = () => notify({ data: structuredClone(data), user, mine: new Set(mine), status: "ok" });
  const delay = () => new Promise((r) => setTimeout(r, 250));
  const ensureBrand = (name) => {
    if (name && !Object.values(data.brands).some((b) => b.name.toLowerCase() === name.toLowerCase())) {
      const id = `b_${Math.random().toString(36).slice(2, 10)}`;
      data.brands[id] = { id, name, currentSize: "", notes: "" };
    }
  };
  const m = (fn) => async (...a) => { await delay(); fn(...a); emit(); };
  return {
    mode: "demo",
    start(cb) { notify = cb; emit(); },
    refresh: async () => true,
    signInOwner: m(() => { user = { isOwner: true, email: CONFIG.ownerEmail }; }),
    signOut: m(() => { user = null; }),
    claim: m((id) => { if (data.claims[id]?.h) throw new FriendlyError("Someone already claimed this one."); data.claims[id] = { h: "mine", at: Date.now() }; mine.add(id); }),
    unclaim: m((id) => { data.claims[id] = { h: null, at: Date.now() }; mine.delete(id); }),
    resetClaim: m((id) => { data.claims[id] = { h: null, at: Date.now() }; mine.delete(id); }),
    upsertItem: m((it) => { data.items[it.id] = { ...it, createdAt: data.items[it.id]?.createdAt ?? Date.now() }; ensureBrand(it.brand); }),
    deleteItem: m((id) => { delete data.items[id]; delete data.claims[id]; }),
    receive: m((id) => {
      const it = data.items[id]; if (!it) return;
      if (it.category === "toy" || it.category === "other") {
        if (!Object.values(data.toys).some((t) => (t.category || "toy") === it.category && t.name.toLowerCase() === it.title.toLowerCase() && (t.brand || "").toLowerCase() === (it.brand || "").toLowerCase()))
          data.toys[`r_${id}`] = { id: `r_${id}`, category: it.category, name: it.title, brand: it.brand, type: it.type, image: it.image, url: it.url };
        delete data.items[id]; delete data.claims[id]; mine.delete(id); return;
      }
      const pn = it.printName || it.title;
      const match = Object.values(data.prints).find((x) => (x.brand || "").toLowerCase() === (it.brand || "").toLowerCase() && (x.printName || "").toLowerCase() === pn.toLowerCase());
      if (match) { if (it.type && !(match.types || []).includes(it.type)) match.types = [...(match.types || []), it.type]; match.outgrown = false; }
      else data.prints[`r_${id}`] = { id: `r_${id}`, brand: it.brand, printName: pn, types: it.type ? [it.type] : [], image: it.image, url: it.url };
      delete data.items[id]; delete data.claims[id]; mine.delete(id); ensureBrand(it.brand);
    }),
    upsertPrint: m((p) => { data.prints[p.id] = p; ensureBrand(p.brand); }),
    deletePrint: m((id) => { delete data.prints[id]; }),
    upsertToy: m((t) => { data.toys[t.id] = t; }),
    deleteToy: m((id) => { delete data.toys[id]; }),
    setFavoriteStyles: m((styles) => { data.favoriteStyles = styles; }),
    // Demo copies of the server's style-list actions (defaults come from app.js via the first edit).
    addType: m((cat, name) => { data.typeLists[cat] = [...demoList(cat), name]; }),
    renameType: m((cat, from, to) => {
      const eq = (v) => (v || "").toLowerCase() === from.toLowerCase();
      if (demoList(cat).some((t, i) => t.toLowerCase() === to.toLowerCase() && !eq(t))) throw new FriendlyError(`"${to}" is already in the list`);
      data.typeLists[cat] = demoList(cat).map((t) => (eq(t) ? to : t));
      for (const it of Object.values(data.items)) if ((it.category || "clothes") === cat && eq(it.type)) it.type = to;
      if (cat === "clothes") {
        for (const p of Object.values(data.prints)) if (p.types) p.types = p.types.map((t) => (eq(t) ? to : t));
        data.favoriteStyles = (data.favoriteStyles || []).map((t) => (eq(t) ? to : t));
      } else for (const t of Object.values(data.toys)) if ((t.category || "toy") === cat && eq(t.type)) t.type = to;
    }),
    deleteType: m((cat, name) => { data.typeLists[cat] = demoList(cat).filter((t) => t.toLowerCase() !== name.toLowerCase()); }),
    importBatch: m((prints, toys) => {
      const k = (...a) => a.map((x) => (x || "").toLowerCase()).join("|");
      for (const p of prints) {
        const match = Object.values(data.prints).find((x) => k(x.brand, x.printName) === k(p.brand, p.printName));
        if (match) match.types = [...new Set([...(match.types || []), ...(p.types || [])])];
        else { const id = "p_" + Math.random().toString(36).slice(2, 12); data.prints[id] = { id, ...p }; }
        ensureBrand(p.brand);
      }
      for (const t of toys) {
        if (Object.values(data.toys).some((x) => k(x.category || "toy", x.name, x.brand) === k(t.category, t.name, t.brand))) continue;
        const id = "t_" + Math.random().toString(36).slice(2, 12); data.toys[id] = { id, ...t };
      }
    }),
    setColors: m((colors) => { data.colors = colors; }),
    setPlan: m((plan) => { data.plans = [...(data.plans || []).filter((p) => p.id !== plan.id), plan]; }),
    deletePlan: m((id) => { data.plans = (data.plans || []).filter((p) => p.id !== id); }),
    async findPhotos(ids) {
      await delay(); let found = 0;
      for (const id of ids) { const p = data.prints[id]; if (p && !p.image) { p.image = img("#EBD6D3", "#FFFFFF"); found++; } }
      emit(); return { found };
    },
    async checkStock(ids) {
      await delay(); let found = 0;
      for (const id of ids) { const it = data.items[id]; if (it) { it.stock = it.id === "i1" ? "out" : "in"; it.stockAt = Date.now(); if (it.stock === "out") found++; } }
      emit(); return { found };
    },
    upsertBrand: m((b) => { data.brands[b.id] = b; }),
    deleteBrand: m((id) => { delete data.brands[id]; }),
    async importLink(url) {
      await new Promise((r) => setTimeout(r, 500));
      return { url, title: "Ruffle Bubble Romper", printName: "Bunny Meadow", brand: "Little Sleepies", price: "$34", image: img("#F4D6D3", "#FFFFFF"), sizes: ["0–3M", "3–6M", "6–12M", "12–18M", "18–24M"] };
    },
  };
}
