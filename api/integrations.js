// /api/integrations — per-client integrations config.
//   'integration' record  = client-level: Slack webhook (fallback) + EOD-to-Slack toggle, keyed by `key`
//                           (TakeOver client = "tsa:<name>", independent account = its ws id).
//   'webhook' record       = a NAMED inbound source (e.g. "New Fanbasis Sale"): {id, key, ws, client, name,
//                           slackWebhook, template, enabled, token}. Multiple per client. The token drives /api/hook.
//   'hooklog' record       = a received raw payload for a webhook (so we can see the real format + tune the template).
// Slack URLs are secret: stored server-side, never returned (only hasSlack + masked tail). Admin-only.
import crypto from 'crypto';
const DEFAULT_WS = 'tsa';
const DEFAULT_TEMPLATE = '💰 *{{name}}* {{amountFmt}}\nCustomer: {{customer}}\nProduct: {{product}}';
function verifySession(token) {
  try {
    const secret = process.env.SESSION_SECRET || 'tsa-session';
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const exp = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (mac.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
async function supa(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.SUPABASE_URL || !key) return null;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { ...(opts || {}), headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
async function wsForUser(username) {
  if (!username) return DEFAULT_WS;
  const r = await supa(`records?select=data&type=eq.wsmember&data->>username=ilike.${encodeURIComponent(username)}&order=submitted_at.desc&limit=1`);
  if (!r || !r.ok) return DEFAULT_WS;
  const rows = await r.json();
  return (rows[0] && rows[0].data && rows[0].data.ws) || DEFAULT_WS;
}
async function allByType(type) {
  const map = {};
  const r = await supa(`records?select=data&type=eq.${type}&order=submitted_at.asc&limit=100000`);
  if (r && r.ok) (await r.json()).forEach(x => { const d = x.data; const id = (type === 'integration') ? d && d.key : d && d.id; if (id) map[id] = d; });
  return map;
}
const mask = url => { const s = String(url || ''); return s ? '…' + s.slice(-6) : ''; };
const baseUrl = req => (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;
const keepOr = (val, prev) => (val === '') ? '' : ((val && val !== '__keep__') ? String(val) : (prev || ''));
const pubCfg = d => ({ key: d.key, ws: d.ws, client: d.client || '', eodToSlack: !!d.eodToSlack,
  hasSlack: !!d.slackWebhook, slackTail: mask(d.slackWebhook),
  hasSetter: !!d.eodSetterSlack, setterTail: mask(d.eodSetterSlack),
  hasCloser: !!d.eodCloserSlack, closerTail: mask(d.eodCloserSlack),
  hasMgr: !!d.eodMgrSlack, mgrTail: mask(d.eodMgrSlack) });
const pubHook = (d, req) => ({ id: d.id, key: d.key, ws: d.ws, client: d.client || '', name: d.name || 'Webhook', processor: d.processor || 'generic', enabled: d.enabled !== false, template: d.template || DEFAULT_TEMPLATE, hasSlack: !!d.slackWebhook, slackTail: mask(d.slackWebhook), token: d.token, inbound: baseUrl(req) + '/api/hook?t=' + d.token });
async function postSlack(webhook, payload) {
  if (!webhook) return { ok: false, error: 'no Slack webhook set' };
  try { const r = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); return r.ok ? { ok: true } : { ok: false, error: 'slack ' + r.status + ' ' + (await r.text()).slice(0, 120) }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

export default async function handler(req, res) {
  const b = req.body || {}, q = req.query || {}, h = req.headers || {};
  const s = verifySession(b.token || q.token || h['x-session-token'] || '');
  let callerWs = null, isSuper = false;
  if (s) { if (s.role !== 'admin') return res.status(200).json({ ok: false, error: 'Admins only' }); callerWs = await wsForUser(s.username); isSuper = (callerWs === DEFAULT_WS); }
  else { const ap = b.adminPass || q.adminPass || h['x-admin-pass'] || ''; if (ap && (ap === process.env.ADMIN_PASS || ap === process.env.BOT_ADMIN_TOKEN)) { callerWs = DEFAULT_WS; isSuper = true; } }
  if (!callerWs) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, error: 'not-provisioned' });
  const action = q.action || b.action || 'get';
  const mayTouch = d => isSuper || (d && d.ws === callerWs);
  try {
    if (action === 'get') {
      const cfgs = await allByType('integration'), hooks = await allByType('webhook');
      const tpls = await allByType('template');
      return res.status(200).json({ ok: true, super: isSuper,
        configs: Object.values(cfgs).filter(mayTouch).map(pubCfg),
        webhooks: Object.values(hooks).filter(d => mayTouch(d) && !d.deleted).map(d => pubHook(d, req)),
        templates: Object.values(tpls).filter(t => !t.deleted).map(t => ({ id: t.id, name: t.name, processor: t.processor || '', body: t.body || '' })) });
    }
    // ---- global template library (reusable across all clients; Super Admin manages, everyone can apply) ----
    if (action === 'saveTemplate') {
      if (!isSuper) return res.status(200).json({ ok: false, error: 'Only TSA can edit the shared template library' });
      const tpls = await allByType('template'); const cur = (b.id && tpls[b.id]) || null;
      const now = new Date().toISOString();
      const rec = { id: (cur && cur.id) || crypto.randomUUID(), type: 'template', name: String(b.name || (cur && cur.name) || 'Template').slice(0, 60), processor: String(b.processor != null ? b.processor : (cur && cur.processor) || ''), body: String(b.body != null ? b.body : (cur && cur.body) || '').slice(0, 2000), deleted: false, updatedAt: now };
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: rec.id, type: 'template', submitted_at: now, data: rec }) });
      return res.status(200).json({ ok: true, template: { id: rec.id, name: rec.name, processor: rec.processor, body: rec.body } });
    }
    if (action === 'deleteTemplate') {
      if (!isSuper) return res.status(200).json({ ok: false, error: 'Only TSA can edit the shared template library' });
      const tpls = await allByType('template'); const cur = tpls[String(b.id || '')]; if (!cur) return res.status(200).json({ ok: false, error: 'not found' });
      const now = new Date().toISOString();
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: crypto.randomUUID(), type: 'template', submitted_at: now, data: Object.assign({}, cur, { deleted: true, updatedAt: now }) }) });
      return res.status(200).json({ ok: true });
    }
    // ---- client-level config: Slack fallback + EOD toggle ----
    if (action === 'save') {
      const key = String(b.key || '').trim(); if (!key) return res.status(200).json({ ok: false, error: 'key required' });
      const cfgs = await allByType('integration'); const cur = cfgs[key] || null;
      if (cur && !mayTouch(cur)) return res.status(200).json({ ok: false, error: 'not your client' });
      const ws = isSuper ? String(b.ws || (cur && cur.ws) || DEFAULT_WS) : callerWs;
      const now = new Date().toISOString();
      const rec = { id: crypto.randomUUID(), type: 'integration', key, ws, client: String(b.client != null ? b.client : (cur && cur.client) || ''),
        slackWebhook: keepOr(b.slackWebhook, cur && cur.slackWebhook),
        eodSetterSlack: keepOr(b.eodSetterSlack, cur && cur.eodSetterSlack),
        eodCloserSlack: keepOr(b.eodCloserSlack, cur && cur.eodCloserSlack),
        eodMgrSlack: keepOr(b.eodMgrSlack, cur && cur.eodMgrSlack),
        eodToSlack: b.eodToSlack != null ? !!b.eodToSlack : !!(cur && cur.eodToSlack), updatedAt: now };
      const r = await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: rec.id, type: 'integration', submitted_at: now, data: rec }) });
      if (!r || !r.ok) return res.status(200).json({ ok: false, error: 'db write failed' });
      return res.status(200).json({ ok: true, config: pubCfg(rec) });
    }
    // ---- named webhook sources ----
    if (action === 'saveWebhook') {
      const key = String(b.key || '').trim(); if (!key) return res.status(200).json({ ok: false, error: 'client required' });
      const hooks = await allByType('webhook'); const cur = (b.id && hooks[b.id]) || null;
      if (cur && !mayTouch(cur)) return res.status(200).json({ ok: false, error: 'not your webhook' });
      const ws = isSuper ? String(b.ws || (cur && cur.ws) || DEFAULT_WS) : callerWs;
      const now = new Date().toISOString();
      const rec = { id: (cur && cur.id) || crypto.randomUUID(), type: 'webhook', key, ws, client: String(b.client != null ? b.client : (cur && cur.client) || ''),
        name: String(b.name || (cur && cur.name) || 'New webhook').slice(0, 60),
        processor: String(b.processor != null ? b.processor : (cur && cur.processor) || 'generic'),
        template: (b.template != null) ? String(b.template).slice(0, 2000) : (cur && cur.template) || DEFAULT_TEMPLATE,
        slackWebhook: (b.slackWebhook && b.slackWebhook !== '__keep__') ? String(b.slackWebhook) : (b.slackWebhook === '' ? '' : (cur && cur.slackWebhook) || ''),
        enabled: b.enabled != null ? !!b.enabled : (cur ? cur.enabled !== false : true),
        token: (cur && cur.token) || crypto.randomBytes(16).toString('hex'), deleted: false, updatedAt: now };
      const r = await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: rec.id, type: 'webhook', submitted_at: now, data: rec }) });
      if (!r || !r.ok) return res.status(200).json({ ok: false, error: 'db write failed' });
      return res.status(200).json({ ok: true, webhook: pubHook(rec, req) });
    }
    if (action === 'deleteWebhook') {
      const hooks = await allByType('webhook'); const cur = hooks[String(b.id || '')];
      if (!cur || !mayTouch(cur)) return res.status(200).json({ ok: false, error: 'not found' });
      const now = new Date().toISOString();
      const rec = Object.assign({}, cur, { deleted: true, updatedAt: now });
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: crypto.randomUUID(), type: 'webhook', submitted_at: now, data: rec }) });
      return res.status(200).json({ ok: true });
    }
    if (action === 'testWebhook') {
      const hooks = await allByType('webhook'); const cur = hooks[String(b.id || '')];
      if (!cur || !mayTouch(cur)) return res.status(200).json({ ok: false, error: 'not found' });
      let dest = cur.slackWebhook;
      if (!dest) { const cfgs = await allByType('integration'); dest = (cfgs[cur.key] && cfgs[cur.key].slackWebhook) || ''; }
      if (!dest) return res.status(200).json({ ok: false, error: 'No Slack channel set (on this webhook or the client)' });
      const sample = { amount: 1500, amountFmt: '$1,500', customer: 'sample@customer.com', product: 'Sample Offer', currency: 'USD', event: 'test', client: cur.client || '', name: cur.name || 'Webhook', raw: { note: 'sample payload' } };
      const text = renderTemplate(cur.template || DEFAULT_TEMPLATE, sample) || (cur.name + ' (test)');
      return res.status(200).json(await postSlack(dest, { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: text } }, { type: 'context', elements: [{ type: 'mrkdwn', text: 'Sales HQ test · ' + (cur.name || '') }] }] }));
    }
    if (action === 'log') {
      const id = String(b.id || ''); if (!id) return res.status(200).json({ ok: false, error: 'id required' });
      const hooks = await allByType('webhook'); const cur = hooks[id];
      if (!cur || !mayTouch(cur)) return res.status(200).json({ ok: false, error: 'not found' });
      const r = await supa(`records?select=data&type=eq.hooklog&data->>webhookId=eq.${encodeURIComponent(id)}&order=submitted_at.desc&limit=20`);
      const rows = (r && r.ok) ? await r.json() : [];
      return res.status(200).json({ ok: true, log: rows.map(x => ({ at: x.data.at, payload: x.data.payload, parsed: x.data.parsed })) });
    }
    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e && e.message || e) }); }
}
// shared template renderer ({{amount}}, {{customer}}, {{raw.some.path}}, ...)
function getPath(obj, path) { let v = obj; for (const k of String(path).split('.')) { if (v && typeof v === 'object' && k in v) v = v[k]; else return ''; } return v == null ? '' : v; }
export function renderTemplate(tpl, ctx) {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
    if (k.startsWith('raw.')) { const v = getPath(ctx.raw || {}, k.slice(4)); return v === '' ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v); }
    if (k in ctx && ctx[k] != null) return String(ctx[k]);
    const v = getPath(ctx.raw || {}, k); return v === '' ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v);
  });
}
