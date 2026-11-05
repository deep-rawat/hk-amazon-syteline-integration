// Demo "Amazon" for the HubKor SyteLine integration.
//  - /            home, buyer storefront (/buyer) and seller dashboard (/seller)
//  - /api/*       used by those pages
//  - /orders/2026-01-01/orders   SP-API-shaped endpoint the SyteLine connector polls
// Zero dependencies: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 9100;
const DATA = path.join(__dirname, 'orders.json');
const PUBLIC = path.join(__dirname, 'public');

// SKUs that exist as items in SyteLine, so the connector can resolve them.
const PRODUCTS = [
  { sku: 'DEMO-001', name: 'Demo Widget Blue', price: 49.99, was: 64.99, emoji: '🔵', color: '#2f6fd6', rating: 4.6, reviews: 2381, category: 'Widgets', badge: 'Best Seller',
    blurb: 'Our bestselling widget in classic blue.',
    bullets: ['Durable all-weather build', 'Works with every Demo accessory', 'Ships from the seller warehouse', '1-year limited warranty'] },
  { sku: 'DEMO-002', name: 'Demo Widget Red', price: 49.99, was: 59.99, emoji: '🔴', color: '#d63a2f', rating: 4.4, reviews: 1187, category: 'Widgets', badge: '',
    blurb: 'Same great widget, bolder colour.',
    bullets: ['Same specs as the blue model', 'Fade-resistant finish', 'Ships from the seller warehouse', '1-year limited warranty'] },
  { sku: 'DEMO-003', name: 'Demo Gadget', price: 24.5, was: 29.99, emoji: '⚙️', color: '#3d8f5a', rating: 4.8, reviews: 5420, category: 'Gadgets', badge: 'Deal of the Day',
    blurb: 'Compact gadget for everyday use.',
    bullets: ['Pocket-sized and lightweight', 'Battery included', 'Ships from the seller warehouse', '30-day returns'] },
];

const load = () => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { return []; } };
const save = (o) => fs.writeFileSync(DATA, JSON.stringify(o, null, 2));
const rnd = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);

// Internal order -> Amazon Orders API v2026-01-01 shape (what AmazonSyncExt parses).
function toSpApi(o) {
  const shipped = o.status === 'Shipped';
  return {
    orderId: o.orderId,
    createdTime: o.createdTime,
    lastUpdatedTime: o.createdTime,
    salesChannel: { channelName: 'AMAZON', marketplaceId: 'ATVPDKIKX0DER', marketplaceName: 'Amazon.com' },
    proceeds: { grandTotal: { amount: money(o.total), currencyCode: 'USD' } },
    fulfillment: { fulfillmentStatus: shipped ? 'SHIPPED' : 'UNSHIPPED', fulfilledBy: 'MERCHANT' },
    recipient: { deliveryAddress: { name: o.buyer.name, addressLine1: o.buyer.address } },
    buyer: { buyerEmail: o.buyer.email, buyerName: o.buyer.name },
    orderItems: o.items.map((it, i) => ({
      orderItemId: o.orderId.replace(/-/g, '') + (i + 1),
      quantityOrdered: it.qty,
      product: { sellerSku: it.sku, title: it.name, price: { unitPrice: { amount: money(it.price), currencyCode: 'USD' } } },
      proceeds: { proceedsTotal: { amount: money(it.price * it.qty), currencyCode: 'USD' } },
      fulfillment: { quantityFulfilled: shipped ? it.qty : 0, quantityUnfulfilled: shipped ? 0 : it.qty },
    })),
  };
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { ok({}); } });
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  console.log(new Date().toISOString().slice(11, 19), req.method, req.url.slice(0, 120));
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (p === '/api/products') return send(res, 200, PRODUCTS);

  if (p === '/api/orders' && req.method === 'GET') return send(res, 200, load().slice().reverse());

  if (p === '/api/orders' && req.method === 'POST') {
    const b = await readBody(req);
    const items = (b.items || []).map((i) => {
      const prod = PRODUCTS.find((x) => x.sku === i.sku);
      return prod && i.qty > 0 ? { sku: prod.sku, name: prod.name, price: prod.price, qty: Math.floor(i.qty) } : null;
    }).filter(Boolean);
    if (!items.length || !b.name || !b.email) return send(res, 400, { error: 'Name, email and at least one item are required.' });
    const order = {
      orderId: '113-' + rnd(7) + '-' + rnd(7),
      createdTime: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      status: 'Unshipped',
      buyer: { name: String(b.name).slice(0, 80), email: String(b.email).slice(0, 120), address: String(b.address || '').slice(0, 200) },
      items,
      total: items.reduce((s, i) => s + i.price * i.qty, 0),
    };
    const all = load();
    all.push(order);
    save(all);
    return send(res, 201, order);
  }

  const one = p.match(/^\/api\/orders\/([\d-]+)$/);
  if (one && req.method === 'GET') {
    const o = load().find((x) => x.orderId === one[1]);
    return o ? send(res, 200, o) : send(res, 404, { error: 'Not found' });
  }

  const m = p.match(/^\/api\/orders\/([\d-]+)\/ship$/);
  if (m && req.method === 'POST') {
    const all = load();
    const o = all.find((x) => x.orderId === m[1]);
    if (!o) return send(res, 404, { error: 'Not found' });
    o.status = 'Shipped';
    save(all);
    return send(res, 200, o);
  }

  if (p === '/api/reset' && req.method === 'POST') { save([]); return send(res, 200, { ok: true }); }

  // --- SP-API look-alike used by SyteLine --------------------------------
  if (p === '/orders/2026-01-01/orders') {
    const after = Date.parse(url.searchParams.get('lastUpdatedAfter') || url.searchParams.get('createdAfter') || '') || 0;
    const all = load();
    const hits = all.filter((o) => Date.parse(o.createdTime) >= after);
    // Remember that SyteLine has pulled these, so the seller page can show a sync badge.
    const now = new Date().toISOString();
    hits.forEach((o) => { o.fetchedAt = o.fetchedAt || now; });
    if (hits.length) save(all);
    return send(res, 200, { orders: hits.map(toSpApi), pagination: {} });
  }
  if (p === '/auth/o2/token') return send(res, 200, { access_token: 'demo', token_type: 'bearer', expires_in: 3600 });

  // --- static pages --------------------------------------------------------
  const map = { '/': 'index.html', '/buyer': 'buyer.html', '/seller': 'seller.html' };
  const file = path.join(PUBLIC, map[p] || p.replace(/^\/+/, ''));
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile())
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  send(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log('Demo Amazon running on http://localhost:' + PORT + '  (buyer: /buyer, seller: /seller)'));
