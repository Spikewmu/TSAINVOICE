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
      const accounts = Object.values(wsMap).map(w => ({ ws: w.ws, name: w.name, plan: w.plan, kind: w.kind || 'client', owner: w.owner, createdAt: w.createdAt, seats: seats[w.ws] || 0 }));
      return res.status(200).json({ ok: true, accounts });
    }
    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e) }); }
}
