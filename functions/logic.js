// Pure logic for the wishlist API: validation, the state reducer and rate limiting.
// No Firebase imports here, so all of it is unit-tested without a database.

const crypto = require("crypto");

const LIMITS = {
  items: 150, prints: 400, brands: 40, toys: 200, family: 150, styleFavs: 60, // hard caps on stored records
  trashMs: 7 * 86400000,                // bulk-deleted prints can be restored for a week
  docBytes: 800_000,                     // Firestore's own limit is ~1 MiB
  activeClaimsPerKey: 15,                // one browser can't claim the whole list
  claimCooldownMs: 3_000,                // an item's claim can't flip faster than this
};

class ApiError extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; if (retryAfter) this.retryAfter = retryAfter; }
}
const bad = (msg) => { throw new ApiError(400, msg); };

// ── field validators ────────────────────────────────────────────────
const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const KEY_RE = /^[0-9a-f]{64}$/;

function str(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) bad(`${field} is required`);
    return "";
  }
  if (typeof v !== "string") bad(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) bad(`${field} is too long (max ${max})`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t)) bad(`${field} has invalid characters`);
  if (required && !t) bad(`${field} is required`);
  return t;
}
function bool(v, field) {
  if (v === undefined) return false;
  if (typeof v !== "boolean") bad(`${field} must be true or false`);
  return v;
}
function url(v, field) {
  const s = str(v, field, 600);
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { bad(`${field} isn't a valid link`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") bad(`${field} must be a web link`);
  return u.href;
}
function id(v, field = "id") {
  if (typeof v !== "string" || !ID_RE.test(v)) bad(`${field} is invalid`);
  return v;
}
function onlyKeys(obj, allowed, what) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) bad(`${what} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`Unexpected field "${k}" in ${what}`);
}

const BRAND_FIELDS = ["id", "name", "currentSize", "notes", "styleSizes"];
const ITEM_FIELDS = ["id", "category", "title", "brand", "printName", "type", "ageRange", "size", "price", "priority", "sizeFlexible", "printFlexible", "notes", "url", "image"];
const TOY_FIELDS = ["id", "category", "name", "brand", "type", "url", "image"]; // "Toys she has" and "Other things she has"
const FAMILY_FIELDS = ["id", "person", "category", "title", "brand", "sizes", "price", "priority", "notes", "url", "image"];
const STYLE_FAV_FIELDS = ["id", "brand", "name", "url", "image"]; // "Favorite Styles": a specific product she loves
const PRINT_FIELDS = ["id", "brand", "printName", "types", "favorite", "outgrown", "url", "image"];

// Product types ("Zippy", "Dress"…) shown as pills on closet prints. Max 8 per print.
function types(v) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) bad("types must be a list");
  if (v.length > 8) bad("Up to 8 product types per print");
  const out = [];
  for (const t of v) {
    const s = str(t, "Product type", 24, { required: true });
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}
const mergeTypes = (a = [], b = []) => types([...a, ...b.filter((t) => !a.some((x) => x.toLowerCase() === t.toLowerCase()))].slice(0, 8));

const MAX_STYLE_SIZES = 8;
// Which size she wears for an item: a matching "size by style" row, else the brand's main size.
// A row matches when its style text (or any part of "Shorty & daywear") appears in the item's type or name.
function sizeForStyle(brand, type, title) {
  const rows = (brand && brand.styleSizes) || [];
  const t = String(type || "").toLowerCase().trim();
  const hay = `${t} ${String(title || "").toLowerCase()}`;
  const parts = (r) => r.style.toLowerCase().split(/\s*(?:,|&|\/|\+|\band\b)\s*/).map((x) => x.trim()).filter(Boolean);
  const hit = rows.find((r) => r.style.toLowerCase().trim() === t) ||
    rows.find((r) => hay.includes(r.style.toLowerCase().trim())) ||
    rows.find((r) => parts(r).some((w) => hay.includes(w)));
  return hit ? hit.size : (brand && brand.currentSize) || "";
}
function cleanBrand(b) {
  onlyKeys(b, BRAND_FIELDS, "brand");
  // Sizes by style: she can wear different sizes in one brand ("Zippy" 3–6M, "Shorty & daywear" 6–12M).
  if (b.styleSizes !== undefined && (!Array.isArray(b.styleSizes) || b.styleSizes.length > MAX_STYLE_SIZES)) bad(`Up to ${MAX_STYLE_SIZES} sizes by style`);
  const styleSizes = (b.styleSizes || []).map((r) => {
    onlyKeys(r, ["style", "size"], "style size");
    return { style: str(r.style, "Style", 40, { required: true }), size: str(r.size, "Size", 20, { required: true }) };
  });
  return { id: id(b.id), name: str(b.name, "Brand", 60, { required: true }), currentSize: str(b.currentSize, "Size", 20), notes: str(b.notes, "Note", 140), ...(styleSizes.length && { styleSizes }) };
}
function cleanItem(i) {
  onlyKeys(i, ITEM_FIELDS, "item");
  const priority = i.priority ?? "nice";
  if (!["most", "nice"].includes(priority)) bad("Priority must be most or nice");
  const category = i.category ?? "clothes";
  if (!["clothes", "toy", "other"].includes(category)) bad("Category must be clothes, toy or other");
  return {
    id: id(i.id), category, ageRange: str(i.ageRange, "Age range", 20),
    title: str(i.title, "Product name", 120, { required: true }), brand: str(i.brand, "Brand", 60),
    printName: str(i.printName, "Print", 80), type: str(i.type, "Product type", 24), size: str(i.size, "Size", 20), price: str(i.price, "Price", 20), priority,
    sizeFlexible: bool(i.sizeFlexible, "sizeFlexible"), printFlexible: bool(i.printFlexible, "printFlexible"),
    notes: str(i.notes, "Note", 200), url: url(i.url, "Link"), image: url(i.image, "Image"),
  };
}
// "Shopping for the rest of the family?" wishlist (Lys, Michael, Penny…).
function cleanFamily(i) {
  onlyKeys(i, FAMILY_FIELDS, "item");
  const priority = i.priority ?? "nice";
  if (!["most", "nice"].includes(priority)) bad("Priority must be most or nice");
  const category = i.category ?? "other";
  if (!["clothes", "other"].includes(category)) bad("Category must be clothes or other");
  if (i.sizes !== undefined && (!Array.isArray(i.sizes) || i.sizes.length > 8)) bad("Up to 8 sizes");
  const sizes = [];
  for (const z of i.sizes || []) { const t = str(z, "Size", 20, { required: true }); if (!sizes.some((x) => x.toLowerCase() === t.toLowerCase())) sizes.push(t); }
  return {
    id: id(i.id), person: str(i.person, "Person", 30, { required: true }), category,
    title: str(i.title, "Product name", 120, { required: true }), brand: str(i.brand, "Brand", 60),
    sizes: category === "clothes" ? sizes : [], price: str(i.price, "Price", 20), priority,
    notes: str(i.notes, "Note", 200), url: url(i.url, "Link"), image: url(i.image, "Image"),
  };
}
function cleanToy(t) {
  onlyKeys(t, TOY_FIELDS, "toy");
  const category = t.category ?? "toy";
  if (!["toy", "other"].includes(category)) bad("Category must be toy or other");
  return { id: id(t.id), category, name: str(t.name, "Name", 120, { required: true }), brand: str(t.brand, "Brand", 60), type: str(t.type, "Toy type", 24), url: url(t.url, "Link"), image: url(t.image, "Image") };
}
function cleanStyleFav(f) {
  onlyKeys(f, STYLE_FAV_FIELDS, "style");
  return { id: id(f.id), brand: str(f.brand, "Brand", 60), name: str(f.name, "Style name", 80, { required: true }), url: url(f.url, "Link"), image: url(f.image, "Image") };
}
function cleanPrint(p) {
  onlyKeys(p, PRINT_FIELDS, "print");
  const out = { id: id(p.id), brand: str(p.brand, "Brand", 60), printName: str(p.printName, "Print", 80), types: types(p.types), favorite: bool(p.favorite, "favorite"), outgrown: bool(p.outgrown, "outgrown"), url: url(p.url, "Link"), image: url(p.image, "Image") };
  if (!out.brand && !out.printName) bad("Add a brand or print name");
  return out;
}

// Choices offered in the add/edit form. The owner can add, rename and delete these;
// until she does, these defaults apply. (Mirrors app.js.)
const DEFAULT_TYPES = {
  clothes: ["Zippy", "Shorty", "Footie", "Romper", "Bodysuit", "Two-piece PJs", "Two-piece daywear", "Pajamas", "Dress", "Bubble", "Swim", "Outerwear", "Separates", "Swaddle", "Sleep bag", "Blanket", "Bib", "Hat", "Bow", "Shoes", "Accessory"],
  toy: ["Rattle", "Teether", "Stacker", "Blocks", "Book", "Plush", "Bath", "Music", "Activity", "Push & ride", "Puzzle", "Pretend play", "Outdoor"],
  other: ["Blanket", "Swaddle", "Lovey", "Bedding", "Bath", "Feeding", "Books", "Room decor", "Gear", "Keepsake"],
};
const MAX_TYPES_PER_LIST = 40;
const IMPORT_MAX = 40;
const MAX_COLORS = 24;
const MAX_BULK = 200;
const MAX_PLANS = 8, MAX_PLAN_ROWS = 80, MAX_BATCH_IMAGES = 40, MAX_STOCK_RESULTS = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // records per importBatch call (keeps each request well under the 16 KB body cap)
const typeList = (state, cat) => [...(state.typeLists?.[cat] || DEFAULT_TYPES[cat])];
const sameName = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();
function typeCat(v) {
  if (!["clothes", "toy", "other"].includes(v)) bad("Category must be clothes, toy or other");
  return v;
}

const emptyState = () => ({ v: 1, visibility: "public", brands: {}, items: {}, prints: {}, toys: {}, claims: {}, favoriteStyles: [] });

const claimHash = (key, itemId) => crypto.createHash("sha256").update(`${key}:${itemId}`).digest("hex");

// Brand names written different ways ("The Sleepy Sloth" / "Sleepy Sloth", "Little One Shop" /
// "Little One Co") share one key, so they group together and match each other.
const BRAND_TAIL = new Set(["co", "company", "inc", "llc", "shop", "store", "boutique", "clothing", "baby", "kids"]);
const brandKey = (name) => {
  const w = String(name || "").toLowerCase().replace(/&/g, " and ").replace(/[’'.]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  if (w[0] === "the" && w.length > 1) w.shift();
  while (w.length > 1 && BRAND_TAIL.has(w[w.length - 1])) w.pop();
  return w.join(" ");
};

// ── reducer ─────────────────────────────────────────────────────────
// (state | null, action, payload, { isOwner, now }) → { state, changed }
// Every action changes at most one document. Repeating an action is a no-op
// (changed: false → no write), which makes client retries safe.
const GUEST_ACTIONS = new Set(["claim", "unclaim"]);
const OWNER_ACTIONS = new Set(["init", "setVisibility", "upsertBrand", "deleteBrand", "upsertItem", "deleteItem", "receive", "upsertPrint", "deletePrint", "upsertToy", "deleteToy", "setFavoriteStyles", "addType", "renameType", "deleteType", "resetClaim", "importBatch", "setColors", "setImages", "setPlan", "deletePlan", "setStock", "upsertFamilyItem", "deleteFamilyItem", "upsertStyleFav", "deleteStyleFav", "bulkCloset", "undoBulkDelete", "confirmSizes", "hideItem", "showItem"]);

function reduce(prev, action, payload, { isOwner, now, priv = null }) {
  if (!GUEST_ACTIONS.has(action) && !OWNER_ACTIONS.has(action)) bad("Unknown action");
  if (OWNER_ACTIONS.has(action) && !isOwner) throw new ApiError(403, "Only the owner can do that.");
  if (!prev) {
    if (action !== "init") throw new ApiError(404, "This wishlist isn't set up yet.");
    return { state: emptyState(), changed: true };
  }
  const state = structuredClone(prev);
  for (const k of ["brands", "items", "prints", "toys", "claims", "family", "styleFavs"]) state[k] = state[k] || {};
  if (state.trash && now - (state.trash.at || 0) > LIMITS.trashMs) delete state.trash;
  for (const b of Object.values(state.brands)) if (!b.sizeAt) b.sizeAt = now;
  const p = payload || {};
  const same = { state: prev, changed: false };

  switch (action) {
    case "init":
      return same;

    case "setVisibility": {
      onlyKeys(p, ["visibility"], "payload");
      if (!["public", "private"].includes(p.visibility)) bad("Visibility must be public or private");
      if (state.visibility === p.visibility) return same;
      state.visibility = p.visibility;
      break;
    }

    case "claim":
    case "unclaim": {
      onlyKeys(p, ["itemId", "key", "from"], "payload");
      if (action === "claim") str(p.from, "Name", 40);                   // optional; never stored in this public document
      else if (p.from !== undefined) bad('Unexpected field "from"');
      const itemId = id(p.itemId, "itemId");
      if (typeof p.key !== "string" || !KEY_RE.test(p.key)) bad("Invalid claim key");
      if (!state.items[itemId] && !state.family[itemId]) throw new ApiError(404, "That item isn't on the list anymore.");
      const h = claimHash(p.key, itemId);
      const cur = state.claims[itemId];
      if (action === "claim") {
        if (cur?.h === h) return same;                                     // already yours
        if (cur?.h) throw new ApiError(409, "Someone already claimed this one.");
        if (cur && now - cur.at < LIMITS.claimCooldownMs) throw new ApiError(429, "Slow down a moment and try again.", 3);
        const mine = Object.entries(state.claims).filter(([iid, c]) => c?.h && c.h === claimHash(p.key, iid)).length;
        if (mine >= LIMITS.activeClaimsPerKey) throw new ApiError(429, "That's a lot of gifts! Undo one first.", 60);
        state.claims[itemId] = { h, at: now };
      } else {
        if (!cur?.h) return same;                                          // already open
        if (cur.h !== h) throw new ApiError(403, "Only the person who claimed it can undo it.");
        if (now - cur.at < LIMITS.claimCooldownMs) throw new ApiError(429, "Slow down a moment and try again.", 3);
        state.claims[itemId] = { h: null, at: now };
      }
      break;
    }

    case "resetClaim": {
      onlyKeys(p, ["itemId"], "payload");
      const itemId = id(p.itemId, "itemId");
      if (!state.claims[itemId]?.h) return same;
      state.claims[itemId] = { h: null, at: now };
      break;
    }

    case "bulkCloset": {
      // Owner's multi-select in the closet: one change applied to many records, one write.
      onlyKeys(p, ["kind", "ids", "op"], "payload");
      if (!["prints", "toys"].includes(p.kind)) bad("kind must be prints or toys");
      const ops = p.kind === "prints" ? ["delete", "favorite", "unfavorite", "outgrown", "fits"] : ["delete"];
      if (!ops.includes(p.op)) bad("Unknown bulk change");
      if (!Array.isArray(p.ids) || !p.ids.length || p.ids.length > MAX_BULK) bad(`Select 1 to ${MAX_BULK} at a time`);
      const before = JSON.stringify(state[p.kind]);
      const removed = {};
      for (const raw of p.ids) {
        const rid = id(raw);
        const rec = state[p.kind][rid];
        if (!rec) continue;
        if (p.op === "delete") { removed[rid] = rec; delete state[p.kind][rid]; }
        else if (p.op === "favorite") rec.favorite = true;
        else if (p.op === "unfavorite") rec.favorite = false;
        else if (p.op === "outgrown") rec.outgrown = true;
        else if (p.op === "fits") rec.outgrown = false;
      }
      if (JSON.stringify(state[p.kind]) === before) return same;
      if (p.op === "delete") {
        // Replaces any earlier batch, except one from the same select-and-delete (sent in chunks of 200).
        const t = state.trash;
        const merge = t && t.kind === p.kind && now - t.at < 60000 ? t.records : {};
        state.trash = { kind: p.kind, at: now, records: { ...merge, ...removed } };
      }
      break;
    }
    case "undoBulkDelete": {
      onlyKeys(p, [], "payload");
      const t = state.trash;
      if (!t || !t.records) return same;
      const max = LIMITS[t.kind];
      for (const [rid, rec] of Object.entries(t.records)) {
        if (state[t.kind][rid]) continue;
        if (Object.keys(state[t.kind]).length >= max) break;
        state[t.kind][rid] = rec;
      }
      delete state.trash;
      break;
    }

    case "upsertFamilyItem": {
      onlyKeys(p, ["item"], "payload");
      const it = cleanFamily(p.item);
      const existing = state.family[it.id];
      if (!existing && Object.keys(state.family).length >= LIMITS.family) bad(`The family list can hold up to ${LIMITS.family} items`);
      const next = { ...it, createdAt: existing?.createdAt ?? now };
      if (existing && JSON.stringify(existing) === JSON.stringify(next)) return same;
      state.family[it.id] = next;
      break;
    }
    case "deleteFamilyItem": {
      onlyKeys(p, ["id"], "payload");
      if (!state.family[id(p.id)]) return same;
      delete state.family[p.id];
      delete state.claims[p.id];
      break;
    }

    case "upsertStyleFav": {
      onlyKeys(p, ["style"], "payload");
      const f = cleanStyleFav(p.style);
      const existing = state.styleFavs[f.id];
      if (!existing && Object.keys(state.styleFavs).length >= LIMITS.styleFavs) bad(`Up to ${LIMITS.styleFavs} favorite styles`);
      const next = { ...f, createdAt: existing?.createdAt ?? now };
      if (existing && JSON.stringify(existing) === JSON.stringify(next)) return same;
      state.styleFavs[f.id] = next;
      break;
    }
    case "deleteStyleFav": {
      onlyKeys(p, ["id"], "payload");
      if (!state.styleFavs[id(p.id)]) return same;
      delete state.styleFavs[p.id];
      break;
    }

    case "upsertBrand": {
      onlyKeys(p, ["brand"], "payload");
      const b = cleanBrand(p.brand);
      const cur = state.brands[b.id];
      if (!cur && Object.keys(state.brands).length >= LIMITS.brands) bad(`You can have up to ${LIMITS.brands} brands`);
      // sizeAt = when her size in this brand last changed (drives the "still right?" reminder).
      const sameSizes = cur && cur.currentSize === b.currentSize && JSON.stringify(cur.styleSizes || []) === JSON.stringify(b.styleSizes || []);
      const next = { ...b, sizeAt: sameSizes ? cur.sizeAt ?? now : now };
      if (JSON.stringify(cur) === JSON.stringify(next)) return same;
      state.brands[b.id] = next;
      break;
    }
    case "confirmSizes": {
      // "All still right": restart every brand's reminder clock.
      onlyKeys(p, [], "payload");
      for (const b of Object.values(state.brands)) b.sizeAt = now;
      break;
    }
    case "deleteBrand": {
      onlyKeys(p, ["id"], "payload");
      if (!state.brands[id(p.id)]) return same;
      delete state.brands[p.id];
      break;
    }

    case "upsertItem": {
      onlyKeys(p, ["item"], "payload");
      const it = cleanItem(p.item);
      const existing = state.items[it.id];
      if (!existing && Object.keys(state.items).length >= LIMITS.items) bad(`You can have up to ${LIMITS.items} wishlist items`);
      const next = { ...it, createdAt: existing?.createdAt ?? now };
      if (existing && JSON.stringify(existing) === JSON.stringify(next)) return same;
      state.items[it.id] = next;
      break;
    }
    // Hidden ("still researching") wishlist items live in the owner-only private doc,
    // so guests can't see them even by reading the raw public list.
    case "hideItem": {
      onlyKeys(p, ["id"], "payload");
      const hid = id(p.id);
      if (!state.items[hid]) return same;
      if (state.claims[hid]?.h) bad("Someone already claimed this. Reset the claim first, then hide it.");
      delete state.items[hid];
      delete state.claims[hid];
      break;
    }
    case "showItem": {
      onlyKeys(p, ["id"], "payload");
      const sid = id(p.id);
      const d = priv?.drafts?.[sid];
      if (!d || state.items[sid]) return same;
      if (Object.keys(state.items).length >= LIMITS.items) bad(`You can have up to ${LIMITS.items} wishlist items`);
      const { createdAt, ...rest } = d;
      state.items[sid] = { ...cleanItem(rest), createdAt: createdAt ?? now };
      break;
    }
    case "deleteItem": {
      onlyKeys(p, ["id"], "payload");
      if (!state.items[id(p.id)]) return same;
      delete state.items[p.id];
      delete state.claims[p.id];
      break;
    }

    case "receive": {
      // Gift arrived: it joins the closet and leaves the wishlist, in one write.
      // If she already has that print from that brand, the new style is added
      // to the existing print's pills instead of creating a duplicate tile.
      onlyKeys(p, ["id"], "payload");
      const itemId = id(p.id);
      const it = state.items[itemId];
      if (!it) return same;                               // already moved (safe retry) or removed
      if (it.category === "toy" || it.category === "other") {
        // Toys and other things go to "what she has". Same name + brand + category already there → nothing new to add.
        const dup = Object.values(state.toys).some((t) => (t.category || "toy") === it.category &&
          t.name.toLowerCase() === it.title.toLowerCase() && (t.brand || "").toLowerCase() === (it.brand || "").toLowerCase());
        if (!dup) {
          if (Object.keys(state.toys).length >= LIMITS.toys) bad(`"Toys she has" can hold up to ${LIMITS.toys} toys`);
          const tid = "r_" + itemId.slice(0, 38);
          state.toys[tid] = { id: tid, category: it.category, name: it.title, brand: it.brand, type: it.type, url: it.url, image: it.image, createdAt: now };
        }
        delete state.items[itemId];
        delete state.claims[itemId];
        break;
      }
      const printName = it.printName || it.title;
      const match = Object.values(state.prints).find((x) =>
        (x.brand || "").toLowerCase() === (it.brand || "").toLowerCase() && (x.printName || "").toLowerCase() === printName.toLowerCase());
      if (match) {
        match.types = mergeTypes(match.types, it.type ? [it.type] : []);
        if (!match.image && it.image) match.image = it.image;
        if (match.outgrown) match.outgrown = false; // a new one arrived, so this print fits again
      } else {
        if (Object.keys(state.prints).length >= LIMITS.prints) bad(`The closet can hold up to ${LIMITS.prints} prints`);
        const pid = "r_" + itemId.slice(0, 38);
        state.prints[pid] = { id: pid, brand: it.brand, printName, types: it.type ? [it.type] : [], url: it.url, image: it.image, createdAt: now };
      }
      delete state.items[itemId];
      delete state.claims[itemId];
      break;
    }

    case "upsertPrint": {
      onlyKeys(p, ["print"], "payload");
      const pr = cleanPrint(p.print);
      const existing = state.prints[pr.id];
      if (!existing && Object.keys(state.prints).length >= LIMITS.prints) bad(`The closet can hold up to ${LIMITS.prints} prints`);
      const next = { ...pr, createdAt: existing?.createdAt ?? now };
      if (existing && JSON.stringify(existing) === JSON.stringify(next)) return same;
      state.prints[pr.id] = next;
      break;
    }
    case "setColors": {
      // "Her colors" swatches on the Sizes page: the whole list, in order, replaced at once.
      onlyKeys(p, ["colors"], "payload");
      if (!Array.isArray(p.colors)) bad("colors must be a list");
      if (p.colors.length > MAX_COLORS) bad(`Up to ${MAX_COLORS} colors`);
      const list = [];
      for (const c of p.colors) {
        onlyKeys(c, ["name", "hex"], "color");
        const name = str(c.name, "Color name", 30, { required: true });
        if (typeof c.hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c.hex)) bad(`Pick a color for "${name}"`);
        if (list.some((x) => sameName(x.name, name))) bad(`"${name}" is in the list twice`);
        list.push({ name, hex: c.hex.toUpperCase() });
      }
      if (JSON.stringify(state.colors || null) === JSON.stringify(list)) return same;
      state.colors = list;
      break;
    }

    case "setImages": {
      // Photos found for closet prints (owner's "Find photos"). Only fills prints that exist.
      onlyKeys(p, ["images"], "payload");
      if (!Array.isArray(p.images) || p.images.length > MAX_BATCH_IMAGES) bad(`Send up to ${MAX_BATCH_IMAGES} photos at a time`);
      const before = JSON.stringify(state.prints);
      for (const im of p.images) {
        onlyKeys(im, ["id", "image"], "photo");
        const pr = state.prints[id(im.id)];
        const link = url(im.image, "Photo");
        if (pr && link) pr.image = link;
      }
      if (JSON.stringify(state.prints) === before) return same;
      break;
    }

    case "setPlan": {
      // "Shopping ahead" plans: an occasion with a date, and per-brand style + size pills.
      onlyKeys(p, ["plan"], "payload");
      const raw = p.plan;
      onlyKeys(raw, ["id", "name", "date", "note", "rows"], "plan");
      const plan = { id: id(raw.id), name: str(raw.name, "Occasion", 30, { required: true }), date: "", note: str(raw.note, "Note", 160), rows: [] };
      if (raw.date) { if (typeof raw.date !== "string" || !DATE_RE.test(raw.date) || isNaN(Date.parse(raw.date))) bad("Pick a valid date"); plan.date = raw.date; }
      if (!Array.isArray(raw.rows ?? [])) bad("rows must be a list");
      if ((raw.rows || []).length > MAX_PLAN_ROWS) bad(`Up to ${MAX_PLAN_ROWS} lines per occasion`);
      for (const r of raw.rows || []) {
        onlyKeys(r, ["brand", "style", "size", "skip"], "line");
        const row = { brand: str(r.brand, "Brand", 60), style: str(r.style, "Style", 24), size: str(r.size, "Size", 20), skip: bool(r.skip, "skip") };
        if (!row.style && !row.size) bad("Each line needs a style or a size");
        if (row.skip && !row.style) bad("Pick the style she won't need");
        plan.rows.push(row);
      }
      const plans = Array.isArray(state.plans) ? state.plans : [];
      const i = plans.findIndex((x) => x.id === plan.id);
      if (i < 0 && plans.length >= MAX_PLANS) bad(`Up to ${MAX_PLANS} occasions`);
      if (i >= 0 && JSON.stringify(plans[i]) === JSON.stringify(plan)) return same;
      state.plans = i >= 0 ? plans.map((x, j) => (j === i ? plan : x)) : [...plans, plan];
      break;
    }
    case "deletePlan": {
      onlyKeys(p, ["id"], "payload");
      const plans = Array.isArray(state.plans) ? state.plans : [];
      if (!plans.some((x) => x.id === id(p.id))) return same;
      state.plans = plans.filter((x) => x.id !== p.id);
      break;
    }

    case "setStock": {
      // Results of the server's own availability check (see index.js "checkStock").
      onlyKeys(p, ["results", "at"], "payload");
      if (!Array.isArray(p.results) || p.results.length > MAX_STOCK_RESULTS) bad("Too many results");
      const at = typeof p.at === "number" && isFinite(p.at) ? p.at : now;
      const before = JSON.stringify(state.items);
      for (const r of p.results) {
        onlyKeys(r, ["id", "stock"], "result");
        if (!["in", "out", "unknown"].includes(r.stock)) bad("Bad stock value");
        const it = state.items[id(r.id)];
        if (it) { it.stock = r.stock; it.stockAt = at; }
      }
      if (JSON.stringify(state.items) === before) return same;
      break;
    }

    case "setFavoriteStyles": {
      // Styles she loves (e.g. "Zippy"); gifters see which prints she already has in each.
      onlyKeys(p, ["styles"], "payload");
      const list = types(p.styles);
      const prevList = Array.isArray(state.favoriteStyles) ? state.favoriteStyles : [];
      if (JSON.stringify(prevList) === JSON.stringify(list)) return same;
      state.favoriteStyles = list;
      break;
    }

    case "addType": {
      onlyKeys(p, ["category", "name"], "payload");
      const cat = typeCat(p.category);
      const name = str(p.name, "Style name", 24, { required: true });
      const list = typeList(state, cat);
      if (list.some((t) => sameName(t, name))) return same;
      if (list.length >= MAX_TYPES_PER_LIST) bad(`Up to ${MAX_TYPES_PER_LIST} choices per list`);
      state.typeLists = { ...(state.typeLists || {}), [cat]: [...list, name] };
      break;
    }
    case "renameType": {
      // Renames the choice AND every record already tagged with it, in one write.
      onlyKeys(p, ["category", "from", "to"], "payload");
      const cat = typeCat(p.category);
      const from = str(p.from, "Current name", 24, { required: true });
      const to = str(p.to, "New name", 24, { required: true });
      const list = typeList(state, cat);
      const i = list.findIndex((t) => sameName(t, from));
      if (i < 0) throw new ApiError(404, "That choice isn't in the list anymore.");
      if (list[i] === to) return same;
      if (list.some((t, j) => j !== i && sameName(t, to))) bad(`"${to}" is already in the list`);
      list[i] = to;
      state.typeLists = { ...(state.typeLists || {}), [cat]: list };
      for (const it of Object.values(state.items)) if ((it.category || "clothes") === cat && sameName(it.type, from)) it.type = to;
      if (cat === "clothes") {
        for (const pr of Object.values(state.prints)) if (pr.types) pr.types = mergeTypes([], pr.types.map((t) => (sameName(t, from) ? to : t)));
        if (Array.isArray(state.favoriteStyles)) state.favoriteStyles = types(state.favoriteStyles.map((t) => (sameName(t, from) ? to : t)));
      } else {
        for (const t of Object.values(state.toys)) if ((t.category || "toy") === cat && sameName(t.type, from)) t.type = to;
      }
      break;
    }
    case "deleteType": {
      // Removes it from the choices only; records already tagged keep their label.
      onlyKeys(p, ["category", "name"], "payload");
      const cat = typeCat(p.category);
      const name = str(p.name, "Style name", 24, { required: true });
      const list = typeList(state, cat);
      if (!list.some((t) => sameName(t, name))) return same;
      state.typeLists = { ...(state.typeLists || {}), [cat]: list.filter((t) => !sameName(t, name)) };
      break;
    }

    case "importBatch": {
      // Bulk add from a reviewed list (e.g. past order emails). Owner only, one document write,
      // at most IMPORT_MAX records per call, every record validated like a single add.
      // Re-running the same batch changes nothing: prints merge by brand + print name,
      // toys are skipped when the same name/brand/category already exists.
      onlyKeys(p, ["prints", "toys"], "payload");
      const ps = p.prints ?? [], ts = p.toys ?? [];
      if (!Array.isArray(ps) || !Array.isArray(ts)) bad("prints and toys must be lists");
      if (ps.length + ts.length > IMPORT_MAX) bad(`Import up to ${IMPORT_MAX} at a time`);
      const before = JSON.stringify(state);
      const key = (...a) => a.map((x) => (x || "").toLowerCase()).join("\u0001");
      const hid = (pre, k) => pre + crypto.createHash("sha1").update(k).digest("hex").slice(0, 16);
      const addToList = (cat, names) => {
        for (const n of names) {
          const list = typeList(state, cat);
          if (!n || list.some((t) => sameName(t, n)) || list.length >= MAX_TYPES_PER_LIST) continue;
          state.typeLists = { ...(state.typeLists || {}), [cat]: [...list, n] };
        }
      };
      for (const raw of ps) {
        onlyKeys(raw, ["brand", "printName", "types", "url", "outgrown"], "print");
        const brand = str(raw.brand, "Brand", 60, { required: true });
        const printName = str(raw.printName, "Print", 80, { required: true });
        const t = types(raw.types), link = url(raw.url, "Link"), outgrown = bool(raw.outgrown, "outgrown");
        const k = key(brandKey(brand), printName);
        const match = Object.values(state.prints).find((x) => key(brandKey(x.brand), x.printName) === k);
        if (match) {
          match.types = mergeTypes(match.types || [], t);
          if (!match.url && link) match.url = link;
        } else {
          if (Object.keys(state.prints).length >= LIMITS.prints) bad(`The closet can hold up to ${LIMITS.prints} prints`);
          const pid = hid("p_", k);
          state.prints[pid] = { id: pid, brand, printName, types: t, favorite: false, outgrown, url: link, image: "", createdAt: now };
        }
        addToList("clothes", t); // (imports don't add brands to Favorite Brands; you choose those)
      }
      for (const raw of ts) {
        onlyKeys(raw, ["category", "name", "brand", "type", "url"], "toy");
        const category = raw.category ?? "toy";
        if (!["toy", "other"].includes(category)) bad("Category must be toy or other");
        const name = str(raw.name, "Name", 120, { required: true });
        const brand = str(raw.brand, "Brand", 60), type = str(raw.type, "Toy type", 24), link = url(raw.url, "Link");
        const k = key(category, name, brand);
        if (Object.values(state.toys).some((x) => key(x.category || "toy", x.name, x.brand) === k)) continue;
        if (Object.keys(state.toys).length >= LIMITS.toys) bad(`"Toys she has" can hold up to ${LIMITS.toys} toys`);
        const tid = hid("t_", k);
        state.toys[tid] = { id: tid, category, name, brand, type, url: link, image: "", createdAt: now };
        addToList(category, type ? [type] : []);
      }
      if (JSON.stringify(state) === before) return same;
      break;
    }

    case "upsertToy": {
      onlyKeys(p, ["toy"], "payload");
      const t = cleanToy(p.toy);
      const existing = state.toys[t.id];
      if (!existing && Object.keys(state.toys).length >= LIMITS.toys) bad(`"Toys she has" can hold up to ${LIMITS.toys} toys`);
      const next = { ...t, createdAt: existing?.createdAt ?? now };
      if (existing && JSON.stringify(existing) === JSON.stringify(next)) return same;
      state.toys[t.id] = next;
      break;
    }
    case "deleteToy": {
      onlyKeys(p, ["id"], "payload");
      if (!state.toys[id(p.id)]) return same;
      delete state.toys[p.id];
      break;
    }

    case "deletePrint": {
      onlyKeys(p, ["id"], "payload");
      if (!state.prints[id(p.id)]) return same;
      delete state.prints[p.id];
      break;
    }
  }

  if (Buffer.byteLength(JSON.stringify(state)) > LIMITS.docBytes) bad("The wishlist is full — remove some items first.");
  return { state, changed: true };
}

// What readers get back from the API. Matches what the Firestore document holds.
const publicView = (s) => s && { v: s.v, visibility: s.visibility, brands: s.brands, items: s.items, prints: s.prints, toys: s.toys || {}, claims: s.claims, favoriteStyles: s.favoriteStyles || [], typeLists: s.typeLists || {}, ...(s.colors && { colors: s.colors }), plans: s.plans || [], family: s.family || {}, styleFavs: s.styleFavs || {}, ...(s.trash && { trash: { kind: s.trash.kind, at: s.trash.at, count: Object.keys(s.trash.records || {}).length } }) };

// ── rate limiting (in memory) ───────────────────────────────────────
// Token buckets. The function runs with max instances = 1, so one process
// sees all traffic and these limits are real (they reset on a cold start).
class Limiter {
  constructor() { this.buckets = new Map(); }
  take(key, perMinute, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: perMinute, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / perMinute) * 60); // seconds to wait
    b.tokens -= 1;
    if (this.buckets.size > 5000) this.buckets.clear(); // memory guard against IP floods
    return 0;
  }
}


// ── owner-only private document ─────────────────────────────────────
// wishlists/{id}/private/owner — clients can never read it (rules deny all
// subcollections); only this API does, and only returns it to the owner.
//   givers: { [itemId]: { from, at } }      name a gifter typed when claiming
//   thanks: { [id]: { id, title, from, at, done } }  thank-you checklist
const PRIVATE_ACTIONS = new Set(["getPrivate", "setThank", "deleteThank", "addThank", "upsertDraft", "deleteDraft"]);
const MAX_DRAFTS = 50;
const MAX_THANKS = 200;
const emptyPrivate = () => ({ givers: {}, thanks: {}, drafts: {} });
function reducePrivate(prevPriv, action, payload, { prevPublic, nextPublic, publicChanged, isOwner, now, newId }) {
  const priv = structuredClone(prevPriv || emptyPrivate());
  priv.givers = priv.givers || {}; priv.thanks = priv.thanks || {}; priv.drafts = priv.drafts || {};
  const p = payload || {};
  const before = JSON.stringify(priv);
  const addThank = (title, from, itemId = "") => {
    const ids = Object.values(priv.thanks).sort((a, b) => a.at - b.at);
    while (ids.length >= MAX_THANKS) { const old = ids.find((t) => t.done) || ids[0]; delete priv.thanks[old.id]; ids.splice(ids.indexOf(old), 1); }
    const tid = newId();
    priv.thanks[tid] = { id: tid, itemId, title: String(title || "").slice(0, 120), from: String(from || "").slice(0, 40), at: now, done: false };
  };
  if (PRIVATE_ACTIONS.has(action)) {
    if (!isOwner) throw new ApiError(403, "Only the owner can do that.");
    if (action === "setThank") {
      onlyKeys(p, ["id", "done"], "payload");
      const t = priv.thanks[id(p.id)];
      if (!t) throw new ApiError(404, "That thank-you isn't on the list anymore.");
      t.done = bool(p.done, "done");
    } else if (action === "deleteThank") {
      onlyKeys(p, ["id"], "payload");
      delete priv.thanks[id(p.id)];
    } else if (action === "upsertDraft") {
      onlyKeys(p, ["item"], "payload");
      const it = cleanItem(p.item);
      const cur = priv.drafts[it.id];
      if (!cur && Object.keys(priv.drafts).length >= MAX_DRAFTS) bad(`Up to ${MAX_DRAFTS} hidden items`);
      priv.drafts[it.id] = { ...it, createdAt: cur?.createdAt ?? now };
    } else if (action === "deleteDraft") {
      onlyKeys(p, ["id"], "payload");
      delete priv.drafts[id(p.id)];
    } else if (action === "addThank") {
      onlyKeys(p, ["title", "from"], "payload");
      addThank(str(p.title, "Gift", 120, { required: true }), str(p.from, "From", 40, { required: true }));
    }
  } else if (publicChanged) {
    const iid = p.itemId || p.id;
    if (action === "claim") {
      const from = str(p.from, "Name", 40);
      if (from) priv.givers[iid] = { from, at: now }; else delete priv.givers[iid];
    } else if (action === "unclaim" || action === "resetClaim" || action === "deleteItem") {
      delete priv.givers[iid];
    } else if (action === "hideItem") {
      const rec = prevPublic?.items?.[iid];
      if (rec) {
        if (!priv.drafts[iid] && Object.keys(priv.drafts).length >= MAX_DRAFTS) bad(`Up to ${MAX_DRAFTS} hidden items`);
        priv.drafts[iid] = rec;
      }
      delete priv.givers[iid];
    } else if (action === "showItem") {
      delete priv.drafts[iid];
    } else if (action === "receive" || action === "deleteFamilyItem") {
      // Gift arrived (or a family wish marked "Got it"): the name moves to the thank-you list.
      const g = priv.givers[iid];
      const rec = prevPublic?.items?.[iid] || prevPublic?.family?.[iid];
      if (g) addThank(rec?.title || "A gift", g.from, iid);
      delete priv.givers[iid];
    }
  }
  return { priv, changed: JSON.stringify(priv) !== before };
}

const RATES = {
  perIp: 30,          // any request, per client IP
  guestWrites: 30,    // claim/unclaim across ALL visitors combined
  ownerWrites: 120,
  imports: 20,
  lookups: 8,         // Find photos / Check stock calls (each reads up to 10 store pages)
};

module.exports = { sizeForStyle, reducePrivate, PRIVATE_ACTIONS, emptyPrivate, brandKey, MAX_STOCK_RESULTS, DEFAULT_TYPES, reduce, publicView, Limiter, RATES, LIMITS, ApiError, claimHash, GUEST_ACTIONS, OWNER_ACTIONS };
