// Find Photos: search for a product photo by brand + print/product name.
//   1. Shopify stores: the store's own product search (/search/suggest.json).
//   2. Fallback: Brave Search API (key in Secret Manager → env BRAVE_API_KEY), preferring
//      the brand's own website, then the og:image of each result page.
// Returns choices only; nothing is saved until the owner picks one (setPhoto).
// Every fetch goes through importer.get / importLink, which refuse private addresses.
const { get, importLink } = require("./importer");
const { brandKey } = require("./logic");

// Brand → store website. Matched by brandKey ("Kyte Baby Co" = "Kyte Baby"). A brand's own
// "Store website" field overrides this. Checked Oct 2026: all the stores below are Shopify
// (Little One Shop confirmed from its order emails: Shop Pay + Judge.me). A store that stops
// answering the Shopify search just falls through to web search.
const STORE_SITES = {
  "little sleepies": "littlesleepies.com",
  "simple seed": "simpleseedbaby.com",
  "sleepy sloth": "thesleepysloth.com",
  "little one": "littleoneshop.com",
  "copper pearl": "copperpearl.com",
  "kyte": "kytebaby.com",
  "posh peanut": "poshpeanut.com",
  "bums and roses": "bumsandroses.com",
  "caden lane": "cadenlane.com",
  "magnetic me": "magneticme.com",
  "swimzip": "swimzip.com",
  "angel dear": "angeldear.com",
  "goumi": "goumikids.com",
  "quincy mae": "ryleeandcru.com",   // quincymae.com now redirects here (Rylee + Cru)
  "solly": "sollybaby.com",
  "jamie kay": "jamiekay.com",
  // Not Shopify: web search only, but knowing the site lets us prefer its results.
  "janie and jack": "janieandjack.com",
  "carters": "carters.com",
};
const MAX_CHOICES = 3;
const PAGE_DEADLINE_MS = 9000;

const words = (t) => String(t || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const https = (src, base) => { try { const u = new URL(src.startsWith("//") ? `https:${src}` : src, base); u.protocol = "https:"; return u.href; } catch { return ""; } };
const stripQuery = (href) => { try { const u = new URL(href); return u.origin + u.pathname; } catch { return href; } };
// How well a result title matches what we're looking for: share of the name's words it contains.
const score = (title, name) => { const want = words(name); if (!want.length) return 0; const have = new Set(words(title)); return want.filter((w) => have.has(w)).length / want.length; };

function siteFor(brand, override = "") {
  return (override || STORE_SITES[brandKey(brand)] || "").replace(/^www\./, "");
}

// Shopify's predictive search. Returns [] when the store isn't Shopify or nothing matched.
async function shopifySearch(host, query, deps = { get }) {
  const u = `https://${host}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=8`;
  let r;
  try { r = await deps.get(u, "application/json"); } catch { return []; }
  if (!r?.text) return [];
  let products;
  try { products = JSON.parse(r.text)?.resources?.results?.products; } catch { return []; }
  if (!Array.isArray(products)) return [];
  const origin = `https://${new URL(r.finalUrl || u).hostname}`;
  return products.map((p) => {
    const image = https(typeof p.image === "string" ? p.image : p.featured_image?.url || p.image?.url || "", origin);
    return { title: String(p.title || "").slice(0, 120), url: stripQuery(https(p.url || "", origin)), image, source: "store" };
  }).filter((c) => c.image && c.url);
}

// Brave web search → result pages, the brand's own site first.
async function webSearch(query, site, key, deps = { get: braveGet }) {
  if (!key) return { pages: [], configured: false };
  const data = await Promise.resolve().then(() => deps.get(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&country=us&safesearch=strict`, key)).catch(() => null);
  const results = Array.isArray(data?.web?.results) ? data.web.results : [];
  const onSite = (h) => !!site && (h === site || h.endsWith(`.${site}`));
  const pages = results
    .map((x) => { try { const u = new URL(x.url); return { url: u.href, host: u.hostname.replace(/^www\./, ""), title: String(x.title || "") }; } catch { return null; } })
    .filter(Boolean)
    .filter((x) => !/(pinterest|facebook|instagram|tiktok|reddit|youtube)\./.test(x.host))
    .sort((a, b) => onSite(b.host) - onSite(a.host));
  return { pages, configured: true };
}
async function braveGet(u, key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PAGE_DEADLINE_MS);
  try {
    const res = await fetch(u, { headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: ctrl.signal });
    if (!res.ok) { console.warn(`brave search: HTTP ${res.status}`); return null; }
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// og:image (or product JSON) of a page, with a deadline so one slow site can't stall the request.
async function pagePhoto(pageUrl, deps = { importLink }) {
  const deadline = new Promise((res) => setTimeout(() => res(null), PAGE_DEADLINE_MS));
  try {
    const p = await Promise.race([deps.importLink(pageUrl), deadline]);
    return p?.image ? { title: String(p.title || "").slice(0, 120), url: stripQuery(pageUrl), image: https(p.image, pageUrl), source: "web" } : null;
  } catch { return null; }
}

// Main entry. rec: { brand, name, url? }. Returns { choices: [...≤3], searched: [...], webConfigured }.
async function findPhotoChoices({ brand, name, url = "", site = "" }, { key = "", deps = {} } = {}) {
  const d = { get, importLink, braveGet, ...deps };
  const choices = [];
  const seen = new Set();
  const add = (c) => { if (!c || !c.image) return; const k = stripQuery(c.image); if (seen.has(k) || choices.length >= MAX_CHOICES) return; seen.add(k); choices.push(c); };
  const searched = [];
  const host = siteFor(brand, site);

  // 0. The record's own product link, if it has one.
  if (url) add(await pagePhoto(url, { importLink: d.importLink }));

  // 1. The brand's Shopify store.
  if (host && name && choices.length < MAX_CHOICES) {
    searched.push("store");
    const hits = await shopifySearch(host, name, { get: d.get });
    hits.sort((a, b) => score(b.title, name) - score(a.title, name)).forEach(add);
  }

  // 2. Web search, only if we still have nothing.
  let webConfigured = true;
  if (!choices.length && (brand || name)) {
    const query = [brand, name].filter(Boolean).join(" ");
    const { pages, configured } = await webSearch(query, host, key, { get: d.braveGet });
    webConfigured = configured;
    if (configured) {
      searched.push("web");
      const found = await Promise.all(pages.slice(0, 4).map((p) => pagePhoto(p.url, { importLink: d.importLink })));
      found.forEach(add);
    }
  }
  return { choices, searched, webConfigured };
}

module.exports = { findPhotoChoices, shopifySearch, webSearch, siteFor, STORE_SITES, score };
