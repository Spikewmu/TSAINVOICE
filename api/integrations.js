// /api/integrations — per-client integration config (payment webhook -> Slack, EOD -> Slack).
// Config lives in `records` as type 'integration', keyed by `key` (a TakeOver client = "tsa:<name>", an
// independent account = its workspace id). The Slack webhook URL is a secret: stored server-side, never
// returned to the browser (we return only hasSlack + a masked tail). The inbound token drives /api/hook.
// Admin-only (Super Admin for any client; an Account Admin for their own workspace). Env: SESSION_SECRET, SUPABASE_*.
import crypto from 'crypto';
const DEFAULT_WS = 'tsa';
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
// latest-wins map of every integration config, keyed by its `key`
async function allIntegrations() {
  const map = {};
  const r = await supa(`records?select=data&type=eq.integration&order=submitted_at.asc&limit=100000`);
  if (r && r.ok) (await r.json()).forEach(x => { const d = x.data; if (d && d.key) map[d.key] = d; });
  return map;
}
const mask = url => { const s = String(url || ''); return s ? '…' + s.slice(-6) : ''; };
const publicView = d => ({ key: d.key, ws: d.ws, client: d.client || '', payToSlack: d.payToSlack !== false, eodToSlack: !!d.eodToSlack, hasSlack: !!d.slackWebhook, slackTail: mask(d.slackWebhook), token: d.token });
const baseUrl = req => (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;
async function postSlack(webhook, payload) {
  if (!webhook) return { ok: false, error: 'no Slack webhook set' };
  try { const r = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); return r.ok ? { ok: true } : { ok: false, error: 'slack ' + r.status + ' ' + (await r.text()).slice(0, 120) }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

export default async function handler(req, res) {
  const b = req.body || {}, q = req.query || {}, h = req.headers || {};
  const s = verifySession(b.token || q.token || h['x-session-token'] || '');
  let callerWs = null, isSuper = false;
  if (s) { callerWs = await wsForUser(s.username); isSuper = (callerWs === DEFAULT_WS && s.role === 'admin'); if (s.role !== 'admin') return res.status(200).json({ ok: false, error: 'Admins only' }); }
  else { const ap = b.adminPass || q.adminPass || h['x-admin-pass'] || ''; if (ap && (ap === process.env.ADMIN_PASS || ap === process.env.BOT_ADMIN_TOKEN)) { callerWs = DEFAULT_WS; isSuper = true; } }
  if (!callerWs) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, error: 'not-provisioned' });
  const action = q.action || b.action || 'get';
  // an account admin may only touch their own workspace; the super admin may touch any client
  const mayTouch = d => isSuper || (d && d.ws === callerWs);
  try {
    if (action === 'get') {
      const all = await allIntegrations();
      const list = Object.values(all).filter(mayTouch).map(d => Object.assign(publicView(d), { inbound: baseUrl(req) + '/api/hook?t=' + d.token }));
      return res.status(200).json({ ok: true, integrations: list, super: isSuper });
    }
    if (action === 'save') {
      const key = String(b.key || '').trim();
      if (!key) return res.status(200).json({ ok: false, error: 'key required' });
      const all = await allIntegrations();
      const cur = all[key] || null;
      // determine the workspace this config belongs to: super can set it (from key/body); an account admin is forced to their own
      let ws = isSuper ? (String(b.ws || (cur && cur.ws) || DEFAULT_WS)) : callerWs;
      if (cur && !mayTouch(cur)) return res.status(200).json({ ok: false, error: 'not your client' });
      const now = new Date().toISOString();
      const rec = {
        id: crypto.randomUUID(), type: 'integration', key, ws, client: String(b.client != null ? b.client : (cur && cur.client) || ''),
        slackWebhook: (b.slackWebhook && b.slackWebhook !== '__keep__') ? String(b.slackWebhook) : (cur && cur.slackWebhook) || '',
        payToSlack: b.payToSlack != null ? !!b.payToSlack : (cur ? cur.payToSlack !== false : true),
        eodToSlack: b.eodToSlack != null ? !!b.eodToSlack : !!(cur && cur.eodToSlack),
        token: (cur && cur.token) || crypto.randomBytes(16).toString('hex'), updatedAt: now, ws_stamp: ws
      };
      // clear the Slack webhook if explicitly emptied
      if (b.slackWebhook === '') rec.slackWebhook = '';
      const r = await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: rec.id, type: 'integration', submitted_at: now, data: rec }) });
      if (!r || !r.ok) return res.status(200).json({ ok: false, error: 'db write failed' });
      return res.status(200).json({ ok: true, integration: Object.assign(publicView(rec), { inbound: baseUrl(req) + '/api/hook?t=' + rec.token }) });
    }
    if (action === 'test') {
      const key = String(b.key || '').trim();
      const all = await allIntegrations();
      const cur = all[key];
      if (!cur || !mayTouch(cur)) return res.status(200).json({ ok: false, error: 'config not found' });
      if (!cur.slackWebhook) return res.status(200).json({ ok: false, error: 'No Slack webhook set yet' });
      const r = await postSlack(cur.slackWebhook, { text: 'Sales HQ test message', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '✅ *Sales HQ is connected.*' + (cur.client ? ' Channel for *' + cur.client + '*.' : '') + '\nPayment and report alerts will post here.' } }] });
      return res.status(200).json(r);
    }
    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e && e.message || e) }); }
}
