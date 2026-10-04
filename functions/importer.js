// Link import: reads a public product page and returns prefill details.
// Owner-only (enforced by the caller in index.js). Bounded: 9 s timeout,
// 3 MB max page, at most 2 outbound fetches per call, public hosts only.

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAX_BYTES = 3_000_000;

// ── safety: only public http(s) pages ───────────────────────────────
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw httpError(400, "That doesn't look like a link."); }
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, "Only web links work here.");
  const h = u.hostname.toLowerCase();
  const privateHost =
    h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal" ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(":") || /^\d+$/.test(h);
  if (privateHost) throw httpError(400, "That link isn't a public store page.");
  return u;
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

async function get(url, accept, { keepStatus = false, timeoutMs = 9000, method = "GET" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", signal: ctrl.signal });
    if (method === "HEAD") { checkUrl(res.url || url); return { status: res.status, type: res.headers?.get?.("content-type") || "" }; }
    checkUrl(res.url); // don't follow redirects into private addresses
    if (!res.ok) return keepStatus ? { status: res.status } : null;
    const buf = await res.arrayBuffer();
    return { text: Buffer.from(buf.slice(0, MAX_BYTES)).toString("utf8"), finalUrl: res.url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── parsing ─────────────────────────────────────────────────────────
const decode = (s) =>
  String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();

const absolute = (src, base) => { try { return src ? new URL(src, base).href : ""; } catch { return ""; } };

function money(amount, currency = "USD") {
  const n = Number(amount);
  if (!isFinite(n) || n <= 0) return "";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); }
  catch { return `$${n}`; }
}

// "Zip Romper in Strawberry Fields" → print "Strawberry Fields"
function printFromTitle(title) {
  const parts = String(title || "").split(/\s(?:in|–|—|-)\s+/i);
  const last = parts.length > 1 ? parts[parts.length - 1].trim() : "";
  return last.length >= 2 && last.length <= 40 ? last : "";
}

function stripSiteSuffix(title, site) {
  if (!title) return "";
  let t = title;
  if (site) t = t.replace(new RegExp(`\\s*[|–—:-]\\s*${site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "");
  return t.trim();
}

function parseShopify(json, base) {
  const p = JSON.parse(json);
  if (!p || !p.title) return null;
  const opts = (p.options || []).map((o) => (typeof o === "string" ? { name: o, values: [] } : o));
  const sizeOpt = opts.find((o) => /size|age/i.test(o.name || ""));
  const printOpt = opts.find((o) => /print|color|colour|pattern|style/i.test(o.name || ""));
  const priceCents = Number(p.price ?? p.price_min);
  const image = p.featured_image || (p.images && p.images[0]) || "";
  return {
    title: decode(p.title),
    brand: decode(p.vendor || ""),
    printName: printOpt && printOpt.values?.length === 1 ? decode(printOpt.values[0]) : printFromTitle(decode(p.title)),
    price: isFinite(priceCents) && priceCents > 0 ? money(priceCents / 100) : "",
    image: absolute(typeof image === "string" ? image : image.src, base),
    sizes: sizeOpt ? (sizeOpt.values || []).map(decode) : [],
    available: typeof p.available === "boolean" ? p.available : null,
  };
}

function parseHtml(html, base) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const val = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && val != null && !(key in meta)) meta[key] = decode(val);
  }

  let product = null;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const found = findProduct(JSON.parse(m[1].trim()));
      if (found) { product = found; break; }
    } catch { /* some sites ship invalid JSON-LD */ }
  }

  const site = meta["og:site_name"] || "";
  const ldImage = product && (Array.isArray(product.image) ? product.image[0] : product.image);
  const offers = product && (Array.isArray(product.offers) ? product.offers[0] : product.offers);
  const ldBrand = product && (typeof product.brand === "string" ? product.brand : product.brand?.name);
  const titleTag = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "");
  const title = stripSiteSuffix(decode(product?.name) || meta["og:title"] || meta["twitter:title"] || titleTag, site);

  const amount = offers?.price ?? offers?.lowPrice ?? meta["product:price:amount"] ?? meta["og:price:amount"];
  const currency = offers?.priceCurrency || meta["product:price:currency"] || meta["og:price:currency"] || "USD";

  return {
    title,
    brand: decode(ldBrand || meta["product:brand"] || meta["og:brand"] || site),
    printName: decode(product?.color || "") || printFromTitle(title),
    price: money(amount, currency),
    image: absolute(typeof ldImage === "string" ? ldImage : ldImage?.url || meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"], base),
    sizes: [],
    available: availability(offers),
  };
}

// schema.org availability → true / false / null (unknown)
function availability(offers) {
  const a = String(offers?.availability || "");
  if (/InStock|LimitedAvailability|OnlineOnly|PreOrder|BackOrder/i.test(a)) return true;
  if (/OutOfStock|SoldOut|Discontinued/i.test(a)) return false;
  return null;
}

function findProduct(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findProduct(n); if (f) return f; } return null; }
  const type = [].concat(node["@type"] || []).join(",");
  if (/\bProduct\b/i.test(type)) return node;
  if (/ProductGroup/i.test(type)) return { ...node, ...(node.hasVariant?.[0] || {}), name: node.name, brand: node.brand };
  return findProduct(node["@graph"]) || null;
}

async function importLink(rawUrl) {
  const u = checkUrl(rawUrl);
  const base = u.href;

  const shop = /^(.*\/products\/[^/?#]+)/.exec(u.origin + u.pathname)?.[1];
  if (shop) {
    const r = await get(`${shop}.js`, "application/json");
    if (r) { try { const p = parseShopify(r.text, base); if (p) return { url: base, ...p }; } catch { /* not Shopify */ } }
  }

  const page = await get(base, "text/html,application/xhtml+xml", { keepStatus: true });
  if (page?.text) {
    const live = parseHtml(page.text, page.finalUrl || base);
    if (live.title || live.image) return { url: base, ...live };
  }
  // Page gone (retired print) or unreadable: try a saved copy from the Internet Archive.
  const archived = await fromWayback(base);
  if (archived) return { url: base, ...archived, fromArchive: true };
  if (!page?.text) throw httpError(422, "That page is gone and no saved copy was found. Fill in the details by hand.");
  return { url: base, ...parseHtml(page.text, page.finalUrl || base) };
}

// ── Wayback Machine fallback ────────────────────────────────────────
// Looks up the newest saved copy of a product page and reads its photo and details.
// Uses the original photo address if it still loads (store image servers often keep
// retired photos); otherwise the archive's own copy of the photo.
const WAYBACK_HOST = "web.archive.org";
async function fromWayback(pageUrl) {
  const clean = pageUrl.split(/[?#]/)[0];
  const api = await get(`https://archive.org/wayback/available?url=${encodeURIComponent(clean)}`, "application/json", { timeoutMs: 7000 });
  let snap;
  try { snap = JSON.parse(api?.text || "{}")?.archived_snapshots?.closest; } catch { return null; }
  if (!snap?.available || !snap.url || !/^2\d\d$/.test(String(snap.status || "200"))) return null;
  let su;
  try { su = new URL(snap.url.replace(/^http:/, "https:")); } catch { return null; }
  if (su.hostname !== WAYBACK_HOST) return null;
  const m = /^\/web\/(\d{4,14})[a-z_]*\/(.+)$/.exec(su.pathname + su.search);
  if (!m) return null;
  const [, ts, original] = m;
  // "id_" asks for the page exactly as saved, without the archive's banner.
  const page = await get(`https://${WAYBACK_HOST}/web/${ts}id_/${original}`, "text/html,application/xhtml+xml", { timeoutMs: 9000 });
  if (!page?.text) return null;
  const p = parseHtml(page.text, original);
  if (!p.image && !p.title) return null;
  if (p.image) {
    const head = await get(p.image, "image/*", { method: "HEAD", timeoutMs: 5000 });
    if (!(head && head.status < 400 && /^image\//.test(head.type))) p.image = `https://${WAYBACK_HOST}/web/${ts}im_/${p.image}`;
  }
  p.available = false; // an archived page says nothing about today's stock
  return p;
}

// Size → age in months, for comparing sizes across brands ("6-12M" → 6, "2T" → 24).
// null means "can't tell" (One Size, S/M/L…), which counts as fitting.
function sizeRank(raw) {
  const s = String(raw || "").toLowerCase().replace(/[–—]/g, "-");
  if (/preemie|premature/.test(s)) return -2;
  if (/newborn|\bnb\b|0-1m|up to 7/.test(s)) return -1;
  let m = /(\d+(?:\.\d+)?)\s*(?:-\s*\d+(?:\.\d+)?\s*)?(?:m|mo|mos|month|months)\b/.exec(s);
  if (m) return Number(m[1]);
  m = /(\d+)\s*(?:-\s*\d+\s*)?(?:t|y|yr|yrs|year|years)\b/.exec(s);
  if (m) return Number(m[1]) * 12;
  return null;
}
// Available in this size or bigger? Unknown sizes count as fitting.
const fits = (size, minRank) => minRank == null || sizeRank(size) == null || sizeRank(size) >= minRank;

function shopifyInStock(p, minRank) {
  const opts = (p.options || []).map((o) => (typeof o === "string" ? o : o.name || ""));
  const sizeIdx = opts.findIndex((n) => /size|age/i.test(n));
  const variants = Array.isArray(p.variants) ? p.variants : [];
  if (sizeIdx < 0 || !variants.length || minRank == null) return typeof p.available === "boolean" ? p.available : null;
  return variants.some((v) => v.available && fits(v[`option${sizeIdx + 1}`] ?? v.options?.[sizeIdx], minRank));
}

function ldInStock(html, minRank) {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let product;
    try { product = findProduct(JSON.parse(m[1].trim())); } catch { continue; }
    if (!product) continue;
    const variants = Array.isArray(product.hasVariant) ? product.hasVariant : [product];
    const offers = variants.flatMap((v) => [].concat(v.offers || []).map((o) => ({ o, size: v.size || v.name || o.name || "" })));
    if (!offers.length) return null;
    const known = offers.filter(({ o }) => availability(o) !== null);
    if (!known.length) return null;
    return known.some(({ o, size }) => availability(o) && fits(size, minRank));
  }
  return null;
}

// Is this product still for sale in her size or bigger?
// "in", "out" (every size from minSize up is sold out, or the page is gone) or "unknown".
async function checkStock(rawUrl, minSize = "") {
  const minRank = sizeRank(minSize);
  let u;
  try { u = checkUrl(rawUrl); } catch { return "unknown"; }
  const shop = /^(.*\/products\/[^/?#]+)/.exec(u.origin + u.pathname)?.[1];
  if (shop) {
    const r = await get(`${shop}.js`, "application/json", { keepStatus: true });
    if (r?.status === 404) return "out";
    if (r?.text) {
      try { const ok = shopifyInStock(JSON.parse(r.text), minRank); if (ok === true) return "in"; if (ok === false) return "out"; } catch { /* not Shopify */ }
    }
  }
  const page = await get(u.href, "text/html,application/xhtml+xml", { keepStatus: true });
  if (page?.status === 404 || page?.status === 410) return "out";
  if (!page?.text) return "unknown";
  const a = ldInStock(page.text, minRank);
  return a === true ? "in" : a === false ? "out" : "unknown";
}

module.exports = { fromWayback, sizeRank, shopifyInStock, checkStock, availability, importLink, parseShopify, parseHtml, printFromTitle, checkUrl, httpError };
