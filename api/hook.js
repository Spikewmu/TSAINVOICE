// /api/hook — inbound payment webhook. A client pastes their unique URL (/api/hook?t=<token>) into their
// payment processor (Whop / Elective / Fanbasis / Stripe-like). We look up the client by token, record the
// payment (so it also lands on the dashboard), and post a formatted alert to their Slack channel.
// Public endpoint (the token IS the auth) — always returns 200 so processors don't retry-storm. Env: SUPABASE_*.
import crypto from 'crypto';
async function supa(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.SUPABASE_URL || !key) return null;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { ...(opts || {}), headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
async function findByToken(token) {
  if (!token) return null;
  const r = await supa(`records?select=data&type=eq.integration&data->>token=eq.${encodeURIComponent(token)}&order=submitted_at.desc&limit=1`);
  if (!r || !r.ok) return null;
  const rows = await r.json();
  return (rows[0] && rows[0].data) || null;
}
// dig a value out of a payload by trying several likely key paths (processors all differ)
function pick(obj, paths) {
  for (const p of paths) { let v = obj; let ok = true; for (const k of p.split('.')) { if (v && typeof v === 'object' && k in v) v = v[k]; else { ok = false; break; } } if (ok && v != null && v !== '') return v; }
  return '';
}
function money(n) { const v = Number(n); if (!isFinite(v)) return String(n || ''); return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
// best-effort normalize across Whop / Stripe-like / Elective / Fanbasis / generic shapes
function parsePayment(body) {
  const b = body || {};
  let amount = pick(b, ['amount', 'total', 'price', 'final_amount', 'amount_total', 'data.final_amount', 'data.amount', 'data.amount_total', 'data.total', 'data.object.amount_total', 'data.object.amount', 'payment.amount']);
  if (typeof amount === 'number' && amount > 1000 && Number.isInteger(amount) && /stripe|amount_total|cents/i.test(JSON.stringify(b))) amount = amount / 100; // cents -> dollars for stripe-like
  const currency = pick(b, ['currency', 'data.currency', 'data.object.currency', 'payment.currency']) || 'USD';
  const customer = pick(b, ['customer', 'customer_email', 'email', 'buyer_email', 'data.user.email', 'data.email', 'data.customer_email', 'data.object.customer_email', 'user.email', 'name', 'data.user.username', 'customer_name', 'data.name']);
  const product = pick(b, ['product', 'plan', 'offer', 'product_name', 'data.product.title', 'data.product_name', 'data.plan.name', 'line_items.0.description', 'data.object.description', 'description']);
  const event = pick(b, ['action', 'type', 'event', 'event_type', 'data.status']);
  return { amount, currency, customer, product, event };
}
const baseUrl = req => (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;

export default async function handler(req, res) {
  try {
    const token = (req.query && req.query.t) || (req.body && req.body.t) || '';
    const cfg = await findByToken(token);
    if (!cfg) return res.status(200).json({ ok: false, ignored: 'unknown token' }); // 200 so nobody probes for valid tokens
    const p = parsePayment(req.body || {});
    // record the payment (ws-scoped like everything else; shows on the dashboard/data)
    const now = new Date().toISOString();
    const rec = { id: crypto.randomUUID(), type: 'payment', ws: cfg.ws, client: cfg.client || '', amount: (typeof p.amount === 'number' ? p.amount : Number(String(p.amount).replace(/[^0-9.]/g, '')) || 0), currency: p.currency, customer: String(p.customer || ''), product: String(p.product || ''), event: String(p.event || ''), source: 'webhook', at: now, submittedAt: now };
    await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: rec.id, type: 'payment', submitted_at: now, data: rec }) });
    // post to Slack
    if (cfg.slackWebhook && cfg.payToSlack !== false) {
      const fields = [];
      if (rec.amount) fields.push({ type: 'mrkdwn', text: '*Amount:*\n' + money(rec.amount) + (rec.currency && rec.currency !== 'USD' ? ' ' + rec.currency : '') });
      if (rec.customer) fields.push({ type: 'mrkdwn', text: '*Customer:*\n' + rec.customer });
      if (rec.product) fields.push({ type: 'mrkdwn', text: '*Product:*\n' + rec.product });
      if (cfg.client) fields.push({ type: 'mrkdwn', text: '*Account:*\n' + cfg.client });
      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: '💰 Payment received' + (rec.amount ? ' · ' + money(rec.amount) : ''), emoji: true } },
        fields.length ? { type: 'section', fields: fields.slice(0, 10) } : { type: 'section', text: { type: 'mrkdwn', text: 'A payment came in.' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'via Sales HQ' + (rec.event ? ' · ' + rec.event : '') }] }
      ];
      await fetch(cfg.slackWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '💰 Payment received' + (rec.amount ? ' ' + money(rec.amount) : '') + (rec.customer ? ' from ' + rec.customer : ''), blocks }) }).catch(() => { });
    }
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e && e.message || e) }); }
}
