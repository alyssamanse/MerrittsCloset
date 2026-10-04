import { CONFIG } from "./config.js";
import { createFirebaseStore, createDemoStore } from "./store.js";

const SIZES = ["Preemie", "Newborn", "0–3M", "3–6M", "6–9M", "6–12M", "9–12M", "12M", "12–18M", "18M", "18–24M", "2T", "3T", "4T", "5T"];
const TABS = ["wishlist", "closet", "sizes"];
const OTHER_TYPES = ["Blanket", "Swaddle", "Lovey", "Bedding", "Bath", "Feeding", "Books", "Room decor", "Gear", "Keepsake"];
const TOY_TYPES = ["Rattle", "Teether", "Stacker", "Blocks", "Book", "Plush", "Bath", "Music", "Activity", "Push & ride", "Puzzle", "Pretend play", "Outdoor"];
const TYPES = ["Zippy", "Footie", "Romper", "Bodysuit", "Two-piece", "Pajamas", "Dress", "Bubble", "Swaddle", "Sleep bag", "Blanket", "Bib", "Hat", "Bow", "Shoes"];
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
const filter = { wishlist: "all", closet: "clothes" }; // view-only, no requests
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
  const prints = list(S.data.prints);
  const things = list(S.data.toys);
  const toys = things.filter((t) => hasCat(t) === "toy");
  const others = things.filter((t) => hasCat(t) === "other");
  return `
    <div class="section-title"><h2>What she has</h2></div>
    ${filterChips("closet", [["clothes", "Clothes", prints.length], ["toys", "Toys", toys.length], ["other", "Other", others.length]])}
    ${filter.closet === "toys" ? thingsView(toys, "toy") : filter.closet === "other" ? thingsView(others, "other") : clothesView(prints)}`;
}

function clothesView(prints) {
  const groups = new Map();
  for (const p of prints) {
    const key = (p.brand || "Other").trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  return `
    <div class="note">Prints ${esc(CONFIG.babyName)} already has, and the styles she has them in. A print she has as a zippy can still be a lovely dress!</div>
    ${favoritesView(prints)}
    ${names.length
      ? names.map((n) => {
          const b = brandByName(n);
          const ps = groups.get(n).sort((a, b) => (a.printName || "").localeCompare(b.printName || ""));
          return `
          <div class="brand-head"><h2>${esc(n)}</h2>${b?.currentSize ? `<span class="chip">Wears ${esc(b.currentSize)}</span>` : ""}</div>
          <div class="grid">
            ${ps.map((p) => tile(p, "edit-print", (p.favorite ? "★ " : "") + (p.printName || "Untitled print"), p.types || [])).join("")}
          </div>`;
        }).join("")
      : `<div class="empty">No clothes listed yet.</div>`}`;
}

function favoritesView(prints) {
  const favPrints = prints.filter((p) => p.favorite).sort((a, b) => (a.printName || "").localeCompare(b.printName || ""));
  const favStyles = S.data.favoriteStyles || [];
  if (!favPrints.length && !favStyles.length) {
    return owner()
      ? `<div class="favs empty-favs"><b>Her favorites</b><span class="muted">Tap a print and turn on ★ Favorite print, or </span><button class="link" data-act="edit-favstyles">pick favorite styles</button></div>`
      : "";
  }
  const hasStyle = (style) => prints.filter((p) => (p.types || []).some((t) => t.toLowerCase() === style.toLowerCase()));
  return `
    <section class="favs" aria-label="Her favorites">
      <div class="favs-head"><h2>★ Her favorites</h2>${owner() ? `<button class="link" data-act="edit-favstyles">Edit styles</button>` : ""}</div>
      <p class="muted">Great gift ideas: a new style in a print she loves, or a style she loves in a print she doesn't have yet.</p>
      ${favPrints.map((p) => `
        <div class="fav-row">
          ${img(p.image, "fav-thumb", p.printName)}
          <div>
            <strong>${esc(p.printName || "Untitled print")}</strong>${p.brand ? `<span class="muted"> · ${esc(p.brand)}</span>` : ""}
            <div class="fav-line">${(p.types || []).length ? `Has it as ${esc(p.types.join(", "))}. Any other style is welcome!` : "Any style in this print is welcome!"}</div>
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
     <p class="muted">Styles she loves. Gifters will see which prints she already has in each one.</p>
     <div class="type-picker" role="group" aria-label="Favorite styles">
       ${[...new Set([...current, ...TYPES])].map((t) => `<button type="button" class="type-opt" aria-pressed="${current.includes(t)}" data-type="${esc(t)}">${esc(t)}</button>`).join("")}
     </div>
     <div class="err sheet-err" hidden></div>
     <div class="sheet-actions"><span class="spacer"></span><button class="btn ghost" data-act="cancel">Cancel</button><button class="btn" data-act="save">Save</button></div>`,
    (el) => {
      el.querySelectorAll(".type-opt").forEach((b) => b.addEventListener("click", () => {
        const on = b.getAttribute("aria-pressed") !== "true";
        if (on && el.querySelectorAll('.type-opt[aria-pressed="true"]').length >= 8) return toast("Up to 8 favorite styles");
        b.setAttribute("aria-pressed", on);
      }));
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
  const inner = `${img(rec.image, "", title)}<span>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}${pills.length ? `<b class="pills">${pills.map((t) => `<i class="pill">${esc(t)}</i>`).join("")}</b>` : ""}</span>`;
  return owner()
    ? `<button class="print editable" data-act="${editAct}" data-id="${rec.id}">${inner}</button>`
    : `<div class="print">${inner}</div>`;
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
    <div class="section-title"><h2>Her colors</h2></div>
    <div class="swatches">
      ${CONFIG.palette.map((c) => `<div class="swatch"><i style="background:${esc(c.hex)}"></i>${esc(c.name)}</div>`).join("")}
    </div>`;
}

// ── sheets (add / edit) ──────────────────────────────────────────────
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
  let armedAt = 0;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    if (Date.now() - armedAt > 3000) {
      armedAt = Date.now(); btn.textContent = "Tap again to delete";
      setTimeout(() => { if (!btn.disabled) btn.textContent = "Delete"; }, 3000);
      return;
    }
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
      <label class="f" for="f-type">Type</label>
      <select class="in" id="f-type" name="type"><option value="">Choose…</option>${opts(TYPES, cat === "clothes" ? e.type : "")}</select>
    </div>
    <div data-show="wt ct">
      <label class="f" for="f-toytype">Kind of toy</label>
      <select class="in" id="f-toytype" name="toyType"><option value="">Choose…</option>${opts(TOY_TYPES, cat === "toy" ? e.type : "")}</select>
    </div>
    <div data-show="wo co">
      <label class="f" for="f-othertype">What kind</label>
      <select class="in" id="f-othertype" name="otherType"><option value="">Choose…</option>${opts(OTHER_TYPES, cat === "other" ? e.type : "")}</select>
    </div>
    <div data-show="cc">
      <label class="check"><input type="checkbox" id="f-fav" name="favorite" ${e.favorite ? "checked" : ""}> ★ Favorite print</label>
      <label class="f">Styles she has in this print</label>
      <div class="type-picker" role="group" aria-label="Styles she has">
        ${[...new Set([...(e.types || []), ...TYPES])].map((t) => `<button type="button" class="type-opt" aria-pressed="${(e.types || []).includes(t)}" data-type="${esc(t)}">${esc(t)}</button>`).join("")}
      </div>
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
    el.querySelectorAll(".type-opt").forEach((b) => b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      if (on && el.querySelectorAll('.type-opt[aria-pressed="true"]').length >= 8) return toast("Up to 8 styles per print");
      b.setAttribute("aria-pressed", on);
    }));
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
        await store.upsertPrint({ ...common, printName: v("printName"), types, favorite: f("favorite").checked });
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

// ── events (one delegated listener, attached once) ───────────────────
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
