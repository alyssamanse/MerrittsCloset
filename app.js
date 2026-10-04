import { CONFIG } from "./config.js";
import { createFirebaseStore, createDemoStore } from "./store.js";

const SIZES = ["Preemie", "Newborn", "0–3M", "3–6M", "6–9M", "6–12M", "9–12M", "12M", "12–18M", "18M", "18–24M", "2T", "3T", "4T", "5T"];
const TABS = ["wishlist", "closet", "sizes"];
const OTHER_TYPES = ["Blanket", "Swaddle", "Lovey", "Bedding", "Bath", "Feeding", "Books", "Room decor", "Gear", "Keepsake"];
const TOY_TYPES = ["Rattle", "Teether", "Stacker", "Blocks", "Book", "Plush", "Bath", "Music", "Activity", "Push & ride", "Puzzle", "Pretend play", "Outdoor"];
const TYPES = ["Zippy", "Shorty", "Footie", "Romper", "Bodysuit", "Two-piece PJs", "Two-piece daywear", "Pajamas", "Dress", "Bubble", "Swim", "Outerwear", "Separates", "Swaddle", "Sleep bag", "Blanket", "Bib", "Hat", "Bow", "Shoes", "Accessory"];
// Default choices; once the owner edits a list it's stored with the wishlist (typeLists).
const DEFAULT_TYPES = { clothes: TYPES, toy: TOY_TYPES, other: OTHER_TYPES };
const LIST_LABEL = { clothes: "clothing styles", toy: "kinds of toy", other: "kinds of other things" };
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
const brandByName = (name) => list(S.data?.brands).find((b) => b.name.trim().toLowerCase() === (name || "").trim().toLowerCase());
const catOf = (i) => (i.category === "toy" || i.category === "other" ? i.category : "clothes"); // wishlist items
const hasCat = (t) => (t.category === "other" ? "other" : "toy");                             // "what she has" non-clothes
const isToy = (i) => catOf(i) !== "clothes"; // toys and other things share the no-size layout
const CAT_FILTER = { clothes: "clothes", toy: "toys", other: "other" };
const filter = { wishlist: "all", closet: "clothes", fit: "all" }; // view-only, no requests
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
  const searching = document.activeElement?.id === "closet-search";
  const caret = searching ? document.activeElement.selectionStart : null;
  queueMicrotask(() => {
    const box = searching && document.getElementById("closet-search");
    if (box) { box.focus(); try { box.setSelectionRange(caret, caret); } catch {} }
  });
  const name = esc(CONFIG.babyName);
  $app.innerHTML = `
    ${isDemo ? `<div class="demo-bar">Preview with sample data. Nothing here is saved.</div>` : ""}
    <header class="hero">
      ${BEAR}
      <h1>${name}'s Closet</h1>
      <p>Wishlist · favorite brands · what she already has</p>
    </header>
    <nav class="tabs" role="tablist">
      ${TABS.map((t) => `<button class="tab" role="tab" aria-selected="${tab === t}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
    </nav>
    <main>${adminPanel()}${body()}</main>
    ${owner() && S.status === "ok" ? `<button class="btn fab" data-act="add">+ Add</button>` : ""}
    <footer>
      <button class="link quiet" data-act="refresh" ${dis("refresh")}>Refresh</button>
      ${S.user ? `<span class="muted"> · ${owner() ? "Editing on" : "Signed in"} · </span><button class="link" data-act="signout">Sign out</button>` : ""}
    </footer>`;
}

function adminPanel() {
  if (!adminEntry || owner()) return "";
  if (S.user) {
    return `<div class="admin-card"><b>That Google account can't edit this list.</b>
      <p class="muted">Sign out, then sign in with the account that manages ${esc(CONFIG.babyName)}'s list.</p>
      <button class="btn ghost" data-act="signout" ${dis("signout")}>Sign out</button></div>`;
  }
  return `<div class="admin-card"><b>Owner sign-in</b>
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
  return tab === "wishlist" ? wishlistView() : tab === "closet" ? closetView() : sizesView();
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
    .sort((a, b) => isClaimed(a.id) - isClaimed(b.id) || (a.priority === "most" ? 0 : 1) - (b.priority === "most" ? 0 : 1) || (a.createdAt || 0) - (b.createdAt || 0));
  const open = shown.filter((i) => !isClaimed(i.id)).length;
  return `
    ${owner() ? "" : `<div class="note">Tap <b>I'll get this</b> so nobody doubles up. It's anonymous, and you can undo it from this same phone or computer.</div>`}
    <div class="section-title"><h2>Wishlist</h2><span class="muted">${open} still open</span></div>
    ${filterChips("wishlist", [["all", "All", all.length], ["clothes", "Clothes", count("clothes")], ["toys", "Toys", count("toy")], ["other", "Other", count("other")]])}
    ${shown.length ? shown.map(itemCard).join("") : `<div class="empty">Nothing here right now.</div>`}`;
}

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
      ${i.priority === "most" && !claimed ? `<span class="ribbon">Most wanted</span>` : ""}
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
    <div class="section-title"><h2>What she has</h2>${owner() ? `<button class="link" data-act="import-list">Import list</button>` : ""}</div>
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
    ${mp.length ? printGroups(mp) : ""}
    ${mt.length ? `<div class="brand-head"><h2>Toys</h2></div>${thingGrid(mt)}` : ""}
    ${mo.length ? `<div class="brand-head"><h2>Other things</h2></div>${thingGrid(mo)}` : ""}`;
}

function printGroups(prints) {
  const groups = new Map();
  for (const p of prints) {
    const key = (p.brand || "Other").trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.keys()].sort((a, b) => a.localeCompare(b)).map((n) => {
    const b = brandByName(n);
    const ps = groups.get(n).sort((a, b) => !!a.outgrown - !!b.outgrown || (a.printName || "").localeCompare(b.printName || ""));
    return `
      <div class="brand-head"><h2>${esc(n)}</h2>${b?.currentSize ? `<span class="chip">Wears ${esc(b.currentSize)}</span>` : ""}</div>
      <div class="grid">
        ${ps.map((p) => tile(p, "edit-print", (p.favorite ? "★ " : "") + (p.printName || "Untitled print"), p.types || [])).join("")}
      </div>`;
  }).join("");
}

function clothesView(prints) {
  const og = prints.filter((p) => p.outgrown);
  const shown = filter.fit === "fits" ? prints.filter((p) => !p.outgrown) : filter.fit === "outgrown" ? og : prints;
  return `
    <div class="note">Prints ${esc(CONFIG.babyName)} already has, and the styles she has them in. A print she has as a zippy can still be a lovely dress!${og.length ? ` Faded prints are ones she's <b>outgrown</b>. She'd love those again in a bigger size.` : ""}</div>
    ${favoritesView(prints)}
    ${og.length ? filterChips("fit", [["all", "All", prints.length], ["fits", "Fits now", prints.length - og.length], ["outgrown", "Outgrown", og.length]]) : ""}
    ${shown.length ? printGroups(shown) : `<div class="empty">${prints.length ? "Nothing here." : "No clothes listed yet."}</div>`}`;
}

function favoritesView(prints) {
  const favPrints = prints.filter((p) => p.favorite).sort((a, b) => !!b.outgrown - !!a.outgrown || (a.printName || "").localeCompare(b.printName || ""));
  const favStyles = S.data.favoriteStyles || [];
  if (!favPrints.length && !favStyles.length) {
    return owner()
      ? `<div class="favs empty-favs"><b>Her favorites</b><span class="muted">Tap a print and turn on ★ Favorite print, or </span><button class="link" data-act="edit-favstyles">pick favorite styles</button></div>`
      : "";
  }
  const hasStyle = (style) => prints.filter((p) => !p.outgrown && (p.types || []).some((t) => t.toLowerCase() === style.toLowerCase()));
  return `
    <section class="favs" aria-label="Her favorites">
      <div class="favs-head"><h2>★ Her favorites</h2>${owner() ? `<button class="link" data-act="edit-favstyles">Edit styles</button>` : ""}</div>
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
    `<h2>Favorite styles</h2>
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
    <div class="section-title"><h2>Favorite brands</h2>${owner() ? `<button class="link" data-act="add-brand">+ Brand</button>` : ""}</div>
    ${bs.length
      ? bs.map((b) => `
      <div class="size-row">
        <div class="name"><strong>${esc(b.name)}</strong>${b.notes ? `<span class="muted">${esc(b.notes)}</span>` : ""}</div>
        <div class="size-badge">${esc(b.currentSize || "—")}<small>${b.currentSize ? "or bigger" : "size not set"}</small></div>
        ${owner() ? `<button class="link" data-act="edit-brand" data-id="${b.id}">Edit</button>` : ""}
      </div>`).join("")
      : `<div class="empty">No brands yet.</div>`}
    <div class="section-title"><h2>Her colors</h2>${owner() ? `<button class="link" data-act="edit-colors">Edit</button>` : ""}</div>
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
    `<h2>Her colors</h2>
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
  const title = { wc: "Edit wish", wt: "Edit wish", cc: "Edit print", ct: "Edit toy" };
  const html = `
    <h2>${isEdit ? title[dest[0] + cat[0]] : "Add something"}</h2>
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
      <div data-show="wc"><label class="f" for="f-size">Size</label><input class="in" id="f-size" name="size" maxlength="20" list="dl-sizes" value="${esc(e.size || "")}" placeholder="12–18M" /></div>
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
      if (cat === "clothes" && b?.currentSize && !f("size").value) f("size").value = b.currentSize;
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
          if (r.sizes?.length) el.querySelector("#dl-sizes").innerHTML = sizeOptions(r.sizes);
          const b = brandByName(f("brand").value);
          if (b?.currentSize && !f("size").value) f("size").value = b.currentSize;
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
    `<h2>${existing ? "Edit brand" : "Add brand"}</h2>
     <label class="f" for="b-name">Brand</label><input class="in" id="b-name" name="name" maxlength="60" value="${esc(b.name || "")}" placeholder="Little Sleepies" />
     <label class="f" for="b-size">Current size</label><input class="in" id="b-size" name="currentSize" maxlength="20" list="dl-sizes" value="${esc(b.currentSize || "")}" placeholder="6–12M" />
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
    `<h2>Import list</h2>
     <p class="muted">On the review page Claude made, tap <b>Copy for closet</b>, then paste here. Prints she already has get the new styles added. Nothing is duplicated.</p>
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
  if (ev.target.id !== "closet-search") return;
  closetQuery = ev.target.value.slice(0, 60);
  const out = document.getElementById("closet-results");
  if (out) out.innerHTML = closetResults();
});
$app.addEventListener("keydown", (ev) => {
  if (ev.target.id === "closet-search" && ev.key === "Enter") ev.target.blur(); // closes the phone keyboard
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
    case "add": return tab === "sizes" ? brandSheet() : itemSheet();
    case "add-brand": return brandSheet();
    case "import-list": return importSheet();
    case "edit-colors": return colorsSheet();
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
  store.start((next) => { S = next; render(); });
})();
