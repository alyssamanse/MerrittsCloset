import { CONFIG } from "./config.js?v=1004-0919";
import { createFirebaseStore, createDemoStore } from "./store.js?v=1004-0919";
const BUILD = "1004-0919"; // stamped on each publish, matches the ?v= on the script URLs

const SIZES = ["Preemie", "Newborn", "0–3M", "3–6M", "6–9M", "6–12M", "9–12M", "12M", "12–18M", "18M", "18–24M", "2T", "3T", "4T", "5T"];
const MAIN_TABS = ["wishlist", "ideas", "closet", "sizes"];
const TABS = [...MAIN_TABS, "family"]; // "family" is reached from the footer link, not the tab bar
const TAB_LABEL = { wishlist: "Wishlist", ideas: "Gift Ideas", closet: "Closet", sizes: "Sizes" };
const OTHER_TYPES = ["Blanket", "Swaddle", "Lovey", "Bedding", "Bath", "Feeding", "Books", "Room decor", "Gear", "Keepsake"];
const TOY_TYPES = ["Rattle", "Teether", "Stacker", "Blocks", "Book", "Plush", "Bath", "Music", "Activity", "Push & ride", "Puzzle", "Pretend play", "Outdoor"];
const TYPES = ["Zippy", "Shorty", "Footie", "Romper", "Bodysuit", "Two-piece PJs", "Two-piece daywear", "Pajamas", "Dress", "Bubble", "Swim", "Outerwear", "Separates", "Swaddle", "Sleep bag", "Blanket", "Bib", "Hat", "Bow", "Shoes", "Accessory"];
// Default choices; once the owner edits a list it's stored with the wishlist (typeLists).
const DEFAULT_TYPES = { clothes: TYPES, toy: TOY_TYPES, other: OTHER_TYPES };
const LIST_LABEL = { clothes: "Clothing Styles", toy: "Kinds of Toy", other: "Kinds of Other Things" };
const isDemo = new URLSearchParams(location.search).has("demo") || window.CLOSET_DEMO === true;
const $app = document.getElementById("app");
// Owner sign-in lives only at the hidden address …/?admin (or …/#admin). Guests never see a
// sign-in button. This hides the button, nothing more: the API and Firestore rules are what
// actually stop anyone else from editing.
const adminEntry = new URLSearchParams(location.search).has("admin") || location.hash === "#admin";

let store;
let S = { data: null, user: null, mine: new Set(), status: "loading" };
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "wishlist";
if (location.hash === "#admin") history.replaceState(null, "", location.pathname + location.search);
const busy = new Set();            // keys of actions in flight; their buttons are disabled
const armed = new Map();           // two-tap confirmations: key → timeout

// ── helpers ──────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^(https?:|data:image\/)/i.test(u || "") ? u : "");
const owner = () => !!S.user?.isOwner;
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const list = (m) => Object.values(m || {});
const brands = () => list(S.data?.brands).sort((a, b) => a.name.localeCompare(b.name));
// Brand names written different ways ("The Sleepy Sloth" / "Sleepy Sloth", "Little One Shop" /
// "Little One Co") share one key, so they group together and match each other.
const BRAND_TAIL = new Set(["co", "company", "inc", "llc", "shop", "store", "boutique", "clothing", "baby", "kids"]);
const brandKey = (name) => {
  const w = String(name || "").toLowerCase().replace(/&/g, " and ").replace(/[’'.]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  if (w[0] === "the" && w.length > 1) w.shift();
  while (w.length > 1 && BRAND_TAIL.has(w[w.length - 1])) w.pop();
  return w.join(" ");
};
const brandByName = (name) => { const k = brandKey(name); return k ? list(S.data?.brands).find((b) => brandKey(b.name) === k) : undefined; };
const catOf = (i) => (i.category === "toy" || i.category === "other" ? i.category : "clothes"); // wishlist items
const hasCat = (t) => (t.category === "other" ? "other" : "toy");                             // "what she has" non-clothes
const isToy = (i) => catOf(i) !== "clothes"; // toys and other things share the no-size layout
const CAT_FILTER = { clothes: "clothes", toy: "toys", other: "other" };
const filter = { wishlist: "all", closet: "clothes", fit: "all", plan: "", person: "all" };
let familyQuery = ""; // view-only, no requests
let closetQuery = ""; // closet search; filters what's already loaded, never makes a request
const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’']/g, "");
const matches = (q, ...fields) => {
  const hay = fold(fields.flat().join(" "));
  return fold(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};
const isClaimed = (id) => !!S.data?.claims?.[id]?.h;
const PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='#F6DCD8'/><g fill='#fff'><circle cx='10' cy='10' r='2'/><circle cx='30' cy='10' r='2'/><circle cx='20' cy='20' r='2'/><circle cx='10' cy='30' r='2'/><circle cx='30' cy='30' r='2'/></g></svg>`);
const img = (src, cls = "", alt = "") =>
  `<img class="${cls}" src="${esc(safeUrl(src) || PLACEHOLDER)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${PLACEHOLDER}'">`;

const CREST = `<svg viewBox="0 0 96 104" width="88" height="96">
  <circle cx="48" cy="56" r="40" fill="none" stroke="currentColor" stroke-width="1"/>
  <circle cx="48" cy="56" r="35.5" fill="none" stroke="currentColor" stroke-width=".5" opacity=".55"/>
  <g transform="translate(37 4)">
    <circle cx="4" cy="5" r="3.6" fill="#C9AE97"/><circle cx="18" cy="5" r="3.6" fill="#C9AE97"/>
    <circle cx="4" cy="5" r="1.7" fill="#F3E6D8"/><circle cx="18" cy="5" r="1.7" fill="#F3E6D8"/>
    <ellipse cx="11" cy="11" rx="8.6" ry="8" fill="#C9AE97"/>
    <ellipse cx="11" cy="14" rx="4.2" ry="3.2" fill="#F3E6D8"/>
    <circle cx="7.6" cy="9.6" r="1" fill="#3A2E30"/><circle cx="14.4" cy="9.6" r="1" fill="#3A2E30"/>
    <ellipse cx="11" cy="12.8" rx="1.5" ry="1.1" fill="#3A2E30"/>
  </g>
  <text x="48" y="73" text-anchor="middle" font-family="'Cormorant Garamond', Georgia, serif" font-style="italic" font-weight="500" font-size="50" fill="currentColor">M</text>
</svg>`;
const BEAR = `<svg width="46" height="40" viewBox="0 0 46 40" aria-hidden="true">
  <circle cx="9" cy="9" r="7.5" fill="#CBAE93"/><circle cx="37" cy="9" r="7.5" fill="#CBAE93"/>
  <circle cx="9" cy="9" r="3.8" fill="#F1E4D3"/><circle cx="37" cy="9" r="3.8" fill="#F1E4D3"/>
  <ellipse cx="23" cy="22" rx="17" ry="16" fill="#CBAE93"/>
  <ellipse cx="23" cy="28" rx="8.5" ry="6.5" fill="#F1E4D3"/>
  <circle cx="16" cy="19" r="2" fill="#4A3F3F"/><circle cx="30" cy="19" r="2" fill="#4A3F3F"/>
  <ellipse cx="23" cy="25.5" rx="3" ry="2.2" fill="#4A3F3F"/>
  <path d="M20.5 30.2q2.5 2 5 0" stroke="#4A3F3F" stroke-width="1.4" fill="none" stroke-linecap="round"/>
  <circle cx="13" cy="25" r="2.2" fill="#D89A9F" opacity=".7"/><circle cx="33" cy="25" r="2.2" fill="#D89A9F" opacity=".7"/>
</svg>`;

function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// Runs a change once: the button is locked until it finishes, so double taps do nothing.
async function act(key, fn, okMsg) {
  if (busy.has(key)) return false;
  busy.add(key); render();
  try {
    await fn();
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    console.warn(e);
    toast(e?.message || "That didn't work. Try again in a minute.");
    return false;
  } finally {
    busy.delete(key); render();
  }
}
const dis = (key) => (busy.has(key) ? "disabled" : "");

// First tap arms the button for 3 s; second tap confirms. Works without pop-ups.
function confirmTap(key) {
  if (armed.has(key)) { clearTimeout(armed.get(key)); armed.delete(key); return true; }
  armed.set(key, setTimeout(() => { armed.delete(key); render(); }, 3000));
  render();
  return false;
}
const armedLabel = (key, normal, confirm) => (armed.has(key) ? confirm : normal);

// ── render ───────────────────────────────────────────────────────────
function render() {
  if (document.querySelector(".sheet-bg")) return; // don't wipe a form being filled in
  const searchId = ["closet-search", "family-search"].find((x) => document.activeElement?.id === x);
  const searching = !!searchId;
  const caret = searching ? document.activeElement.selectionStart : null;
  queueMicrotask(() => {
    const box = searching && document.getElementById(searchId);
    if (box) { box.focus(); try { box.setSelectionRange(caret, caret); } catch {} }
  });
  const name = esc(CONFIG.babyName);
  $app.innerHTML = `
    ${isDemo ? `<div class="demo-bar">Preview with sample data. Nothing here is saved.</div>` : ""}
    <header class="hero">
      <div class="crest" aria-hidden="true">${CREST}</div>
      <h1 class="logo" aria-label="${name}'s Closet"><span class="logo-name">${name}'s</span><span class="logo-sub">Closet</span></h1>
      <p>Her wishes, her favorites, and what she already has</p>
    </header>
    <nav class="tabs" role="tablist">
      ${MAIN_TABS.map((t) => `<button class="tab" role="tab" aria-selected="${tab === t}" data-tab="${t}">${TAB_LABEL[t]}</button>`).join("")}
    </nav>
    <main>${adminPanel()}${body()}</main>
    ${owner() && S.status === "ok" ? `<button class="btn fab" data-act="add">+ Add</button>` : ""}
    <footer>
      ${tab !== "family" && (CONFIG.family || []).length ? `<div class="family-link"><button class="link" data-act="go-tab" data-to="family">Shopping for the rest of the family?</button></div>` : ""}
      <button class="link quiet" data-act="share">Share</button><span class="muted"> · </span>
      <button class="link quiet" data-act="refresh" ${dis("refresh")}>Refresh</button>
      ${S.user ? `<span class="muted"> · ${owner() ? "Editing on" : "Signed in"} · </span><button class="link" data-act="signout">Sign out</button>` : ""}
      ${owner() || adminEntry ? `<div class="build muted">Version ${esc(BUILD)} · <button class="link" data-act="force-update" ${dis("update")}>${busy.has("update") ? "Updating…" : "Get Latest Version"}</button></div>` : ""}
    </footer>`;
}

function adminPanel() {
  if (!adminEntry || owner()) return "";
  if (S.user) {
    return `<div class="admin-card"><b>That Google account can't edit this list.</b>
      <p class="muted">Sign out, then sign in with the account that manages ${esc(CONFIG.babyName)}'s list.</p>
      <button class="btn ghost" data-act="signout" ${dis("signout")}>Sign out</button></div>`;
  }
  return `<div class="admin-card"><b>Owner Sign-In</b>
    <p class="muted">Sign in with the Google account that manages this list to add items, mark gifts received and edit sizes. You'll stay signed in on this device.</p>
    <button class="btn" data-act="signin" ${dis("signin")}>${busy.has("signin") ? "Opening Google…" : "Sign in with Google"}</button></div>`;
}

function body() {
  if (S.status === "loading" && !S.data) return `<div class="empty">Loading…</div>`;
  if (S.status === "error" && !S.data)
    return `<div class="empty">Couldn't load the list. Check your connection.<br><button class="btn small ghost" style="margin-top:12px" data-act="refresh">Try again</button></div>`;
  if (S.status === "setup-error") return owner()
    ? `<div class="empty">Couldn't set up your list: ${esc(S.setupError || "unknown error")}<br><span class="muted">Send this message to Claude for help.</span></div>`
    : `<div class="empty">This list isn't available right now.</div>`;
  if (S.status === "unavailable") return `<div class="empty">This list isn't available right now.</div>`;
  if (S.status === "empty") return `<div class="empty">${owner() ? "Setting up your list…" : "This list isn't available right now."}</div>`;
  return tab === "family" ? familyView() : tab === "wishlist" ? wishlistView() : tab === "ideas" ? ideasView() : tab === "closet" ? closetView() : sizesView();
}

const filterChips = (which, options) => `
  <div class="filters" role="group" aria-label="Show">
    ${options.map(([v, label, n]) => `<button class="filter" data-filter="${which}:${v}" aria-pressed="${filter[which] === v}">${label}${n != null ? ` <span>${n}</span>` : ""}</button>`).join("")}
  </div>`;

function wishlistView() {
  const all = list(S.data.items);
  const count = (c) => all.filter((i) => catOf(i) === c).length;
  const shown = all
    .filter((i) => filter.wishlist === "all" || CAT_FILTER[catOf(i)] === filter.wishlist)
    .sort((a, b) => isClaimed(a.id) - isClaimed(b.id) || (a.stock === "out") - (b.stock === "out") || (a.priority === "most" ? 0 : 1) - (b.priority === "most" ? 0 : 1) || (a.createdAt || 0) - (b.createdAt || 0));
  const open = shown.filter((i) => !isClaimed(i.id)).length;
  const soldOut = all.filter((i) => i.stock === "out" && !isClaimed(i.id)).length;
  return `
    ${owner() ? stockBanner(all, soldOut) : `<div class="note">Tap <b>I'll get this</b> so nobody doubles up. It's anonymous, and you can undo it from this same phone or computer.</div>`}
    <div class="section-title"><h2>Wishlist</h2><span class="muted">${open} still open</span></div>
    ${filterChips("wishlist", [["all", "All", all.length], ["clothes", "Clothes", count("clothes")], ["toys", "Toys", count("toy")], ["other", "Other", count("other")]])}
    ${shown.length ? shown.map(itemCard).join("") : `<div class="empty">Nothing here right now.</div>`}`;
}

function stockBanner(all, soldOut) {
  const linked = all.filter((i) => i.url && !isClaimed(i.id));
  if (!linked.length) return "";
  const last = Math.min(...linked.map((i) => i.stockAt || 0));
  const when = last ? `Checked ${ago(last)}` : "Not checked yet";
  return `<div class="stock-bar${soldOut ? " alert" : ""}">
    <span>${soldOut ? `<b>${soldOut} ${soldOut === 1 ? "item looks" : "items look"} sold out.</b> Swap the link or remove ${soldOut === 1 ? "it" : "them"}.` : "Wishlist links are in stock."} <span class="muted">${when}</span></span>
    <button class="link" data-act="check-stock" ${dis("stock")}>${busy.has("stock") ? stockProgress || "Checking…" : "Check Now"}</button>
  </div>`;
}
const ago = (t) => {
  const d = Math.round((Date.now() - t) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

function itemCard(i) {
  const claimed = isClaimed(i.id);
  const mine = S.mine.has(i.id);
  const toy = isToy(i);
  const brand = brandByName(i.brand);
  const sub = [i.brand, !toy && i.printName && i.printName !== i.title ? i.printName : ""].filter(Boolean).map(esc).join(" · ");
  const chips = toy
    ? [
        i.type && `<span class="chip ink">${esc(i.type)}</span>`,
        i.ageRange && `<span class="chip">Ages ${esc(i.ageRange)}</span>`,
        i.price && `<span class="chip tan">${esc(i.price)}</span>`,
      ]
    : [
        i.type && `<span class="chip ink">${esc(i.type)}</span>`,
        i.size && `<span class="chip">Size ${esc(i.size)}</span>`,
        !i.size && brand?.currentSize && `<span class="chip">${esc(brand.currentSize)} or bigger</span>`,
        i.sizeFlexible && `<span class="chip moss">Bigger size OK</span>`,
        i.printFlexible && `<span class="chip moss">Any print OK</span>`,
        i.price && `<span class="chip tan">${esc(i.price)}</span>`,
      ];
  if (i.stock === "out") chips.unshift(`<span class="chip warn">Sold out online</span>`);
  const k = (a) => `${a}:${i.id}`;

  let actions;
  if (owner()) {
    actions = `
      ${claimed
        ? `<span class="status taken">Claimed</span><button class="link" data-act="reset" data-id="${i.id}" ${dis(k("reset"))}>${armedLabel(k("reset"), "Reset", "Tap again to reset")}</button>`
        : `<span class="status taken">Open</span>`}
      <span class="spacer"></span>
      <button class="link" data-act="edit-item" data-id="${i.id}">Edit</button>
      <button class="btn small soft" data-act="receive" data-id="${i.id}" ${dis(k("receive"))}>${busy.has(k("receive")) ? "Moving…" : ({ toy: "Received → Toys", other: "Received → Has", clothes: "Received → Closet" })[catOf(i)]}</button>`;
  } else if (mine) {
    actions = `<span class="status">✓ You're getting this</span><span class="spacer"></span><button class="btn small ghost" data-act="unclaim" data-id="${i.id}" ${dis(k("claim"))}>${busy.has(k("claim")) ? "Undoing…" : "Undo"}</button>`;
  } else if (claimed) {
    actions = `<span class="status taken">Someone's got this one</span>`;
  } else {
    actions = `<span class="spacer"></span><button class="btn small" data-act="claim" data-id="${i.id}" ${dis(k("claim"))}>${busy.has(k("claim")) ? "Saving…" : "I'll get this"}</button>`;
  }
  const link = safeUrl(i.url) && !i.url.startsWith("data:") ? i.url : "";

  return `
    <article class="card ${claimed ? "claimed" : ""}">
      ${i.priority === "most" && !claimed ? `<span class="ribbon">Most Wanted</span>` : ""}
      ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${img(i.image, "thumb", i.title)}</a>` : img(i.image, "thumb", i.title)}
      <div class="card-body">
        <h3>${esc(i.title || "Untitled")}</h3>
        ${sub ? `<div class="meta">${sub}</div>` : ""}
        <div class="chips">${chips.filter(Boolean).join("")}</div>
        ${i.notes ? `<div class="meta" style="margin-top:6px">${esc(i.notes)}</div>` : ""}
        ${link ? `<a class="link" style="padding-left:0" href="${esc(link)}" target="_blank" rel="noopener noreferrer">View item ↗</a>` : ""}
      </div>
      <div class="actions">${actions}</div>
    </article>`;
}

function closetView() {
  return `
    <div class="section-title"><h2>What She Has</h2>${owner() ? `<span class="title-links">${photoButton()}<button class="link" data-act="import-list">Import List</button></span>` : ""}</div>
    <div class="search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
      <input type="search" id="closet-search" class="in" value="${esc(closetQuery)}" placeholder="Search her closet, like “mermaids”" aria-label="Search her closet by print, brand or style" autocomplete="off" enterkeyhint="search" />
    </div>
    <div id="closet-results">${closetResults()}</div>`;
}

function closetResults() {
  const prints = list(S.data.prints);
  const things = list(S.data.toys);
  const toys = things.filter((t) => hasCat(t) === "toy");
  const others = things.filter((t) => hasCat(t) === "other");
  const q = closetQuery.trim();
  if (!q) {
    return `
    ${filterChips("closet", [["clothes", "Clothes", prints.length], ["toys", "Toys", toys.length], ["other", "Other", others.length]])}
    ${filter.closet === "toys" ? thingsView(toys, "toy") : filter.closet === "other" ? thingsView(others, "other") : clothesView(prints)}`;
  }
  // Searching looks across clothes, toys and other things at once.
  const mp = prints.filter((p) => matches(q, p.printName, p.brand, p.types || []));
  const mt = toys.filter((t) => matches(q, t.name, t.brand, t.type));
  const mo = others.filter((t) => matches(q, t.name, t.brand, t.type));
  const n = mp.length + mt.length + mo.length;
  if (!n) return `<div class="empty">Nothing in her closet matches “${esc(q)}”.<br><span class="muted">If it's a print, she doesn't have it yet.</span></div>`;
  const thingGrid = (arr) => `<div class="grid toys">${arr.sort((a, b) => a.name.localeCompare(b.name)).map((t) => tile(t, "edit-toy", t.name, [t.type].filter(Boolean), t.brand)).join("")}</div>`;
  return `
    <p class="muted result-count">${n} ${n === 1 ? "match" : "matches"} for “${esc(q)}”</p>
    ${mp.length ? printGroups(mp, { forceOpen: true }) : ""}
    ${mt.length ? `<div class="brand-head"><h2>Toys</h2></div>${thingGrid(mt)}` : ""}
    ${mo.length ? `<div class="brand-head"><h2>Other Things</h2></div>${thingGrid(mo)}` : ""}`;
}

// Brands open/closed in the closet. Collapsed by default so a long closet is easy to scan;
// searching or filtering opens everything that matches.
const openBrands = new Set();
function printGroups(prints, { forceOpen = false } = {}) {
  // Group by brand key so spelling variants share one section. The section is named after
  // her Favorite Brands entry if there is one, else the most common spelling.
  const groups = new Map(), spellings = new Map();
  for (const p of prints) {
    const k = brandKey(p.brand) || "other";
    if (!groups.has(k)) { groups.set(k, []); spellings.set(k, new Map()); }
    groups.get(k).push(p);
    const sp = (p.brand || "Other").trim(); spellings.get(k).set(sp, (spellings.get(k).get(sp) || 0) + 1);
  }
  const nameOf = (k) => brandByName(k)?.name || [...spellings.get(k)].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
  const isFav = (k) => !!brandByName(k);
  // Her favorite brands (Sizes tab) first, most prints first; then everything else A–Z.
  const keys = [...groups.keys()].sort((a, b) => isFav(b) - isFav(a)
    || (isFav(a) ? groups.get(b).length - groups.get(a).length : 0)
    || a.localeCompare(b)); // (keys skip a leading "The", so The Sleepy Sloth sorts under S)
  const names = keys.map(nameOf);
  const allOpen = forceOpen || names.length === 1;
  return `${allOpen ? "" : `<div class="fold-all"><button class="link" data-act="fold-all" data-open="1">Expand All</button><button class="link" data-act="fold-all" data-open="0">Collapse All</button></div>`}
  ${keys.map((gk, gi) => {
    const n = names[gi];
    const b = brandByName(gk);
    const ps = groups.get(gk).sort((a, b) => !!a.outgrown - !!b.outgrown || (a.printName || "").localeCompare(b.printName || ""));
    return `
      <details class="brand-fold" data-brand="${esc(n)}" ${allOpen || openBrands.has(n) ? "open" : ""}>
        <summary class="brand-head"><h2>${b ? `<span class="fav-mark" aria-label="Favorite brand">★</span> ` : ""}${esc(n)}</h2><span class="brand-meta">${ps.length} ${ps.length === 1 ? "Print" : "Prints"}${b?.currentSize ? ` · Wears ${esc(b.currentSize)}` : ""}</span><span class="chev" aria-hidden="true"></span></summary>
        <div class="grid">
          ${ps.map((p) => tile(p, "edit-print", (p.favorite ? "★ " : "") + (p.printName || "Untitled print"), p.types || [])).join("")}
        </div>
      </details>`;
  }).join("")}`;
}

function clothesView(prints) {
  const og = prints.filter((p) => p.outgrown);
  const shown = filter.fit === "fits" ? prints.filter((p) => !p.outgrown) : filter.fit === "outgrown" ? og : prints;
  return `
    <div class="note">Prints ${esc(CONFIG.babyName)} already has, and the styles she has them in. A print she has as a zippy can still be a lovely dress!${og.length ? ` Faded prints are ones she's <b>outgrown</b>. She'd love those again in a bigger size.` : ""}</div>
    ${favoritesView(prints)}
    ${og.length ? filterChips("fit", [["all", "All", prints.length], ["fits", "Fits Now", prints.length - og.length], ["outgrown", "Outgrown", og.length]]) : ""}
    ${shown.length ? printGroups(shown, { forceOpen: filter.fit !== "all" }) : `<div class="empty">${prints.length ? "Nothing here." : "No clothes listed yet."}</div>`}`;
}

function favoritesView(prints) {
  const favPrints = prints.filter((p) => p.favorite).sort((a, b) => !!b.outgrown - !!a.outgrown || (a.printName || "").localeCompare(b.printName || ""));
  const favStyles = S.data.favoriteStyles || [];
  if (!favPrints.length && !favStyles.length) {
    return owner()
      ? `<div class="favs empty-favs"><b>Her Favorites</b><span class="muted">Tap a print and turn on ★ Favorite print, or </span><button class="link" data-act="edit-favstyles">pick favorite styles</button></div>`
      : "";
  }
  const hasStyle = (style) => prints.filter((p) => !p.outgrown && (p.types || []).some((t) => t.toLowerCase() === style.toLowerCase()));
  return `
    <section class="favs" aria-label="Her favorites">
      <div class="favs-head"><h2>★ Her Favorites</h2>${owner() ? `<button class="link" data-act="edit-favstyles">Edit Styles</button>` : ""}</div>
      <p class="muted">Great gift ideas: a new style in a print she loves, or a style she loves in a print she doesn't have yet.</p>
      ${favPrints.map((p) => `
        <div class="fav-row">
          ${img(p.image, "fav-thumb", p.printName)}
          <div>
            <strong>${esc(p.printName || "Untitled print")}</strong>${p.brand ? `<span class="muted"> · ${esc(p.brand)}</span>` : ""}
            <div class="fav-line">${p.outgrown
              ? `<i class="pill og">Outgrown</i> Loved it and outgrew it. Any style in a bigger size is welcome!`
              : (p.types || []).length ? `Has it as ${esc(p.types.join(", "))}. Any other style is welcome!` : "Any style in this print is welcome!"}</div>
          </div>
        </div>`).join("")}
      ${favStyles.map((style) => {
        const have = hasStyle(style);
        return `
        <div class="fav-row">
          <span class="fav-style">${esc(style)}</span>
          <div class="fav-line">${have.length
            ? `Loves these! Already has them in ${esc(have.map((p) => p.printName || "an untitled print").join(", "))}. Any other print is welcome.`
            : "Loves these, in any print!"}</div>
        </div>`;
      }).join("")}
    </section>`;
}

function favStylesSheet() {
  const current = S.data.favoriteStyles || [];
  openSheet(
    `<h2>Favorite Styles</h2>
     <div class="label-row"><p class="muted" style="margin:0">Styles she loves. Gifters will see which prints she already has in each one.</p>${manageLink("clothes")}</div>
     <div class="type-picker" data-cat="clothes" role="group" aria-label="Favorite styles">${typePills("clothes", current)}</div>
     <div class="err sheet-err" hidden></div>
     <div class="sheet-actions"><span class="spacer"></span><button class="btn ghost" data-act="cancel">Cancel</button><button class="btn" data-act="save">Save</button></div>`,
    (el) => {
      wireTypeControls(el, "Up to 8 favorite styles");
      el.querySelector('[data-act="cancel"]').addEventListener("click", () => closeSheet());
      wireSave(el, async () => {
        await store.setFavoriteStyles([...el.querySelectorAll('.type-opt[aria-pressed="true"]')].map((b) => b.dataset.type));
        return "Favorites saved";
      });
    }
  );
}

function thingsView(things, cat) {
  const sorted = things.sort((a, b) => (a.type || "~").localeCompare(b.type || "~") || a.name.localeCompare(b.name));
  const note = cat === "toy"
    ? `Toys ${esc(CONFIG.babyName)} already has, so nobody gives her a second one.`
    : `Blankets, books and other things ${esc(CONFIG.babyName)} already has.`;
  return `
    <div class="note">${note}</div>
    ${sorted.length
      ? `<div class="grid toys">${sorted.map((t) => tile(t, "edit-toy", t.name, [t.type].filter(Boolean), t.brand)).join("")}</div>`
      : `<div class="empty">Nothing listed here yet.</div>`}`;
}

function tile(rec, editAct, title, pills, sub = "") {
  const og = !!rec.outgrown;
  const allPills = [...(og ? [`<i class="pill og">Outgrown</i>`] : []), ...pills.map((t) => `<i class="pill">${esc(t)}</i>`)];
  const inner = `${img(rec.image, "", title)}<span>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}${allPills.length ? `<b class="pills">${allPills.join("")}</b>` : ""}</span>`;
  const cls = `print${og ? " outgrown" : ""}`;
  const label = og ? ` aria-label="${esc(title)}, outgrown"` : "";
  return owner()
    ? `<button class="${cls} editable" data-act="${editAct}" data-id="${rec.id}"${label}>${inner}</button>`
    : `<div class="${cls}"${label}>${inner}</div>`;
}

function sizesView() {
  const bs = brands();
  return `
    <div class="note">Her current size in each brand. When shopping, get <b>this size or bigger</b>. She grows fast!</div>
    ${plansSection()}
    <div class="section-title"><h2>Favorite Brands</h2>${owner() ? `<button class="link" data-act="add-brand">+ Brand</button>` : ""}</div>
    ${bs.length
      ? bs.map((b) => `
      <div class="size-row">
        <div class="name"><strong>${esc(b.name)}</strong>${b.notes ? `<span class="muted">${esc(b.notes)}</span>` : ""}</div>
        <div class="size-badge">${esc(b.currentSize || "—")}<small>${b.currentSize ? "or bigger" : "size not set"}</small></div>
        ${owner() ? `<button class="link" data-act="edit-brand" data-id="${b.id}">Edit</button>` : ""}
      </div>`).join("")
      : `<div class="empty">No brands yet.</div>`}
    <div class="section-title"><h2>Her Colors</h2>${owner() ? `<button class="link" data-act="edit-colors">Edit</button>` : ""}</div>
    ${herColors().length
      ? `<div class="swatches">${herColors().map((c) => `<div class="swatch"><i style="background:${esc(c.hex)}"></i>${esc(c.name)}</div>`).join("")}</div>`
      : `<div class="empty">${owner() ? "No colors yet. Tap Edit to add some." : "No colors listed yet."}</div>`}`;
}

// Saved colors win; until the first save, the starter palette from config.js shows.
const herColors = () => (Array.isArray(S.data?.colors) ? S.data.colors : CONFIG.palette);
const MAX_COLORS = 24;

function colorsSheet() {
  let rows = herColors().map((c) => ({ name: c.name, hex: c.hex }));
  const rowHtml = (c, i) => `
    <div class="color-row" data-i="${i}">
      <input type="color" class="color-pick" value="${esc(c.hex)}" aria-label="Color for ${esc(c.name || "new color")}" />
      <input class="in" maxlength="30" value="${esc(c.name)}" placeholder="Color name" aria-label="Color name" />
      <button class="icon-btn" data-m="up" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="icon-btn" data-m="down" aria-label="Move down" ${i === rows.length - 1 ? "disabled" : ""}>↓</button>
      <button class="icon-btn danger" data-m="remove" aria-label="Remove ${esc(c.name)}">×</button>
    </div>`;
  openSheet(
    `<h2>Her Colors</h2>
     <p class="muted">Shown on the Sizes page so gifters know what she wears. Tap a circle to pick the shade.</p>
     <div class="color-list"></div>
     <button class="btn ghost small" data-m="add">+ Add color</button>
     <div class="err sheet-err" hidden></div>
     <div class="sheet-actions"><span class="spacer"></span>
       <button class="btn ghost" data-act="cancel">Cancel</button>
       <button class="btn" data-act="save">Save</button></div>`,
    (el) => {
      const listEl = el.querySelector(".color-list"), addBtn = el.querySelector('[data-m="add"]');
      const draw = () => {
        listEl.innerHTML = rows.length ? rows.map(rowHtml).join("") : `<p class="muted">No colors. Tap Add color.</p>`;
        addBtn.disabled = rows.length >= MAX_COLORS;
      };
      draw();
      listEl.addEventListener("input", (ev) => {
        const i = Number(ev.target.closest(".color-row")?.dataset.i);
        if (Number.isNaN(i)) return;
        if (ev.target.type === "color") rows[i].hex = ev.target.value;
        else rows[i].name = ev.target.value;
      });
      listEl.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        const i = Number(b.closest(".color-row").dataset.i);
        if (b.dataset.m === "remove") rows.splice(i, 1);
        if (b.dataset.m === "up" && i > 0) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
        if (b.dataset.m === "down" && i < rows.length - 1) [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
        draw();
      });
      addBtn.addEventListener("click", () => {
        rows.push({ name: "", hex: "#D4AEAA" }); draw();
        listEl.querySelector(".color-row:last-child .in")?.focus();
      });
      el.querySelector('[data-act="cancel"]').addEventListener("click", () => closeSheet());
      wireSave(el, async () => {
        const clean = rows.map((c) => ({ name: c.name.trim(), hex: c.hex.toUpperCase() })).filter((c) => c.name || c.hex !== "#D4AEAA");
        if (clean.some((c) => !c.name)) throw new Error("Give every color a name, or remove it.");
        const seen = new Set();
        for (const c of clean) { const k = c.name.toLowerCase(); if (seen.has(k)) throw new Error(`"${c.name}" is in the list twice.`); seen.add(k); }
        await store.setColors(clean);
        return "Colors saved";
      });
    }
  );
}

// ── sold-out checks (owner) ──────────────────────────────────────────
// The server reads each wishlist link (10 per call, 8 calls a minute at most) and saves
// "in" / "out" on the item. Runs by itself when the owner visits and the last check is
// over 3 days old, or from "Check now".
const STOCK_EVERY = 3 * 86400000, LOOKUP_CHUNK = 10;
let stockProgress = "", autoStockDone = false;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function inChunks(ids, fn, label) {
  let found = 0;
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    label(`${Math.min(i + LOOKUP_CHUNK, ids.length)} of ${ids.length}…`);
    const part = ids.slice(i, i + LOOKUP_CHUNK);
    for (let tries = 0; ; tries++) {
      try { found += (await fn(part)).found || 0; break; }
      catch (e) { if (e.status === 429 && tries < 3) { await sleepMs(10000); continue; } throw e; }
    }
  }
  return found;
}
function maybeAutoStock() {
  if (autoStockDone || !owner() || S.status !== "ok" || !S.data || isDemo) return;
  autoStockDone = true;
  const due = list(S.data.items).some((i) => i.url && (!i.stockAt || Date.now() - i.stockAt > STOCK_EVERY));
  if (due) runStockCheck({ quiet: true });
}
async function runStockCheck({ quiet }) {
  if (busy.has("stock")) return;
  const ids = list(S.data.items).filter((i) => i.url && !isClaimed(i.id)).map((i) => i.id);
  if (!ids.length) { if (!quiet) toast("No wishlist links to check"); return; }
  busy.add("stock"); render();
  try {
    const out = await inChunks(ids, (part) => store.checkStock(part), (p) => { stockProgress = `Checking ${p}`; render(); });
    if (!quiet || out) toast(out ? `${out} wishlist ${out === 1 ? "item looks" : "items look"} sold out` : "Everything's still in stock");
  } catch (e) { if (!quiet) toast(e?.message || "Couldn't check right now."); }
  finally { busy.delete("stock"); stockProgress = ""; render(); }
}

// ── find photos for closet prints (owner) ────────────────────────────
let photoProgress = "";
const photoTargets = () => list(S.data?.prints).filter((p) => p.url && !p.image);
function photoButton() {
  const n = photoTargets().length;
  if (!n && !busy.has("photos")) return "";
  return `<button class="link" data-act="find-photos" ${dis("photos")}>${busy.has("photos") ? photoProgress || "Finding…" : `Find Photos (${n})`}</button>`;
}
async function runFindPhotos() {
  if (busy.has("photos")) return;
  const ids = photoTargets().map((p) => p.id);
  if (!ids.length) return;
  busy.add("photos"); render();
  try {
    const found = await inChunks(ids, (part) => store.findPhotos(part), (p) => { photoProgress = `Finding ${p}`; render(); });
    const noLink = list(S.data.prints).filter((p) => !p.url && !p.image).length;
    toast(`Found ${found} ${found === 1 ? "photo" : "photos"}.${noLink ? ` ${noLink} prints have no link: tap one to paste its product link.` : ""}`);
  } catch (e) { toast(e?.message || "Couldn't find photos right now."); }
  finally { busy.delete("photos"); photoProgress = ""; render(); }
}

// ── shopping ahead (occasion sizing) ─────────────────────────────────
const PRESETS = { christmas: "Christmas", birthday: "Birthday", summer: "Next summer", fall: "Next fall" };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function nextDate(month, day) {
  const now = new Date(), d = new Date(now.getFullYear(), month - 1, day);
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setFullYear(d.getFullYear() + 1);
  return iso(d);
}
function presetPlan(key) {
  const date = key === "christmas" ? nextDate(12, 25) : key === "summer" ? nextDate(6, 1) : key === "fall" ? nextDate(9, 1) : "";
  return { id: newId(), name: PRESETS[key], date, note: "", rows: [], isNew: true };
}
const planDate = (p) => (p.date ? new Date(p.date + "T12:00:00") : null);
function whenText(p) {
  const d = planDate(p);
  if (!d) return "";
  const days = Math.round((d - new Date()) / 86400000);
  const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) });
  const rel = days < 0 ? "passed" : days === 0 ? "today" : days < 14 ? `in ${days} days` : days < 70 ? `in ${Math.round(days / 7)} weeks` : `in ${Math.round(days / 30)} months`;
  return `${label} · ${rel}`;
}
// Upcoming first (by date), then undated, then past.
function sortedPlans() {
  const t = Date.now() - 86400000;
  const rank = (p) => { const d = planDate(p); return !d ? 1 : d.getTime() >= t ? 0 : 2; };
  return [...(S.data?.plans || [])].sort((a, b) => rank(a) - rank(b) || (planDate(a)?.getTime() || 0) - (planDate(b)?.getTime() || 0));
}
function planPills(plan) {
  // Older occasions may list the same style per brand; show each style + size once.
  const seen = new Set();
  const rows = (plan.rows || []).filter((r) => { const k = `${r.skip}|${(r.style || "").toLowerCase()}|${r.size}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!rows.length) return `<p class="muted">${owner() ? "No sizes yet. Tap Edit to add some." : "Sizes coming soon."}</p>`;
  const want = rows.filter((r) => !r.skip), skip = rows.filter((r) => r.skip);
  return `<div class="plan-pills">${want.map((r) => `<span class="ppill">${r.style ? `<b>${esc(r.style)}</b>` : "Anything"}${r.size ? ` · ${esc(r.size)}` : ""}</span>`).join("")}${skip.map((r) => `<span class="ppill skip">No more ${esc(r.style)}</span>`).join("")}</div>`;
}
function planCard(plan, { compact = false } = {}) {
  return `<div class="plan-card">
    <div class="plan-head"><div><h3>${esc(plan.name)}</h3>${plan.date ? `<span class="muted">${esc(whenText(plan))}</span>` : ""}</div>
      ${owner() && !compact ? `<button class="link" data-act="edit-plan" data-id="${plan.id}">Edit</button>` : ""}</div>
    ${plan.note ? `<p class="plan-note">${esc(plan.note)}</p>` : ""}
    ${planPills(plan)}
  </div>`;
}
function plansSection() {
  const plans = sortedPlans();
  if (!plans.length) {
    return owner()
      ? `<section class="plans"><div class="section-title"><h2>Shopping Ahead</h2></div>
         <p class="muted">Gifts for later need bigger sizes. Add an occasion and list the size to buy for each style.</p>
         <div class="filters">${Object.entries(PRESETS).map(([k, v]) => `<button class="filter" data-act="add-plan" data-preset="${k}">+ ${v}</button>`).join("")}</div></section>`
      : "";
  }
  const sel = plans.find((p) => p.id === filter.plan) || plans[0];
  return `<section class="plans">
    <div class="section-title"><h2>Shopping Ahead</h2>${owner() ? `<button class="link" data-act="add-plan">+ Occasion</button>` : ""}</div>
    ${plans.length > 1 ? `<div class="filters" role="group" aria-label="Occasion">${plans.map((p) => `<button class="filter" data-act="pick-plan" data-id="${p.id}" aria-pressed="${p.id === sel.id}">${esc(p.name)}</button>`).join("")}</div>` : ""}
    ${planCard(sel)}
  </section>`;
}
function planSheet(existing) {
  const plan = existing ? structuredClone(existing) : presetPlan("christmas");
  if (!existing) { plan.name = ""; plan.date = ""; }
  const isNew = !existing || existing.isNew;
  let rows = (plan.rows || []).map((r) => ({ ...r }));
  const styles = typesFor("clothes");
  const rowHtml = (r, i) => `
    <div class="plan-row${r.skip ? " is-skip" : ""}" data-i="${i}">
      <select class="in" data-f="style" aria-label="Style"><option value="">Any style</option>${[...new Set([...(r.style ? [r.style] : []), ...styles])].map((s) => `<option ${s === r.style ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
      ${sizeSelect(`data-f="size" aria-label="Size" ${r.skip ? "disabled" : ""}`, r.size, { blank: "Size" })}
      <label class="skip-toggle"><input type="checkbox" data-f="skip" ${r.skip ? "checked" : ""}> Won't need</label>
      <button class="icon-btn danger" data-m="remove" aria-label="Remove line">×</button>
    </div>`;
  openSheet(
    `<h2>${isNew ? "Add Occasion" : "Edit Occasion"}</h2>
     <label class="f" for="pl-name">Occasion</label>
     <input class="in" id="pl-name" maxlength="30" list="dl-plan-names" value="${esc(plan.name)}" placeholder="Christmas" />
     <datalist id="dl-plan-names">${Object.values(PRESETS).map((v) => `<option value="${v}">`).join("")}</datalist>
     <label class="f" for="pl-date">Date (optional)</label>
     <input class="in" id="pl-date" type="date" value="${esc(plan.date)}" />
     <label class="f" for="pl-note">Note for gifters (optional)</label>
     <input class="in" id="pl-note" maxlength="160" value="${esc(plan.note)}" placeholder="She'll be walking by then, soft shoes welcome!" />
     <div class="label-row"><label class="f">Size for each style</label></div>
     <p class="muted small">Tick <b>Won't need</b> for styles she'll have outgrown, like zippys.</p>
     <div class="plan-rows"></div>
     <button class="btn ghost small" data-m="add">+ Add line</button>
     <div class="err sheet-err" hidden></div>
     <div class="sheet-actions">
       ${isNew ? "" : `<button class="link danger" data-m="delete-plan">Delete</button>`}
       <span class="spacer"></span>
       <button class="btn ghost" data-act="cancel">Cancel</button>
       <button class="btn" data-act="save">Save</button></div>`,
    (el) => {
      const wrap = el.querySelector(".plan-rows");
      const draw = () => { wrap.innerHTML = rows.map(rowHtml).join("") || `<p class="muted">No lines yet.</p>`; };
      draw();
      wrap.addEventListener("input", (ev) => {
        const rowEl = ev.target.closest(".plan-row"); if (!rowEl) return;
        const r = rows[Number(rowEl.dataset.i)], f = ev.target.dataset.f;
        if (f === "skip") { r.skip = ev.target.checked; if (r.skip) r.size = ""; draw(); }
        else if (f) r[f] = ev.target.value;
      });
      wrap.addEventListener("change", (ev) => { const f = ev.target.dataset.f; if (f === "style" || f === "size") rows[Number(ev.target.closest(".plan-row").dataset.i)][f] = ev.target.value; });
      wrap.addEventListener("click", (ev) => {
        if (ev.target.closest('[data-m="remove"]')) { rows.splice(Number(ev.target.closest(".plan-row").dataset.i), 1); draw(); }
      });
      el.querySelector('[data-m="add"]').addEventListener("click", () => {
        rows.push({ style: "", size: "", skip: false }); draw();
        wrap.querySelector(".plan-row:last-child select")?.focus();
      });
      el.querySelector('[data-act="cancel"]').addEventListener("click", () => closeSheet());
      el.querySelector('[data-m="delete-plan"]')?.addEventListener("click", async () => {
        const ok = await confirmModal({ title: `Delete ${plan.name || "this occasion"}?`, message: "Its sizes will be removed for everyone.", confirmLabel: "Delete" });
        if (!ok) return;
        try { await store.deletePlan(plan.id); closeSheet(); toast("Deleted"); }
        catch (e) { const er = el.querySelector(".sheet-err"); er.textContent = e.message; er.hidden = false; }
      });
      wireSave(el, async () => {
        const name = el.querySelector("#pl-name").value.trim();
        if (!name) throw new Error("Give the occasion a name.");
        const clean = rows.map((r) => ({ style: r.style || "", size: r.skip ? "" : (r.size || "").trim(), skip: !!r.skip }))
          .filter((r) => r.style || r.size);
        for (const r of clean) if (r.skip && !r.style) throw new Error("Pick which style she won't need.");
        await store.setPlan({ id: plan.id, name, date: el.querySelector("#pl-date").value || "", note: el.querySelector("#pl-note").value.trim(), rows: clean });
        filter.plan = plan.id;
        return "Saved";
      });
    }
  );
}

// ── gift ideas ───────────────────────────────────────────────────────
function ideasView() {
  const items = list(S.data.items).filter((i) => !isClaimed(i.id));
  const ranked = [...items].sort((a, b) => (a.stock === "out") - (b.stock === "out") || (a.priority === "most" ? 0 : 1) - (b.priority === "most" ? 0 : 1));
  const prints = list(S.data.prints);
  const favs = prints.filter((p) => p.favorite);
  const lovedOutgrown = favs.filter((p) => p.outgrown);
  const lovedNow = favs.filter((p) => !p.outgrown);
  const favStyles = S.data.favoriteStyles || [];
  const lc = (x) => (x || "").toLowerCase();
  const nextPlan = sortedPlans().find((p) => (p.rows || []).length && (!p.date || planDate(p).getTime() >= Date.now() - 86400000));
  const sections = [];

  if (nextPlan) sections.push(`
    <section class="idea"><div class="section-title"><h2>Shopping for ${esc(nextPlan.name)}?</h2><button class="link" data-act="go-tab" data-to="sizes">All Occasions</button></div>
      <p class="muted">She'll have grown by then. Here's what to look for.</p>${planCard(nextPlan, { compact: true })}</section>`);

  if (ranked.length) sections.push(`
    <section class="idea"><div class="section-title"><h2>On Her Wishlist</h2><button class="link" data-act="go-tab" data-to="wishlist">See All ${items.length}</button></div>
      <div class="mini-list">${ranked.slice(0, 6).map((i) => `
        <button class="mini" data-act="go-tab" data-to="wishlist">${img(i.image, "mini-img", i.title)}
          <span><b>${esc(i.title)}</b><small>${esc([i.brand, i.size].filter(Boolean).join(" · "))}${i.stock === "out" ? ` · <em class="warn-text">sold out online</em>` : ""}</small></span></button>`).join("")}</div></section>`);

  if (lovedOutgrown.length) sections.push(`
    <section class="idea"><div class="section-title"><h2>Loved It, Outgrew It</h2></div>
      <p class="muted">Favorite prints she's outgrown. Any style in a bigger size is perfect.</p>
      <div class="grid">${lovedOutgrown.map((p) => tile({ ...p, outgrown: false, id: p.id }, "edit-print", p.printName, [], p.brand)).join("")}</div></section>`);

  if (lovedNow.length) sections.push(`
    <section class="idea"><div class="section-title"><h2>Favorite Prints, New Styles</h2></div>
      <p class="muted">She loves these prints. Any style she doesn't have yet is welcome.</p>
      <div class="idea-rows">${lovedNow.map((p) => {
        const has = p.types || [];
        const wants = favStyles.filter((s) => !has.some((h) => lc(h) === lc(s)));
        return `<div class="idea-row">${img(p.image, "mini-img", p.printName)}<div><b>${esc(p.printName)}</b> <span class="muted">· ${esc(p.brand || "")}</span>
          <div class="small">${has.length ? `Has: ${esc(has.join(", "))}.` : ""} ${wants.length ? `<span class="love">Would love: ${esc(wants.join(", "))}</span>` : "Try any other style!"}</div></div></div>`;
      }).join("")}</div></section>`);

  if (favStyles.length) sections.push(`
    <section class="idea"><div class="section-title"><h2>Favorite Styles, New Prints</h2></div>
      <div class="idea-rows">${favStyles.map((st) => {
        const n = prints.filter((p) => !p.outgrown && (p.types || []).some((t) => lc(t) === lc(st))).length;
        return `<div class="idea-row"><span class="fav-style">${esc(st)}</span><div class="small">Any print she doesn't have yet.${n ? ` She has ${n} that fit now, so search her closet first.` : ""}</div></div>`;
      }).join("")}</div></section>`);

  return `
    <div class="note">Not sure what to get? Start here. Before buying a print, <button class="link inline" data-act="go-tab" data-to="closet" data-focus="closet-search">search her closet</button> to make sure she doesn't have it.</div>
    ${sections.join("") || `<div class="empty">Gift ideas will show up here once there's a wishlist or some favorites.</div>`}`;
}

// ── family wishlist (Lys, Michael, Penny…) ──────────────────────────
const people = () => {
  const named = CONFIG.family || [];
  const extra = [...new Set(list(S.data?.family).map((i) => i.person))].filter((p) => !named.includes(p));
  return [...named, ...extra];
};
const openPeople = new Set();
function familyView() {
  const all = list(S.data.family);
  return `
    <div class="back-row"><button class="link" data-act="go-tab" data-to="wishlist">← ${esc(CONFIG.babyName)}'s Wishlist</button></div>
    <div class="section-title"><h2>The Family Wishlist</h2><span class="muted">${all.filter((i) => !isClaimed(i.id)).length} still open</span></div>
    <div class="note">Gifts for ${esc(people().join(", ").replace(/, ([^,]*)$/, " and $1"))}. Tap <b>I'll get this</b> so nobody doubles up. It's anonymous.</div>
    <div class="search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
      <input type="search" id="family-search" class="in" value="${esc(familyQuery)}" placeholder="Search the family wishlist" aria-label="Search the family wishlist" autocomplete="off" enterkeyhint="search" />
    </div>
    ${filterChips("person", [["all", "Everyone", all.length], ...people().map((p) => [p, p, all.filter((i) => i.person === p).length])])}
    <div id="family-results">${familyResults()}</div>`;
}
function familyResults() {
  const q = familyQuery.trim();
  const all = list(S.data.family)
    .filter((i) => filter.person === "all" || i.person === filter.person)
    .filter((i) => !q || matches(q, i.title, i.brand, i.person, i.sizes || [], i.notes, i.category === "clothes" ? "clothes" : ""));
  const who = people().filter((p) => filter.person === "all" || p === filter.person);
  const sections = who.map((p) => {
    const mine = all.filter((i) => i.person === p)
      .sort((a, b) => isClaimed(a.id) - isClaimed(b.id) || (a.priority === "most" ? 0 : 1) - (b.priority === "most" ? 0 : 1) || (a.createdAt || 0) - (b.createdAt || 0));
    if (q && !mine.length) return "";
    const open = q || who.length === 1 || openPeople.has(p) || !openPeople.size;
    return `<details class="brand-fold person-fold" data-person="${esc(p)}" ${open ? "open" : ""}>
      <summary class="brand-head"><h2>${esc(p)}</h2><span class="brand-meta">${mine.length} ${mine.length === 1 ? "Item" : "Items"}</span><span class="chev" aria-hidden="true"></span></summary>
      <div class="fam-list">${mine.length ? mine.map(familyCard).join("") : `<p class="muted">Nothing on ${esc(p)}'s list yet.</p>`}</div>
    </details>`;
  }).join("");
  return sections || `<div class="empty">Nothing matches “${esc(q)}”.</div>`;
}
function familyCard(i) {
  const claimed = isClaimed(i.id), mine = S.mine.has(i.id);
  const link = safeUrl(i.url) && !i.url.startsWith("data:") ? i.url : "";
  const k = (a) => `${a}:${i.id}`;
  const chips = [
    ...(i.category === "clothes" ? (i.sizes || []).map((z) => `<span class="chip">Size ${esc(z)}</span>`) : []),
    i.price && `<span class="chip tan">${esc(i.price)}</span>`,
  ].filter(Boolean);
  let actions;
  if (owner()) {
    actions = `${claimed ? `<span class="status taken">Claimed</span><button class="link" data-act="reset" data-id="${i.id}" ${dis(k("reset"))}>${armedLabel(k("reset"), "Reset", "Tap again to reset")}</button>` : `<span class="status taken">Open</span>`}
      <span class="spacer"></span><button class="link" data-act="edit-family" data-id="${i.id}">Edit</button>
      <button class="btn small soft" data-act="family-got" data-id="${i.id}" ${dis(k("fam-got"))}>${armedLabel(k("fam-got"), "Got it", "Tap again to remove")}</button>`;
  } else if (mine) {
    actions = `<span class="status">✓ You're getting this</span><span class="spacer"></span><button class="btn small ghost" data-act="unclaim" data-id="${i.id}" ${dis(k("claim"))}>${busy.has(k("claim")) ? "Undoing…" : "Undo"}</button>`;
  } else if (claimed) {
    actions = `<span class="status taken">Someone's got this one</span>`;
  } else {
    actions = `<span class="spacer"></span><button class="btn small" data-act="claim" data-id="${i.id}" ${dis(k("claim"))}>${busy.has(k("claim")) ? "Saving…" : "I'll get this"}</button>`;
  }
  const pic = img(i.image, "thumb", i.title);
  return `
    <article class="card ${claimed ? "claimed" : ""}">
      ${i.priority === "most" && !claimed ? `<span class="ribbon">Most Wanted</span>` : ""}
      ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${pic}</a>` : pic}
      <div class="card-body">
        <h3>${link ? `<a class="title-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>` : esc(i.title)}</h3>
        ${i.brand ? `<div class="meta">${esc(i.brand)}</div>` : ""}
        ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}
        ${i.notes ? `<div class="meta" style="margin-top:6px">${esc(i.notes)}</div>` : ""}
        ${link ? `<a class="link" style="padding-left:0" href="${esc(link)}" target="_blank" rel="noopener noreferrer">View item ↗</a>` : ""}
      </div>
      <div class="actions">${actions}</div>
    </article>`;
}
function familySheet(existing = null) {
  const e = existing || {};
  let person = e.person || (filter.person !== "all" ? filter.person : people()[0] || "");
  let category = e.category || "clothes";
  let sizes = [...(e.sizes || [])];
  let offered = [];
  const id = e.id || newId();
  openSheet(
    `<h2>${existing ? "Edit Family Wish" : "Add a Family Wish"}</h2>
     <label class="f">For</label>
     <div class="seg" data-g="person">${people().map((p) => `<button type="button" data-v="${esc(p)}" aria-pressed="${p === person}">${esc(p)}</button>`).join("")}</div>
     <div class="seg" data-g="category"><button type="button" data-v="clothes" aria-pressed="${category === "clothes"}">Clothes</button><button type="button" data-v="other" aria-pressed="${category === "other"}">Other</button></div>
     <label class="f" for="fm-url">Product link</label>
     <div class="import"><input class="in" id="fm-url" maxlength="600" value="${esc(e.url || "")}" placeholder="Paste a link to the product" inputmode="url" /><button class="btn small" data-m="fill">Fill in</button></div>
     <div class="err" id="fm-import-err" hidden></div>
     <label class="f" for="fm-title">Name</label><input class="in" id="fm-title" maxlength="120" value="${esc(e.title || "")}" placeholder="Linen button-down" />
     <label class="f" for="fm-brand">Brand</label><input class="in" id="fm-brand" maxlength="60" value="${esc(e.brand || "")}" />
     <div data-sizes>
       <div class="label-row"><label class="f">Sizes</label></div>
       <div class="type-picker" id="fm-sizes"></div>
       <div class="add-row" style="margin-top:8px"><input class="in" id="fm-size-new" maxlength="20" placeholder="Add a size, like M or 32x30" /><button class="btn small ghost" data-m="add-size">Add</button></div>
     </div>
     <label class="f" for="fm-price">Price</label><input class="in" id="fm-price" maxlength="20" value="${esc(e.price || "")}" placeholder="$48" />
     <label class="f" for="fm-priority">Priority</label>
     <select class="in" id="fm-priority"><option value="nice" ${e.priority !== "most" ? "selected" : ""}>Nice to have</option><option value="most" ${e.priority === "most" ? "selected" : ""}>Most wanted</option></select>
     <label class="f" for="fm-notes">Note for gifters (optional)</label><input class="in" id="fm-notes" maxlength="200" value="${esc(e.notes || "")}" />
     <label class="f" for="fm-image">Image address</label><input class="in" id="fm-image" maxlength="600" value="${esc(e.image || "")}" placeholder="https://…" />
     <div class="err sheet-err" hidden></div>
     <div class="sheet-actions">
       ${existing ? `<button class="link danger" data-act="delete">Delete</button>` : ""}
       <span class="spacer"></span>
       <button class="btn ghost" data-act="cancel">Cancel</button>
       <button class="btn" data-act="save">Save</button>
     </div>`,
    (el) => {
      const $ = (sel) => el.querySelector(sel);
      const drawSizes = () => {
        const all = [...new Set([...sizes, ...offered])];
        $("#fm-sizes").innerHTML = all.length
          ? all.map((z) => `<button type="button" class="type-opt" data-size="${esc(z)}" aria-pressed="${sizes.includes(z)}">${esc(z)}</button>`).join("")
          : `<span class="muted">Fill in from a link to pick from the store's sizes, or add one below.</span>`;
        $("[data-sizes]").hidden = category !== "clothes";
      };
      drawSizes();
      el.querySelectorAll(".seg[data-g]").forEach((g) => g.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-v]"); if (!b) return;
        g.querySelectorAll("[data-v]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        if (g.dataset.g === "person") person = b.dataset.v; else { category = b.dataset.v; drawSizes(); }
      }));
      $("#fm-sizes").addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-size]"); if (!b) return;
        const z = b.dataset.size;
        sizes = sizes.includes(z) ? sizes.filter((x) => x !== z) : [...sizes, z].slice(0, 8);
        drawSizes();
      });
      const addSize = () => { const v = $("#fm-size-new").value.trim(); if (v && !sizes.includes(v)) sizes = [...sizes, v].slice(0, 8); $("#fm-size-new").value = ""; drawSizes(); };
      $('[data-m="add-size"]').addEventListener("click", addSize);
      $("#fm-size-new").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addSize(); } });
      const fill = $('[data-m="fill"]');
      fill.addEventListener("click", async () => {
        if (fill.disabled) return;
        const errEl = $("#fm-import-err"); errEl.hidden = true;
        const url = $("#fm-url").value.trim();
        if (!/^https?:\/\//i.test(url)) { errEl.textContent = "Paste a full link starting with https://"; errEl.hidden = false; return; }
        fill.disabled = true; fill.textContent = "Reading…";
        try {
          const r = await store.importLink(url);
          const put = (sel, v) => { if (v && !$(sel).value) $(sel).value = v; };
          put("#fm-title", r.title); put("#fm-brand", r.brand); put("#fm-price", r.price);
          if (r.image) $("#fm-image").value = r.image;
          offered = (r.sizes || []).slice(0, 30);
          if (offered.length && category !== "clothes") { category = "clothes"; el.querySelectorAll('.seg[data-g="category"] [data-v]').forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === "clothes"))); }
          drawSizes();
          if (!r.title && !r.image) throw new Error("That store didn't share any details. Fill them in below.");
        } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
        finally { fill.disabled = false; fill.textContent = "Fill in"; }
      });
      $('[data-act="cancel"]').addEventListener("click", () => closeSheet());
      wireDelete(el, () => store.deleteFamilyItem(id));
      wireSave(el, async () => {
        const title = $("#fm-title").value.trim();
        if (!person) throw new Error("Choose who it's for.");
        if (!title) throw new Error("Give it a name.");
        await store.upsertFamilyItem({
          id, person, category, title, brand: $("#fm-brand").value.trim(),
          sizes: category === "clothes" ? sizes : [], price: $("#fm-price").value.trim(),
          priority: $("#fm-priority").value, notes: $("#fm-notes").value.trim(),
          url: $("#fm-url").value.trim(), image: $("#fm-image").value.trim(),
        });
        filter.person = filter.person === "all" ? "all" : person;
        return "Saved";
      });
    }
  );
}

// ── get the latest version (for a stale home-screen app) ─────────────
// Clears this phone's saved copy of the list, refreshes the browser's cached site files,
// then reloads. Nothing on the server changes.
async function forceUpdate() {
  if (busy.has("update")) return;
  busy.add("update"); render();
  try { localStorage.removeItem(`closet:${CONFIG.wishlistId}`); } catch {}
  try { for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister(); } catch {}
  try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch {}
  const base = location.href.split(/[?#]/)[0];
  await Promise.all(["", "index.html", "app.js", "store.js", "config.js"].map((f) =>
    fetch(new URL(f, base), { cache: "reload" }).catch(() => {})));
  const q = new URLSearchParams(location.search);
  q.set("fresh", Date.now().toString(36));
  location.replace(`${base}?${q.toString().replace(/=(&|$)/g, "$1")}${location.hash}`);
}

// ── share ────────────────────────────────────────────────────────────
const SITE_URL = "https://alyssamanse.github.io/MerrittsCloset/";
function shareSheet() {
  openSheet(
    `<h2>Share ${esc(CONFIG.babyName)}'s Closet</h2>
     <p class="muted">Anyone with the link can see the list and claim gifts. They can't change anything else.</p>
     <div class="share-link"><input class="in" id="share-url" readonly value="${SITE_URL}" aria-label="Link" /><button class="btn small" data-m="copy">Copy</button></div>
     ${navigator.share ? `<button class="btn ghost" data-m="native">Share…</button>` : ""}
     <div class="qr"><img src="qr.png" alt="QR code for ${esc(CONFIG.babyName)}'s Closet" width="220" height="220" /><a class="link" href="qr.png" download="merritts-closet-qr.png">Save QR code</a></div>
     <div class="sheet-actions"><span class="spacer"></span><button class="btn ghost" data-act="cancel">Done</button></div>`,
    (el) => {
      el.querySelector('[data-act="cancel"]').addEventListener("click", () => closeSheet());
      el.querySelector('[data-m="copy"]').addEventListener("click", async (ev) => {
        try { await navigator.clipboard.writeText(SITE_URL); ev.target.textContent = "Copied"; }
        catch { const i = el.querySelector("#share-url"); i.focus(); i.select(); }
      });
      el.querySelector('[data-m="native"]')?.addEventListener("click", () => navigator.share({ title: `${CONFIG.babyName}'s Closet`, text: `${CONFIG.babyName}'s wishlist and closet`, url: SITE_URL }).catch(() => {}));
    }
  );
}

// ── sheets (add / edit) ──────────────────────────────────────────────
// ── style-type choices: shared controls + the Manage window ─────────
const typesFor = (cat) => S.data?.typeLists?.[cat] || DEFAULT_TYPES[cat];
const manageLink = (cat) => `<button type="button" class="link manage" data-manage="${cat}">Manage</button>`;
const typeOptions = (cat, current) => `<option value="">Choose…</option>` +
  [...new Set([...(current ? [current] : []), ...typesFor(cat)])].map((t) => `<option ${current === t ? "selected" : ""}>${esc(t)}</option>`).join("");
const typePills = (cat, selected) =>
  [...new Set([...selected, ...typesFor(cat)])].map((t) => `<button type="button" class="type-opt" aria-pressed="${selected.includes(t)}" data-type="${esc(t)}">${esc(t)}</button>`).join("");

// Pill toggling + "Manage" links inside a sheet (delegated, so redrawn pills keep working).
function wireTypeControls(el, limitMsg) {
  el.addEventListener("click", (ev) => {
    const pill = ev.target.closest(".type-opt");
    if (pill) {
      const on = pill.getAttribute("aria-pressed") !== "true";
      if (on && pill.parentElement.querySelectorAll('[aria-pressed="true"]').length >= 8) return toast(limitMsg);
      pill.setAttribute("aria-pressed", on);
      return;
    }
    const m = ev.target.closest("[data-manage]");
    if (m) manageTypesModal(m.dataset.manage, (renames) => refreshTypeControls(el, renames));
  });
}

// Redraw the form's choices after the lists change, keeping what was picked (following renames).
function refreshTypeControls(el, renames) {
  const follow = (v) => renames.get((v || "").toLowerCase()) ?? v;
  for (const [sel, cat] of [["#f-type", "clothes"], ["#f-toytype", "toy"], ["#f-othertype", "other"]]) {
    const s = el.querySelector(sel);
    if (!s) continue;
    const cur = follow(s.value);
    s.innerHTML = typeOptions(cat, cur);
    s.value = cur;
  }
  el.querySelectorAll(".type-picker[data-cat]").forEach((p) => {
    const picked = [...p.querySelectorAll('[aria-pressed="true"]')].map((b) => follow(b.dataset.type));
    p.innerHTML = typePills(p.dataset.cat, picked);
  });
}

function typeUsage(cat, name) {
  const n = name.toLowerCase();
  const eq = (v) => (v || "").toLowerCase() === n;
  let count = list(S.data?.items).filter((i) => catOf(i) === cat && eq(i.type)).length;
  if (cat === "clothes") count += list(S.data?.prints).filter((p) => (p.types || []).some(eq)).length;
  else count += list(S.data?.toys).filter((t) => hasCat(t) === cat && eq(t.type)).length;
  return count;
}

// Small windows that sit on top of an open form without disturbing it.
function openModal(html) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(bg);
  return bg;
}
function confirmModal({ title, message, confirmLabel }) {
  return new Promise((resolve) => {
    const bg = openModal(`<h3>${esc(title)}</h3><p class="muted">${message}</p>
      <div class="sheet-actions"><span class="spacer"></span><button class="btn ghost" data-r="no">Cancel</button><button class="btn danger-btn" data-r="yes">${esc(confirmLabel)}</button></div>`);
    bg.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-r]");
      if (!b && ev.target !== bg) return;
      bg.remove();
      resolve(b?.dataset.r === "yes");
    });
    bg.querySelector('[data-r="no"]').focus();
  });
}

function manageTypesModal(cat, onDone) {
  const renames = new Map();            // old name (lowercase) → new name, for the open form
  let editing = null;                   // name being renamed
  let working = false;
  const bg = openModal(`<h3>Manage ${LIST_LABEL[cat]}</h3>
    <p class="muted">These are the choices in the form. Renaming also updates everything already tagged with it.</p>
    <div class="type-list"></div>
    <div class="add-row"><input class="in" id="new-type" maxlength="24" placeholder="Add a new one" aria-label="New choice" /><button class="btn small" data-m="add">Add</button></div>
    <div class="err" hidden></div>
    <div class="sheet-actions"><span class="spacer"></span><button class="btn" data-m="done">Done</button></div>`);
  const $list = bg.querySelector(".type-list");
  const $err = bg.querySelector(".err");
  const draw = () => {
    $list.innerHTML = typesFor(cat).map((t) => editing === t
      ? `<div class="type-row editing"><input class="in" id="rename-input" maxlength="24" value="${esc(t)}" aria-label="New name for ${esc(t)}" />
           <button class="btn small" data-m="save-rename" ${working ? "disabled" : ""}>Save</button><button class="link" data-m="cancel-rename">Cancel</button></div>`
      : `<div class="type-row" data-name="${esc(t)}"><span>${esc(t)}</span>
           <button class="link" data-m="rename" ${working ? "disabled" : ""}>Rename</button>
           <button class="link danger" data-m="delete" ${working ? "disabled" : ""}>Delete</button></div>`).join("")
      || `<p class="muted">No choices yet. Add one below.</p>`;
    bg.querySelector('[data-m="add"]').disabled = working;
    bg.querySelector("#rename-input")?.focus();
  };
  const run = async (fn) => {
    working = true; $err.hidden = true; draw();
    try { await fn(); } catch (e) { $err.textContent = e?.message || "That didn't save. Try again."; $err.hidden = false; }
    finally { working = false; draw(); }
  };
  const close = () => { bg.remove(); onDone?.(renames); };
  draw();

  bg.addEventListener("click", async (ev) => {
    if (ev.target === bg) return close();
    const b = ev.target.closest("[data-m]");
    if (!b || b.disabled) return;
    const name = b.closest(".type-row")?.dataset.name;
    switch (b.dataset.m) {
      case "done": return close();
      case "add": {
        const input = bg.querySelector("#new-type");
        const v = input.value.trim();
        if (!v) return;
        if (typesFor(cat).some((t) => t.toLowerCase() === v.toLowerCase())) { $err.textContent = `"${v}" is already in the list.`; $err.hidden = false; return; }
        return run(async () => { await store.addType(cat, v); input.value = ""; });
      }
      case "rename": editing = name; return draw();
      case "cancel-rename": editing = null; return draw();
      case "save-rename": {
        const from = editing;
        const to = bg.querySelector("#rename-input").value.trim();
        if (!to || to === from) { editing = null; return draw(); }
        return run(async () => {
          await store.renameType(cat, from, to);
          for (const [k, v] of renames) if (v.toLowerCase() === from.toLowerCase()) renames.set(k, to);
          renames.set(from.toLowerCase(), to);
          editing = null;
        });
      }
      case "delete": {
        const used = typeUsage(cat, name);
        const ok = await confirmModal({
          title: `Delete "${name}"?`,
          message: `It will no longer be a choice in the form.${used ? ` ${used} thing${used === 1 ? "" : "s"} already tagged "${esc(name)}" will keep that label.` : ""}`,
          confirmLabel: "Delete",
        });
        if (ok) return run(() => store.deleteType(cat, name));
      }
    }
  });
  bg.querySelector("#new-type").addEventListener("keydown", (ev) => { if (ev.key === "Enter") bg.querySelector('[data-m="add"]').click(); });
  bg.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.id === "rename-input") bg.querySelector('[data-m="save-rename"]').click(); });
}

function openSheet(html, onMount) {
  closeSheet(false);
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  bg.addEventListener("click", (e) => { if (e.target === bg) closeSheet(); });
  document.body.appendChild(bg);
  document.body.style.overflow = "hidden";
  onMount?.(bg.querySelector(".sheet"));
}
function closeSheet(rerender = true) {
  document.querySelector(".sheet-bg")?.remove();
  document.body.style.overflow = "";
  if (rerender) render();
}
// Clothing sizes offered in dropdowns (occasions, brand sizes, wishlist clothes).
const CLOTHING_SIZES = ["6–9M", "6–12M", "12–18M", "18–24M", "2T", "3T", "4T"];
const dash = (v) => String(v || "").trim().replace(/(\d)\s*-\s*(\d)/g, "$1–$2");
function sizeSelect(attrs, current = "", { blank = "Choose a size" } = {}) {
  const cur = dash(current);
  const opts = [...(cur && !CLOTHING_SIZES.includes(cur) ? [cur] : []), ...CLOTHING_SIZES];
  return `<select class="in" ${attrs}><option value="">${esc(blank)}</option>${opts.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`;
}
// Set a size dropdown's value, adding the option first if it isn't in the list.
function setSize(sel, v) {
  const val = dash(v);
  if (!sel || !val) return;
  if (![...sel.options].some((o) => o.value === val)) sel.add(new Option(val, val), 1);
  sel.value = val;
}
const sizeOptions = (extra = []) => [...new Set([...extra, ...SIZES])].map((s) => `<option value="${esc(s)}">`).join("");
const brandOptions = () => brands().map((b) => `<option value="${esc(b.name)}">`).join("");

// Save button: locked while saving; the sheet stays open (with the message) on failure.
function wireSave(el, save) {
  const btn = el.querySelector('[data-act="save"]');
  const errEl = el.querySelector(".sheet-err");
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    errEl.hidden = true;
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const msg = await save();
      closeSheet();
      if (msg) toast(msg);
    } catch (e) {
      errEl.textContent = e?.message || "That didn't save. Try again.";
      errEl.hidden = false;
      btn.disabled = false; btn.textContent = "Save";
    }
  });
}
function wireDelete(el, fn) {
  const btn = el.querySelector('[data-act="delete"]');
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    const ok = await confirmModal({ title: "Delete this?", message: "It will be removed for good.", confirmLabel: "Delete" });
    if (!ok) return;
    btn.disabled = true; btn.textContent = "Deleting…";
    try { await fn(); closeSheet(); toast("Deleted"); }
    catch (e) {
      btn.disabled = false; btn.textContent = "Delete";
      const err = el.querySelector(".sheet-err"); err.textContent = e.message; err.hidden = false;
    }
  });
}

// One form for all four kinds of record. dest: wishlist | closet, cat: clothes | toy.
// Fields carry data-show="wc wt cc ct" listing the combinations they appear in.
function itemSheet({ dest = tab === "closet" ? "closet" : "wishlist", cat, existing = null } = {}) {
  const fromFilter = { toys: "toy", other: "other" }[filter[dest]] || "clothes";
  cat = cat || (existing ? catOf(existing) : fromFilter);
  const e = existing || {};
  const isEdit = !!existing;
  const opts = (values, current) => [...new Set([...(current ? [current] : []), ...values])]
    .map((t) => `<option ${current === t ? "selected" : ""}>${esc(t)}</option>`).join("");
  const title = { wc: "Edit Wish", wt: "Edit Wish", wo: "Edit Wish", cc: "Edit Print", ct: "Edit Toy", co: "Edit Item" };
  const html = `
    <h2>${isEdit ? title[dest[0] + cat[0]] : "Add Something"}</h2>
    ${isEdit ? "" : `
      <div class="seg"><button type="button" data-dest="wishlist" aria-pressed="${dest === "wishlist"}">Wishlist</button><button type="button" data-dest="closet" aria-pressed="${dest === "closet"}">She has it</button></div>
      <div class="seg"><button type="button" data-cat="clothes" aria-pressed="${cat === "clothes"}">Clothes</button><button type="button" data-cat="toy" aria-pressed="${cat === "toy"}">Toy</button><button type="button" data-cat="other" aria-pressed="${cat === "other"}">Other</button></div>`}
    <label class="f" for="f-url">Product link</label>
    <div class="import">
      <input class="in" id="f-url" name="url" type="url" inputmode="url" maxlength="600" placeholder="Paste a link…" value="${esc(e.url || "")}" />
      <button class="btn small" type="button" data-act="import">Fill in</button>
    </div>
    <div class="err" id="import-err" hidden></div>
    <div class="preview"><img id="pv" src="${esc(safeUrl(e.image) || PLACEHOLDER)}" alt="" referrerpolicy="no-referrer" onerror="this.src='${PLACEHOLDER}'"><span class="muted">The photo comes from the link, or paste an image address below.</span></div>

    <div data-show="wc wt wo ct co">
      <label class="f" for="f-title">Name</label>
      <input class="in" id="f-title" name="title" maxlength="120" value="${esc(e.title || e.name || "")}" placeholder="Zippered footie" />
    </div>
    <div class="row">
      <div><label class="f" for="f-brand">Brand</label><input class="in" id="f-brand" name="brand" maxlength="60" list="dl-brands" value="${esc(e.brand || "")}" placeholder="Kyte Baby" /></div>
      <div data-show="wc cc"><label class="f" for="f-print">Print</label><input class="in" id="f-print" name="printName" maxlength="80" value="${esc(e.printName || "")}" placeholder="Strawberry" /></div>
    </div>
    <div data-show="wc">
      <div class="label-row"><label class="f" for="f-type">Type</label>${manageLink("clothes")}</div>
      <select class="in" id="f-type" name="type">${typeOptions("clothes", cat === "clothes" ? e.type : "")}</select>
    </div>
    <div data-show="wt ct">
      <div class="label-row"><label class="f" for="f-toytype">Kind of toy</label>${manageLink("toy")}</div>
      <select class="in" id="f-toytype" name="toyType">${typeOptions("toy", cat === "toy" ? e.type : "")}</select>
    </div>
    <div data-show="wo co">
      <div class="label-row"><label class="f" for="f-othertype">What kind</label>${manageLink("other")}</div>
      <select class="in" id="f-othertype" name="otherType">${typeOptions("other", cat === "other" ? e.type : "")}</select>
    </div>
    <div data-show="cc">
      <label class="check"><input type="checkbox" id="f-fav" name="favorite" ${e.favorite ? "checked" : ""}> ★ Favorite print</label>
      <label class="check"><input type="checkbox" id="f-og" name="outgrown" ${e.outgrown ? "checked" : ""}> Outgrown <span class="muted">(welcome again in a bigger size)</span></label>
      <div class="label-row"><label class="f">Styles she has in this print</label>${manageLink("clothes")}</div>
      <div class="type-picker" data-cat="clothes" role="group" aria-label="Styles she has">${typePills("clothes", e.types || [])}</div>
    </div>
    <div class="row" data-show="wc wt wo">
      <div data-show="wc"><label class="f" for="f-size">Size</label>${sizeSelect('id="f-size" name="size"', e.size || "")}</div>
      <div data-show="wt"><label class="f" for="f-age">Age range</label><input class="in" id="f-age" name="ageRange" maxlength="20" value="${esc(e.ageRange || "")}" placeholder="6m+" /></div>
      <div><label class="f" for="f-price">Price</label><input class="in" id="f-price" name="price" maxlength="20" value="${esc(e.price || "")}" placeholder="$38" /></div>
    </div>
    <div data-show="wc wt wo">
      <label class="f" for="f-priority">Priority</label>
      <select class="in" id="f-priority" name="priority">
        <option value="nice" ${e.priority !== "most" ? "selected" : ""}>Nice to have</option>
        <option value="most" ${e.priority === "most" ? "selected" : ""}>Most wanted</option>
      </select>
    </div>
    <div data-show="wc">
      <label class="check"><input type="checkbox" id="f-sizeflex" name="sizeFlexible" ${e.sizeFlexible ? "checked" : ""}> A bigger size is fine too</label>
      <label class="check"><input type="checkbox" id="f-printflex" name="printFlexible" ${e.printFlexible ? "checked" : ""}> Any print in this style is fine</label>
    </div>
    <div data-show="wc wt wo">
      <label class="f" for="f-notes">Note for gifters (optional)</label>
      <input class="in" id="f-notes" name="notes" maxlength="200" value="${esc(e.notes || "")}" placeholder="Sells out fast, check back" />
    </div>
    <label class="f" for="f-image">Image address</label>
    <input class="in" id="f-image" name="image" maxlength="600" value="${esc(e.image && !e.image.startsWith("data:") ? e.image : "")}" placeholder="https://…" />

    <datalist id="dl-brands">${brandOptions()}</datalist>
    <datalist id="dl-sizes">${sizeOptions()}</datalist>
    <div class="err sheet-err" hidden></div>
    <div class="sheet-actions">
      ${isEdit ? `<button class="link danger" data-act="delete">Delete</button>` : ""}
      <span class="spacer"></span>
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn" data-act="save">Save</button>
    </div>`;

  openSheet(html, (el) => {
    const f = (n) => el.querySelector(`[name="${n}"]`);
    const mode = () => dest[0] + cat[0]; // wc wt wo | cc ct co
    const apply = () => {
      el.querySelectorAll("[data-show]").forEach((n) => (n.hidden = !n.dataset.show.split(" ").includes(mode())));
      f("title").placeholder = { toy: "Stacking cups", other: "Muslin blanket", clothes: "Zippered footie" }[cat];
    };
    apply();
    for (const [attr, set] of [["dest", (v) => (dest = v)], ["cat", (v) => (cat = v)]]) {
      el.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener("click", () => {
        set(b.dataset[attr]);
        el.querySelectorAll(`[data-${attr}]`).forEach((x) => x.setAttribute("aria-pressed", x === b));
        apply();
      }));
    }
    wireTypeControls(el, "Up to 8 styles per print");
    f("image").addEventListener("change", () => (el.querySelector("#pv").src = safeUrl(f("image").value) || PLACEHOLDER));
    f("brand").addEventListener("change", () => {
      const b = brandByName(f("brand").value);
      if (cat === "clothes" && b?.currentSize && !f("size").value) setSize(f("size"), b.currentSize);
    });

    // Link import runs only on tap (never per keystroke) and is locked while running.
    const importBtn = el.querySelector('[data-act="import"]');
    importBtn.addEventListener("click", async () => {
      if (importBtn.disabled) return;
      const errEl = el.querySelector("#import-err");
      errEl.hidden = true;
      const url = f("url").value.trim();
      if (!/^https?:\/\//i.test(url)) { errEl.textContent = "Paste a full link starting with https://"; errEl.hidden = false; return; }
      importBtn.disabled = true; importBtn.textContent = "Reading…";
      try {
        const r = await store.importLink(url);
        const fill = (n, v) => { if (v && !f(n).value) f(n).value = v; };
        fill("title", r.title);
        fill("brand", r.brand ? brandByName(r.brand)?.name || r.brand : "");
        if (cat === "clothes") fill("printName", r.printName);
        fill("price", r.price);
        if (r.image) { f("image").value = r.image; el.querySelector("#pv").src = r.image; }
        if (cat === "clothes") {
          // (store sizes vary by brand; the dropdown keeps to her standard sizes)
          const b = brandByName(f("brand").value);
          if (b?.currentSize && !f("size").value) setSize(f("size"), b.currentSize);
        }
        if (!r.title && !r.image) throw new Error("That store didn't share any details. Fill them in below.");
      } catch (err) {
        errEl.textContent = err.message; errEl.hidden = false;
      } finally {
        importBtn.disabled = false; importBtn.textContent = "Fill in";
      }
    });

    el.querySelector('[data-act="cancel"]').addEventListener("click", () => closeSheet());
    wireDelete(el, () => ({ cc: store.deletePrint, ct: store.deleteToy, co: store.deleteToy }[mode()] || store.deleteItem)(e.id));
    // The id is fixed when the sheet opens, so pressing Save again after a
    // failure updates the same record instead of creating a duplicate.
    const recordId = e.id || newId();
    wireSave(el, async () => {
      const v = (n) => f(n).value.trim();
      const common = { id: recordId, url: v("url"), brand: v("brand"), image: v("image") };
      const m = mode();
      if (m === "cc") {
        if (!v("printName") && !common.brand) throw new Error("Add at least a brand or a print name.");
        const types = [...el.querySelectorAll('.type-opt[aria-pressed="true"]')].map((b) => b.dataset.type);
        await store.upsertPrint({ ...common, printName: v("printName"), types, favorite: f("favorite").checked, ...(f("outgrown").checked && { outgrown: true }) }); // omitted = not outgrown
      } else if (m === "ct" || m === "co") {
        if (!v("title")) throw new Error("Give it a name.");
        await store.upsertToy({ ...common, category: cat, name: v("title"), type: f(cat === "toy" ? "toyType" : "otherType").value });
      } else {
        const item = m === "wc"
          ? { ...common, category: "clothes", title: v("title") || v("printName"), printName: v("printName"), type: f("type").value,
              size: v("size"), sizeFlexible: f("sizeFlexible").checked, printFlexible: f("printFlexible").checked }
          : m === "wt"
            ? { ...common, category: "toy", title: v("title"), type: f("toyType").value, ageRange: v("ageRange") }
            : { ...common, category: "other", title: v("title"), type: f("otherType").value };
        Object.assign(item, { price: v("price"), priority: f("priority").value, notes: v("notes") });
        if (!item.title) throw new Error("Give it a name first.");
        await store.upsertItem(item);
      }
      if (!isEdit) {
        tab = dest;
        // Land on a view that shows what was just added.
        if (dest === "closet") filter.closet = CAT_FILTER[cat];
        else if (filter.wishlist !== "all") filter.wishlist = CAT_FILTER[cat];
        history.replaceState(null, "", `${location.search}#${tab}`);
      }
      if (isEdit) return "Saved";
      return dest === "wishlist" ? "Added to the wishlist" : cat === "clothes" ? "Added to the closet" : "Added to what she has";
    });
  });
}

function brandSheet(existing = null) {
  const b = existing || {};
  openSheet(
    `<h2>${existing ? "Edit Brand" : "Add Brand"}</h2>
     <label class="f" for="b-name">Brand</label><input class="in" id="b-name" name="name" maxlength="60" value="${esc(b.name || "")}" placeholder="Little Sleepies" />
     <label class="f" for="b-size">Current size</label>${sizeSelect('id="b-size" name="currentSize"', b.currentSize || "")}
     <label class="f" for="b-notes">Sizing note (optional)</label><input class="in" id="b-notes" name="notes" maxlength="140" value="${esc(b.notes || "")}" placeholder="Runs small, size up" />
     <datalist id="dl-sizes">${sizeOptions()}</datalist>
     <div class="err sheet-err" hidden></div>
     <div class="sheet-actions">
       ${existing ? `<button class="link danger" data-act="delete">Delete</button>` : ""}
       <span class="spacer"></span>
       <button class="btn ghost" data-act="cancel">Cancel</button>
       <button class="btn" data-act="save">Save</button>
     </div>`,
    (el) => {
      const v = (n) => el.querySelector(`[name="${n}"]`).value.trim();
      const recordId = b.id || newId();
      el.querySelector('[data-act="cancel"]').addEventListener("click", () => closeSheet());
      wireDelete(el, () => store.deleteBrand(b.id));
      wireSave(el, async () => {
        const d = { id: recordId, name: v("name"), currentSize: v("currentSize"), notes: v("notes") };
        if (!d.name) throw new Error("The brand needs a name.");
        await store.upsertBrand(d);
        return "Saved";
      });
    }
  );
}

// Bulk import of a reviewed list (from Claude's order-email review page).
// Sends small batches one after another; the server merges by brand + print, so re-importing is safe.
const IMPORT_CHUNK = 30;
function parseImport(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error("That doesn't look like an import list. Copy it again from the review page."); }
  if (!d || d.kind !== "merritts-closet-import" || !Array.isArray(d.prints) || !Array.isArray(d.toys)) throw new Error("That doesn't look like an import list. Copy it again from the review page.");
  if (d.prints.length + d.toys.length > 600) throw new Error("That list is too long to import at once.");
  return { prints: d.prints, toys: d.toys };
}
function importSheet() {
  openSheet(
    `<h2>Import List</h2>
     <p class="muted">On the review page Claude made, tap <b>Copy for Closet</b>, then paste here. Prints she already has get the new styles added. Nothing is duplicated.</p>
     <textarea class="in" id="imp-text" rows="6" placeholder="Paste here" aria-label="Import list"></textarea>
     <p class="muted" id="imp-sum" aria-live="polite"></p>
     <div class="err sheet-err" hidden></div>
     <div class="sheet-actions"><span class="spacer"></span>
       <button class="btn ghost" data-act="cancel">Cancel</button>
       <button class="btn" data-act="go" disabled>Import</button></div>`,
    (el) => {
      const ta = el.querySelector("#imp-text"), sum = el.querySelector("#imp-sum"), go = el.querySelector('[data-act="go"]'), err = el.querySelector(".sheet-err");
      let parsed = null;
      const check = () => {
        err.hidden = true; parsed = null; go.disabled = true; sum.textContent = "";
        if (!ta.value.trim()) return;
        try {
          parsed = parseImport(ta.value.trim());
          sum.textContent = `${parsed.prints.length} prints and ${parsed.toys.length} toys or other things.`;
          go.disabled = !(parsed.prints.length + parsed.toys.length);
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      };
      ta.addEventListener("input", check);
      el.querySelector('[data-act="cancel"]').addEventListener("click", () => closeSheet());
      go.addEventListener("click", async () => {
        if (!parsed || go.disabled) return;
        go.disabled = true; ta.disabled = true;
        const recs = [...parsed.prints.map((p) => ["p", p]), ...parsed.toys.map((t) => ["t", t])];
        try {
          for (let i = 0; i < recs.length; i += IMPORT_CHUNK) {
            const part = recs.slice(i, i + IMPORT_CHUNK);
            sum.textContent = `Importing ${Math.min(i + IMPORT_CHUNK, recs.length)} of ${recs.length}…`;
            await store.importBatch(part.filter(([k]) => k === "p").map(([, v]) => v), part.filter(([k]) => k === "t").map(([, v]) => v));
          }
          closeSheet();
          toast(`Imported ${recs.length}`);
        } catch (e) {
          err.textContent = `${e.message || "Import stopped."} Anything before this point was saved. You can paste and import again safely.`;
          err.hidden = false; ta.disabled = false; go.disabled = false;
        }
      });
    }
  );
}

// ── events (one delegated listener, attached once) ───────────────────
$app.addEventListener("input", (ev) => {
  if (ev.target.id === "family-search") {
    familyQuery = ev.target.value.slice(0, 60);
    const out = document.getElementById("family-results");
    if (out) out.innerHTML = familyResults();
    return;
  }
  if (ev.target.id !== "closet-search") return;
  closetQuery = ev.target.value.slice(0, 60);
  const out = document.getElementById("closet-results");
  if (out) out.innerHTML = closetResults();
});
$app.addEventListener("toggle", (ev) => { // remember which brands are open across re-renders
  const d = ev.target;
  if (d.classList?.contains("person-fold")) { if (d.open) openPeople.add(d.dataset.person); else openPeople.delete(d.dataset.person); return; }
  if (d.classList?.contains("brand-fold")) { if (d.open) openBrands.add(d.dataset.brand); else openBrands.delete(d.dataset.brand); }
}, true);
$app.addEventListener("keydown", (ev) => {
  if ((ev.target.id === "closet-search" || ev.target.id === "family-search") && ev.key === "Enter") ev.target.blur(); // closes the phone keyboard
});
$app.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-tab],[data-act],[data-filter]");
  if (!t || t.disabled) return;
  if (t.dataset.filter) {
    const [which, value] = t.dataset.filter.split(":");
    filter[which] = value;
    render();
    return;
  }
  if (t.dataset.tab) {
    tab = t.dataset.tab;
    history.replaceState(null, "", `${location.search}#${tab}`);
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  if (!store) return;
  const id = t.dataset.id;
  switch (t.dataset.act) {
    case "claim": return act(`claim:${id}`, () => store.claim(id), "Thank you! It's marked as yours.");
    case "unclaim": return act(`claim:${id}`, () => store.unclaim(id), "Undone. It's open again.");
    case "reset": if (confirmTap(`reset:${id}`)) act(`reset:${id}`, () => store.resetClaim(id), "Claim cleared"); return;
    case "receive": return act(`receive:${id}`, () => store.receive(id), isToy(S.data.items[id] || {}) ? "Moved to what she has" : "Moved to the closet");
    case "edit-item": return itemSheet({ dest: "wishlist", existing: S.data.items[id] });
    case "edit-print": return itemSheet({ dest: "closet", cat: "clothes", existing: S.data.prints[id] });
    case "edit-toy": return itemSheet({ dest: "closet", cat: hasCat(S.data.toys[id] || {}), existing: S.data.toys[id] });
    case "add": return tab === "family" ? familySheet() : tab === "sizes" ? brandSheet() : itemSheet();
    case "edit-family": return familySheet(S.data.family?.[id]);
    case "family-got": if (confirmTap(`fam-got:${id}`)) act(`fam-got:${id}`, () => store.deleteFamilyItem(id), "Removed from the list"); return;
    case "add-brand": return brandSheet();
    case "import-list": return importSheet();
    case "edit-colors": return colorsSheet();
    case "check-stock": return runStockCheck({ quiet: false });
    case "find-photos": return runFindPhotos();
    case "add-plan": return planSheet(t.dataset.preset ? presetPlan(t.dataset.preset) : null);
    case "edit-plan": return planSheet((S.data.plans || []).find((p) => p.id === id));
    case "pick-plan": filter.plan = id; return render();
    case "go-tab": tab = t.dataset.to; history.replaceState(null, "", `${location.search}#${tab}`); render(); window.scrollTo({ top: 0 });
      if (t.dataset.focus) document.getElementById(t.dataset.focus)?.focus(); return;
    case "share": return shareSheet();
    case "fold-all":
      for (const d of document.querySelectorAll(".brand-fold")) { d.open = t.dataset.open === "1"; if (d.open) openBrands.add(d.dataset.brand); else openBrands.delete(d.dataset.brand); }
      return;
    case "force-update": return forceUpdate();
    case "edit-favstyles": return favStylesSheet();
    case "edit-brand": return brandSheet(S.data.brands[id]);
    case "refresh": return act("refresh", async () => { if (!(await store.refresh())) toast("Already up to date"); });
    case "signin": return act("signin", () => store.signInOwner());
    case "signout": return act("signout", () => store.signOut());
  }
});
window.addEventListener("hashchange", () => {
  const h = location.hash.slice(1);
  if (TABS.includes(h) && h !== tab) { tab = h; render(); }
});

// ── boot ─────────────────────────────────────────────────────────────
document.title = `${CONFIG.babyName}'s Closet`;
render();
(async () => {
  try {
    store = isDemo ? createDemoStore() : await createFirebaseStore();
  } catch (e) {
    console.error(e);
    S = { ...S, status: "error" };
    render();
    return;
  }
  store.start((next) => { S = next; render(); maybeAutoStock(); });
})();
