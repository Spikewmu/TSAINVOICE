// /api/data - workspace-scoped record reads (multi-tenant isolation).
//
// The app used to read the whole `records` table with the shared anon key - no wall between teams.
// This returns ONLY the caller's workspace (tenant) records, using the service key server-side.
// TSA (the first/default workspace) also sees legacy rows that predate workspaces (data.ws is null).
// Membership lives in `records` as type 'wsmember' ({ username, ws }); everyone defaults to 'tsa'.
//
// Once the client reads through this endpoint everywhere, lock the door: an RLS policy on `records`
// that blocks anon SELECT (see /db/records-rls.sql), so the shared key can't read cross-workspace.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SECRET.
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
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { ...(opts || {}), headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
async function wsForUser(username) {
  const r = await supa(`records?select=data&type=eq.wsmember&data->>username=ilike.${encodeURIComponent(username)}&order=submitted_at.desc&limit=1`);
  if (!r.ok) return DEFAULT_WS;
  const rows = await r.json();
  return (rows[0] && rows[0].data && rows[0].data.ws) || DEFAULT_WS;
}
// the integration config for a client (TakeOver client -> "tsa:<name>", independent account -> its ws id)
async function integrationFor(ws, client) {
  const key = (ws === DEFAULT_WS && client) ? 'tsa:' + client : ws;
  const r = await supa(`records?select=data&type=eq.integration&data->>key=eq.${encodeURIComponent(key)}&order=submitted_at.desc&limit=1`);
  if (!r || !r.ok) return null;
  const rows = await r.json();
  return (rows[0] && rows[0].data) || null;
}
// post a submitted End-of-Day (or Manager EOD) to the client's Slack channel, if that client turned EOD alerts on
async function eodToSlack(rec) {
  try {
    if (!rec || (rec.type !== 'eod' && rec.type !== 'mgreod')) return;
    const cfg = await integrationFor(rec.ws, rec.client);
    if (!cfg || !cfg.slackWebhook || !cfg.eodToSlack) return;
    const n = v => v || 0, who = rec.rep || rec.by || 'Someone';
    let line;
    if (rec.type === 'mgreod') line = `Setters ${n(rec.settersWorking)} · Closers ${n(rec.closersWorking)} · ${n(rec.closerCalls)} calls · $${n(rec.cash).toLocaleString('en-US')} cash`;
    else if ((rec.role || 'Closer') === 'Setter') line = `${n(rec.hoursDialing)}h · ${n(rec.newOutreach)} dials · ${n(rec.connectedCalls)} conn · ${n(rec.callsSet)} sets`;
    else line = `${n(rec.hoursDialing)}h · ${n(rec.connectedMeetings)} calls · ${n(rec.closedDeals)} deals · $${n(rec.cashCollected).toLocaleString('en-US')} cash`;
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `📝 *EOD · ${who}*${rec.role ? ' (' + rec.role + ')' : rec.type === 'mgreod' ? ' (Manager)' : ''}${rec.client ? ' · ' + rec.client : ''}\n${line}` } }
    ];
    if (rec.notes || rec.bottleneck) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '“' + String(rec.notes || rec.bottleneck).slice(0, 200) + '”' }] });
    await fetch(cfg.slackWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `EOD from ${who}${rec.client ? ' · ' + rec.client : ''}`, blocks }) });
  } catch (e) { /* never block the write on a Slack failure */ }
}

export default async function handler(req, res) {
  const h = req.headers || {}, b = req.body || {}, q = req.query || {};
  const s = verifySession(b.token || q.token || h['x-session-token'] || '');
  // Auth: a valid session token -> that user's workspace. Master admin pass (break-glass) -> TSA workspace.
  let callerWs = null;
  if (s) callerWs = await wsForUser(s.username);
  else {
    const ap = b.adminPass || q.adminPass || h['x-admin-pass'] || '';
    if (ap && (ap === process.env.ADMIN_PASS || ap === process.env.BOT_ADMIN_TOKEN)) callerWs = DEFAULT_WS;
  }
  if (!callerWs) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, error: 'not-provisioned' });
  const action = q.action || b.action || 'records';
  try {
    if (action === 'records') {
      const ws = callerWs;
      // TSA also gets legacy rows with no ws; other workspaces get strictly their own.
      const filter = ws === DEFAULT_WS
        ? `or=(data->>ws.eq.${DEFAULT_WS},data->>ws.is.null)`
        : `data->>ws=eq.${encodeURIComponent(ws)}`;
      const r = await supa(`records?select=data&order=id.asc&limit=100000&${filter}`);
      if (!r.ok) { const t = await r.text(); return res.status(200).json({ ok: false, error: 'db ' + r.status + ' ' + t.slice(0, 160) }); }
      const rows = await r.json();
      return res.status(200).json({ ok: true, ws, records: rows.map(x => x.data).filter(Boolean) });
    }
    if (action === 'write') {
      const rec = b.record || {};
      if (!rec || typeof rec !== 'object' || !rec.type) return res.status(200).json({ ok: false, error: 'record required' });
      rec.ws = callerWs; // server-authoritative workspace stamp - a client can never write into another workspace
      const row = { rid: rec.id || crypto.randomUUID(), type: rec.type, submitted_at: rec.submittedAt || new Date().toISOString(), data: rec };
      const r = await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      if (!r.ok) { const t = await r.text(); return res.status(200).json({ ok: false, error: 'db ' + r.status + ' ' + t.slice(0, 160) }); }
      if (rec.type === 'eod' || rec.type === 'mgreod') await eodToSlack(rec); // mirror the submitted report to the client's Slack, if enabled
      return res.status(200).json({ ok: true });
    }
    if (action === 'accounts') {
      // platform owner only (a TSA admin) - list all client accounts + their seat usage
      if (callerWs !== DEFAULT_WS || (s && s.role !== 'admin')) return res.status(200).json({ ok: false, error: 'not-authorized' });
      const wr = await supa('records?select=data&type=eq.workspace&order=submitted_at.asc');
      const mr = await supa('records?select=data&type=eq.wsmember&order=submitted_at.asc');
      const wsMap = {}; if (wr.ok) { (await wr.json()).forEach(x => { const d = x.data; if (d && d.ws) wsMap[d.ws] = d; }); }
      const memberWs = {}; if (mr.ok) { (await mr.json()).forEach(x => { const d = x.data; if (d && d.username) memberWs[String(d.username).toLowerCase()] = d.ws; }); }
      const seats = {}; Object.values(memberWs).forEach(w => { if (w) seats[w] = (seats[w] || 0) + 1; });
      const accounts = Object.values(wsMap).map(w => ({ ws: w.ws, name: w.name, plan: w.plan, kind: w.kind || 'client', owner: w.owner, createdAt: w.createdAt, seats: seats[w.ws] || 0, addons: w.addons || {} }));
      return res.status(200).json({ ok: true, accounts });
    }
    if (action === 'deleteAccount') {
      // platform owner only - permanently remove a client account (its records + its users)
      if (callerWs !== DEFAULT_WS || (s && s.role !== 'admin')) return res.status(200).json({ ok: false, error: 'not-authorized' });
      const ws = String(b.ws || ''); if (!ws || ws === DEFAULT_WS) return res.status(200).json({ ok: false, error: 'bad workspace' });
      const mr = await supa(`records?select=data&type=eq.wsmember&data->>ws=eq.${encodeURIComponent(ws)}`);
      const usernames = mr.ok ? (await mr.json()).map(x => x.data && x.data.username).filter(Boolean) : [];
      await supa(`records?data->>ws=eq.${encodeURIComponent(ws)}`, { method: 'DELETE' });
      for (const u of usernames) { await supa('users?username=eq.' + encodeURIComponent(u), { method: 'DELETE' }); }
      return res.status(200).json({ ok: true, removed: usernames.length });
    }
    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e) }); }
}
