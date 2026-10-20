// Back-in-stock emails.
// After any stock check, items that are "in" and have a waiting list get one email per address.
// Each address is removed from the waiting list BEFORE the email goes out (in a transaction),
// so an alert can never repeat; a failed send is put back to retry on the next check (max 3 tries).
const crypto = require("crypto");

const SITE_URL = process.env.SITE_URL || "https://alyssamanse.github.io/MerrittsCloset/";
const FROM = process.env.ALERT_FROM || "Merritt's Closet <alerts@alerts.merrittjean.com>";
const MAX_TRIES = 3;
const SITE_TITLE = process.env.SITE_TITLE || "";           // e.g. "Luca's Wishlist"
const ACCENT = process.env.ALERT_ACCENT || "#8A5560";      // button / heading color

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeHttp = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };

// Items that are back in stock and have people waiting.
function dueItems(pub, priv) {
  return Object.entries(priv?.alerts || {})
    .filter(([iid, list]) => list.length && pub?.items?.[iid]?.stock === "in" && !pub.claims?.[iid]?.h)
    .map(([iid]) => iid);
}

function sizeText(item) {
  if (!item.size) return "";
  return item.sizeFlexible ? `${item.size} or bigger` : item.size;
}

function buildEmail(item, babyName = "Merritt") {
  const title = item.title || "An item";
  const size = sizeText(item);
  const itemLink = `${SITE_URL}#item-${item.id}`;
  const shop = safeHttp(item.url);
  const subject = `Back in stock: ${title}`;
  const text = [
    `Good news! ${title}${item.brand ? ` from ${item.brand}` : ""} is back in stock${size ? ` in ${size}` : ""}.`,
    "",
    `See it on ${babyName}'s wishlist: ${itemLink}`,
    shop ? `Go to the store: ${shop}` : "",
    "",
    `Tap "I'll get this" on the wishlist so nobody doubles up.`,
    "",
    "You asked to be told once. This is that one email, and your address has now been deleted.",
  ].filter((l, i, a) => l || a[i - 1]).join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#FBF7F2;font-family:Helvetica,Arial,sans-serif;color:#3A2E30">
  <div style="max-width:520px;margin:0 auto;padding:28px 22px">
    <p style="font-family:Georgia,serif;font-style:italic;font-size:22px;color:${ACCENT};margin:0 0 18px">${esc(SITE_TITLE || `${babyName}'s Closet`)}</p>
    <h1 style="font-size:20px;margin:0 0 10px">Back in stock${size ? ` in ${esc(size)}` : ""}</h1>
    <p style="font-size:16px;line-height:1.5;margin:0 0 18px"><b>${esc(title)}</b>${item.brand ? ` from ${esc(item.brand)}` : ""} is available again.</p>
    ${safeHttp(item.image) ? `<img src="${esc(item.image)}" alt="" width="200" style="display:block;width:200px;max-width:100%;border-radius:8px;margin:0 0 18px">` : ""}
    <p style="margin:0 0 10px"><a href="${esc(itemLink)}" style="display:inline-block;background:${ACCENT};color:#FFF8F2;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:6px">See it on the wishlist</a></p>
    ${shop ? `<p style="margin:0 0 18px"><a href="${esc(shop)}" style="color:${ACCENT}">Go to the store</a></p>` : ""}
    <p style="font-size:14px;color:#8B7F7A;line-height:1.5;margin:18px 0 0">Tap “I'll get this” on the wishlist so nobody doubles up.</p>
    <p style="font-size:12.5px;color:#8B7F7A;line-height:1.5;margin:22px 0 0;border-top:1px solid #E9DFD7;padding-top:14px">You asked to be told once when this came back. This is that one email, and your address has now been deleted. If you didn't ask for this, you can ignore it; you won't hear from us again.</p>
  </div></body></html>`;
  return { subject, text, html };
}

// Resend's email API. Returns true when accepted. The idempotency key stops a retried request
// from sending twice.
async function resendSend({ key, to, subject, text, html, idem }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idem },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
      signal: ctrl.signal,
    });
    if (!res.ok) console.warn(`alert email: HTTP ${res.status}`);
    return res.ok;
  } catch (e) { console.warn(`alert email: ${e.message}`); return false; } finally { clearTimeout(t); }
}

// Send every due alert. deps lets tests replace Firestore and email.
async function sendDueAlerts({ db, ref, privRef, key, babyName, send = resendSend }) {
  if (!key) return { sent: 0, skipped: "no email key" };
  // 1. Take the due addresses off their waiting lists (one transaction), remembering them.
  const batch = await db.runTransaction(async (tx) => {
    const [ps, pv] = [await tx.get(ref), await tx.get(privRef)];
    const pub = ps.exists ? ps.data() : null, priv = pv.exists ? pv.data() : null;
    const due = dueItems(pub, priv);
    if (!due.length) return [];
    const out = due.map((iid) => ({ item: { ...pub.items[iid], id: iid }, subs: priv.alerts[iid] }));
    const alerts = { ...priv.alerts };
    for (const iid of due) delete alerts[iid];
    tx.set(privRef, { ...priv, alerts });
    return out;
  }, { maxAttempts: 3 });
  if (!batch.length) return { sent: 0 };
  // 2. Send, one email per address (nobody sees anyone else's address).
  let sent = 0;
  const failed = {};
  for (const { item, subs } of batch) {
    const mail = buildEmail(item, babyName);
    for (const sub of subs) {
      const idem = crypto.createHash("sha256").update(`${item.id}|${sub.e}|${sub.at}`).digest("hex").slice(0, 40);
      if (await send({ key, to: sub.e, ...mail, idem })) sent++;
      else if ((sub.tries || 0) + 1 < MAX_TRIES) (failed[item.id] ||= []).push({ ...sub, tries: (sub.tries || 0) + 1 });
    }
  }
  // 3. Put failed sends back so the next check retries them.
  if (Object.keys(failed).length) {
    await db.runTransaction(async (tx) => {
      const pv = await tx.get(privRef);
      const priv = pv.exists ? pv.data() : { alerts: {} };
      const alerts = { ...(priv.alerts || {}) };
      for (const [iid, subs] of Object.entries(failed)) {
        const cur = alerts[iid] || [];
        alerts[iid] = [...cur, ...subs.filter((s) => !cur.some((c) => c.e === s.e))];
      }
      tx.set(privRef, { ...priv, alerts });
    }, { maxAttempts: 3 }).catch((e) => console.error("alert retry save failed", e));
  }
  return { sent, retrying: Object.values(failed).flat().length };
}

module.exports = { sendDueAlerts, buildEmail, dueItems, resendSend };
