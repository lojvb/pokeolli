// Pokéolli Chekker — multi-shop voorraad-tracker
// Draait op GitHub Actions volgens een schema. Voor elk ingesteld product/trefwoord
// bepaalt hij voorraad + prijs, schrijft naar Firestore, en stuurt een melding
// zodra iets koopbaar wordt, een bewaakt product verschijnt, of een prijs onder
// je streefprijs zakt.

import fs from 'node:fs';
import admin from 'firebase-admin';

// ── Firebase-init (env-var op GitHub, of lokaal serviceAccount.json voor test) ──
let svc;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
    process.exit(1);
  }
} else if (fs.existsSync(new URL('./serviceAccount.json', import.meta.url))) {
  svc = JSON.parse(fs.readFileSync(new URL('./serviceAccount.json', import.meta.url)));
}
if (!svc || !svc.project_id) {
  console.error('No credentials. Set FIREBASE_SERVICE_ACCOUNT or add serviceAccount.json.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();

// ── Config laden + valideren ─────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)));

function validateConfig(cfg) {
  const errs = [];
  if (!cfg || !Array.isArray(cfg.products)) {
    errs.push('config.json: "products" ontbreekt of is geen lijst');
    return errs;
  }
  const ids = new Set();
  cfg.products.forEach((p, i) => {
    const w = `product #${i + 1}`;
    if (!p.id) errs.push(`${w}: "id" ontbreekt`);
    else if (ids.has(p.id)) errs.push(`${w}: dubbele id "${p.id}"`);
    else ids.add(p.id);
    if (!p.name) errs.push(`${w}: "name" ontbreekt`);
    if (!p.url) errs.push(`${w}: "url" ontbreekt`);
    if ((p.type || 'product') === 'keyword' && !p.keyword)
      errs.push(`${w}: keyword-watch zonder "keyword"`);
  });
  return errs;
}
const configErrors = validateConfig(config);
if (configErrors.length) {
  console.error('Config-fouten:\n - ' + configErrors.join('\n - '));
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SCRAPER_TEMPLATE = process.env.SCRAPER_URL_TEMPLATE || '';
const targetUrl = (url) =>
  !SCRAPER_TEMPLATE
    ? url
    : SCRAPER_TEMPLATE.includes('{url}')
    ? SCRAPER_TEMPLATE.replace('{url}', encodeURIComponent(url))
    : SCRAPER_TEMPLATE + encodeURIComponent(url);

const COOLDOWN_MS = (parseInt(process.env.NOTIFY_COOLDOWN_MIN || '30', 10) || 30) * 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Herkenningsprofielen per winkel (JSON-LD is primair; dit is de terugval) ──
const PROFILES = [
  { match: ['mediamarkt.'], shop: 'MediaMarkt', color: '#e2001a',
    in: ['Online op voorraad', 'Op voorraad'],
    out: ['Helaas geen bezorging mogelijk', 'Niet leverbaar', 'Uitverkocht', 'Tijdelijk niet beschikbaar'] },
  { match: ['bol.com'], shop: 'bol', color: '#0000ab',
    in: ['Op voorraad', 'Nu bestellen'],
    out: ['Niet leverbaar', 'Uitverkocht', 'Binnenkort weer leverbaar', 'Niet meer leverbaar'] },
  { match: ['amazon.'], shop: 'Amazon', color: '#ff9900',
    in: ['Op voorraad', 'In Stock', 'In voorraad'],
    out: ['Niet op voorraad', 'Currently unavailable', 'Tijdelijk niet op voorraad', 'Niet beschikbaar'] },
  { match: ['coolblue.'], shop: 'Coolblue', color: '#0090e3',
    in: ['Op voorraad'],
    out: ['Uitverkocht', 'Tijdelijk uitverkocht', 'Niet leverbaar'] },
  { match: ['intertoys.'], shop: 'Intertoys', color: '#e30613',
    in: ['Op voorraad', 'Leverbaar'],
    out: ['Uitverkocht', 'Niet leverbaar'] },
  { match: ['dreamland.'], shop: 'Dreamland', color: '#5cb85c',
    in: ['Vandaag besteld', 'Huidige levertijd', 'Snel in huis', 'Op voorraad'],
    out: ['Hou me op de hoogte', 'Weet als eerste als dit product op voorraad', 'niet altijd weer terug op voorraad', 'Uitverkocht', 'Niet beschikbaar'] },
  { match: ['fun.be'], shop: 'Fun', color: '#ffc20e',
    in: ['Op voorraad', 'Beschikbaar', 'Toevoegen aan winkelmandje'],
    out: ['Uitverkocht', 'Niet beschikbaar', 'Niet leverbaar'] },
];
// Generieke "je kan dit bestellen"-teksten, enkel als laatste redmiddel.
const CART_MARKERS = [
  'In winkelwagen', 'In winkelmandje', 'In het winkelmandje', 'In winkelmand',
  'Toevoegen aan winkelmandje', 'Voeg toe aan winkelmandje', 'Add to cart', 'Add to Basket',
];

function profileFor(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  for (const p of PROFILES) if (p.match.some((m) => host.includes(m))) return p;
  return {
    shop: host.replace(/^www\./, '') || 'onbekend', color: '#6f7aa0',
    in: ['Op voorraad', 'In Stock'],
    out: ['Uitverkocht', 'Niet leverbaar', 'Niet op voorraad', 'Currently unavailable'],
  };
}

// ── Ophalen (timeout + één nieuwe poging) ────────────────────────────────────
async function fetchHtml(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(targetUrl(url), {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
        },
        redirect: 'follow',
        signal: ctrl.signal,
      });
      const html = await res.text();
      clearTimeout(timer);
      return { status: res.status, html };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === 0) await sleep(1500);
    }
  }
  throw lastErr;
}

// ── Hulpfuncties voor parsing ────────────────────────────────────────────────
function parseJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try { out.push(JSON.parse(m[1].trim())); } catch {}
  }
  return out;
}
function collect(node, key, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const n of node) collect(n, key, acc); return acc; }
  if (key in node) acc.push(node);
  for (const v of Object.values(node)) if (v && typeof v === 'object') collect(v, key, acc);
  return acc;
}
function jsonLdAvailability(html) {
  const out = [];
  for (const root of parseJsonLd(html)) for (const n of collect(root, 'availability')) out.push(n.availability);
  return out;
}
// schema.org-microdata: <link itemprop="availability" href=".../InStock">
function microdataAvailability(html) {
  const out = [];
  for (const m of html.matchAll(/itemprop=["']availability["'][^>]*?(?:href|content)=["']([^"']+)["']/gi)) out.push(m[1]);
  for (const m of html.matchAll(/(?:href|content)=["']([^"']+)["'][^>]*?itemprop=["']availability["']/gi)) out.push(m[1]);
  return out;
}

function detectInStock(html, item, profile) {
  for (const a of [...jsonLdAvailability(html), ...microdataAvailability(html)]) {
    const s = String(a).toLowerCase();
    if (/instock|in_stock|limitedavailability|preorder|backorder|onlineonly/.test(s)) return true;
    if (/outofstock|soldout|discontinued/.test(s)) return false;
  }
  const outM = item.outOfStockText || profile.out;
  if (outM.some((s) => html.includes(s))) return false;
  const inM = (item.inStockText || profile.in).concat(CART_MARKERS);
  if (inM.some((s) => html.includes(s))) return true;
  return null;
}

function extractPrice(html) {
  for (const root of parseJsonLd(html)) {
    for (const n of collect(root, 'price')) {
      const val = parseFloat(String(n.price).replace(/[^\d.,]/g, '').replace(',', '.'));
      if (!isNaN(val) && val > 0) return { value: val, currency: n.priceCurrency || 'EUR' };
    }
  }
  const m = html.match(/property=["'](?:product:price:amount|og:price:amount)["'][^>]*content=["']([\d.,]+)["']/i);
  if (m) { const val = parseFloat(m[1].replace(',', '.')); if (!isNaN(val)) return { value: val, currency: 'EUR' }; }
  return null;
}

function detectKeyword(html, item) {
  const kws = Array.isArray(item.keyword) ? item.keyword : [item.keyword];
  const hay = html.toLowerCase();
  return kws.some((k) => hay.includes(String(k).toLowerCase()));
}
function looksBlocked(html, status) {
  if (status === 403 || status === 429) return true;
  return html.length < 15000 && /captcha|are you a human|access denied|akamai|bot detection/i.test(html);
}
function fmtPrice(p) {
  if (!p) return '';
  try { return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: p.currency }).format(p.value); }
  catch { return `${p.value} ${p.currency}`; }
}

// ── Meldingen ────────────────────────────────────────────────────────────────
async function notify(title, url) {
  const body = url ? `${title}\n${url}` : title;
  const tasks = [];
  if (process.env.NTFY_TOPIC) {
    const headers = { Title: title.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim() || 'Pokeolli Chekker', Tags: 'shopping_cart', Priority: 'high' };
    if (url) {
      headers.Click = url;
      headers.Actions = `view, Bekijk product, ${url}`;
    }
    tasks.push(fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, { method: 'POST', headers, body }));
  }
  if (process.env.DISCORD_WEBHOOK) {
    tasks.push(fetch(process.env.DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: body }),
    }));
  }
  if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    tasks.push(fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: body }),
    }));
  }
  if (!tasks.length) { console.log('  (geen meldingskanaal ingesteld)'); return; }
  const res = await Promise.allSettled(tasks);
  res.forEach((r, i) => r.status === 'rejected' && console.log(`  melding ${i} faalde:`, r.reason?.message));
}

// ── Hoofdlus ─────────────────────────────────────────────────────────────────
async function run() {
  // Snelle manier om te checken of je meldingen werken: draai de workflow met test=true.
  if (process.env.TEST_NOTIFICATION === 'true') {
    await notify('🔔 Test — Pokéolli Chekker werkt! Je meldingen zijn goed ingesteld.');
    console.log('Test-melding verstuurd.');
    return;
  }

  const now = admin.firestore.Timestamp.now();
  let okCount = 0, errCount = 0, hitCount = 0;
  for (const item of config.products) {
    const ref = db.collection('products').doc(item.id);
    const prev = (await ref.get()).data() || {};
    const type = item.type || 'product';
    const profile = profileFor(item.url);

    let ok = true, note = '', inStock = null, listed = null, price = null;

    try {
      const { status, html } = await fetchHtml(item.url);
      if (looksBlocked(html, status)) { ok = false; note = `mogelijk geblokkeerd (HTTP ${status})`; }
      else if (status >= 400) { ok = false; note = `HTTP ${status}`; }
      else if (type === 'keyword') { listed = detectKeyword(html, item); }
      else {
        inStock = detectInStock(html, item, profile);
        price = extractPrice(html);
        if (inStock === null) note = 'status onbekend (pas de detectie-teksten aan)';
      }
    } catch (e) {
      ok = false;
      note = e.name === 'AbortError' ? 'timeout' : e.message;
    }

    const update = {
      name: item.name, url: item.url, type,
      shop: item.shop || profile.shop, shopColor: profile.color,
      group: item.group || null,
      ok, note, lastChecked: now,
    };
    if (inStock !== null) update.inStock = inStock;
    if (inStock === true) update.lastInStock = now;
    if (listed !== null) update.listed = listed;
    if (price) {
      update.priceValue = price.value;
      update.currency = price.currency;
      update.prevPriceValue = prev.priceValue ?? null;
    }

    const becameInStock = type !== 'keyword' && inStock === true && prev.inStock !== true;
    const becameListed = type === 'keyword' && listed === true && prev.listed !== true;
    const target = item.targetPrice;
    const priceDrop =
      inStock === true && price && target &&
      price.value <= target && (prev.priceValue == null || prev.priceValue > target);

    if (becameInStock || becameListed || priceDrop) update.lastChanged = now;

    // Cooldown zodat een flapperende listing je niet kan spammen.
    const canNotify = !prev.lastNotified || now.toMillis() - prev.lastNotified.toMillis() > COOLDOWN_MS;

    await ref.set(update, { merge: true });
    console.log(
      `[${update.shop}] ${item.name}: ` +
        `${type === 'keyword' ? `listed=${listed}` : `inStock=${inStock}${price ? ' ' + fmtPrice(price) : ''}`}` +
        `${ok ? '' : ` (${note})`}`
    );
    if (ok) okCount++; else errCount++;
    if (becameInStock || becameListed || inStock === true || listed === true) hitCount++;

    if ((becameInStock || becameListed || priceDrop) && canNotify) {
      if (becameInStock) await notify(`🟢 OP VOORRAAD bij ${update.shop}: ${item.name}${price ? ` — ${fmtPrice(price)}` : ''}`, item.url);
      else if (becameListed) await notify(`🆕 VERSCHENEN bij ${update.shop}: ${item.name}`, item.url);
      else if (priceDrop) await notify(`💰 PRIJS ${fmtPrice(price)} (≤ streefprijs) bij ${update.shop}: ${item.name}`, item.url);
      await ref.set({ lastNotified: now }, { merge: true });
    }

    await sleep(700 + Math.random() * 1200);
  }

  await db.collection('meta').doc('run').set(
    { lastRun: now, okCount, errCount, total: config.products.length, hitCount },
    { merge: true }
  );
  console.log(`Klaar. ${okCount}/${config.products.length} ok, ${hitCount} beschikbaar.`);
}

run().catch((e) => { console.error(e); process.exit(1); });
