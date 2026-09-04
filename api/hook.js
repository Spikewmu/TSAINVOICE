// /api/hook?t=<token> — inbound webhook for a NAMED source (e.g. "New Fanbasis Sale").
// Looks up the webhook by token, LOGS the raw payload (so we can see the real format), records a payment,
// and posts to Slack using that webhook's editable template. Public (token is the auth); always 200.
import crypto from 'crypto';
async function supa(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.SUPABASE_URL || !key) return null;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { ...(opts || {}), headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
async function rowByToken(type, token) {
  const r = await supa(`records?select=data&type=eq.${type}&data->>token=eq.${encodeURIComponent(token)}&order=submitted_at.desc&limit=1`);
  if (!r || !r.ok) return null; const rows = await r.json(); return (rows[0] && rows[0].data) || null;
}
async function clientSlack(key) { // fallback channel from the client-level integration config
  const r = await supa(`records?select=data&type=eq.integration&data->>key=eq.${encodeURIComponent(key)}&order=submitted_at.desc&limit=1`);
  if (!r || !r.ok) return ''; const rows = await r.json(); return (rows[0] && rows[0].data && rows[0].data.slackWebhook) || '';
}
function pick(obj, paths) { for (const p of paths) { let v = obj, ok = true; for (const k of p.split('.')) { if (v && typeof v === 'object' && k in v) v = v[k]; else { ok = false; break; } } if (ok && v != null && v !== '') return v; } return ''; }
function getPath(obj, path) { let v = obj; for (const k of String(path).split('.')) { if (v && typeof v === 'object' && k in v) v = v[k]; else return ''; } return v == null ? '' : v; }
function money(n) { const v = Number(n); if (!isFinite(v)) return String(n || ''); return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
// per-processor field maps (tune from the payload log once we see a real one). Each falls back to the generic paths.
const PROCESSORS = {
  whop: { amount: ['data.usd_total', 'data.total', 'data.subtotal', 'data.settlement_amount', 'data.amount_after_fees'], customer: ['data.user.email', 'data.user.name', 'data.user.username'], product: ['data.product.title', 'data.plan.title'], event: ['type', 'data.status'], cents: false }, // verified from a real payment.succeeded payload 9-4
  stripe: { amount: ['data.object.amount_total', 'data.object.amount', 'amount_total'], customer: ['data.object.customer_email', 'data.object.customer_details.email', 'customer_email'], product: ['data.object.description', 'line_items.0.description'], event: ['type'], cents: true },
  elective: { amount: ['amount', 'total', 'data.amount', 'data.total'], customer: ['customer_email', 'email', 'data.email', 'customer.email'], product: ['product', 'plan', 'data.product'], event: ['status', 'type', 'event'], cents: false },
  fanbasis: { amount: ['amount', 'total', 'price', 'data.amount'], customer: ['email', 'customer_email', 'data.email', 'customer.email', 'name'], product: ['product', 'plan', 'offer', 'data.product'], event: ['status', 'type', 'event'], cents: false },
  ghl: { amount: ['amount', 'total', 'data.amount'], customer: ['email', 'contact.email', 'data.email'], product: ['product', 'name', 'data.product'], event: ['type', 'event'], cents: false }
};
const GEN = {
  amount: ['amount', 'total', 'price', 'final_amount', 'amount_total', 'data.final_amount', 'data.amount', 'data.amount_total', 'data.total', 'data.object.amount_total', 'data.object.amount', 'payment.amount'],
  customer: ['customer', 'customer_email', 'email', 'buyer_email', 'data.user.email', 'data.email', 'data.customer_email', 'data.object.customer_email', 'user.email', 'name', 'data.user.username', 'customer_name', 'data.name'],
  product: ['product', 'plan', 'offer', 'product_name', 'data.product.title', 'data.product_name', 'data.plan.name', 'data.object.description', 'description'],
  event: ['action', 'type', 'event', 'event_type', 'data.status']
};
function parsePayment(processor, b) {
  b = b || {}; const m = PROCESSORS[processor] || null;
  const path = f => (m && m[f] ? m[f] : []).concat(GEN[f]);
  let amount = pick(b, path('amount'));
  const cents = m ? !!m.cents : (typeof amount === 'number' && amount > 1000 && Number.isInteger(amount) && /amount_total|cents|stripe/i.test(JSON.stringify(b)));
  if (typeof amount === 'number' && cents) amount = amount / 100;
  const currency = pick(b, ['currency', 'data.currency', 'data.object.currency', 'payment.currency']) || 'USD';
  const customer = pick(b, path('customer'));
  const product = pick(b, path('product'));
  const event = pick(b, path('event'));
  const amt = (typeof amount === 'number') ? amount : Number(String(amount).replace(/[^0-9.]/g, '')) || 0;
  return { amount: amt, currency, customer: String(customer || ''), product: String(product || ''), event: String(event || '') };
}
function renderTemplate(tpl, ctx) {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
    if (k.startsWith('raw.')) { const v = getPath(ctx.raw || {}, k.slice(4)); return v === '' ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v); }
    if (k in ctx && ctx[k] != null) return String(ctx[k]);
    const v = getPath(ctx.raw || {}, k); return v === '' ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v);
  });
}

export default async function handler(req, res) {
  try {
    const token = (req.query && req.query.t) || (req.body && req.body.t) || '';
    if (!token) return res.status(200).json({ ok: false, ignored: 'no token' });
    const hook = await rowByToken('webhook', token) || await rowByToken('integration', token); // webhook source, or legacy client config
    if (!hook) return res.status(200).json({ ok: false, ignored: 'unknown token' });
    const body = req.body || {};
    const now = new Date().toISOString();
    const p = parsePayment(hook.processor || 'generic', body);
    // 1) LOG the raw payload (truncated) so we can see the real format and tune the template
    if (hook.id) {
      const raw = (() => { try { return JSON.stringify(body).slice(0, 6000); } catch (e) { return ''; } })();
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: crypto.randomUUID(), type: 'hooklog', submitted_at: now, data: { id: crypto.randomUUID(), type: 'hooklog', webhookId: hook.id, ws: hook.ws, at: now, payload: raw, parsed: p } }) }).catch(() => { });
    }
    // 2) record the payment (ws + client stamped -> shows on the dashboard/data)
    const rec = { id: crypto.randomUUID(), type: 'payment', ws: hook.ws, client: hook.client || '', source: hook.name || 'webhook', amount: p.amount, currency: p.currency, customer: p.customer, product: p.product, event: p.event, at: now, submittedAt: now };
    await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: rec.id, type: 'payment', submitted_at: now, data: rec }) }).catch(() => { });
    // 3) post to Slack using this webhook's template
    if (hook.enabled !== false) {
      const dest = hook.slackWebhook || await clientSlack(hook.key);
      if (dest) {
        const ctx = { name: hook.name || 'Payment', amount: p.amount || '', amountFmt: p.amount ? money(p.amount) : '', currency: p.currency, event: p.event, client: hook.client || '', customer: p.customer, product: p.product, raw: body };
        const tpl = hook.template || '💰 *{{name}}* {{amountFmt}}\nCustomer: {{customer}}\nProduct: {{product}}';
        const text = renderTemplate(tpl, ctx).trim() || (hook.name || 'Payment received');
        await fetch(dest, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }) }).catch(() => { });
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e && e.message || e) }); }
}
