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
async function supa(path) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
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
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, error: 'not-provisioned' });
  const action = q.action || b.action || 'records';
  try {
    if (action === 'records') {
      const ws = await wsForUser(s.username);
      // TSA also gets legacy rows with no ws; other workspaces get strictly their own.
      const filter = ws === DEFAULT_WS
        ? `or=(data->>ws.eq.${DEFAULT_WS},data->>ws.is.null)`
        : `data->>ws=eq.${encodeURIComponent(ws)}`;
      const r = await supa(`records?select=data&order=id.asc&limit=100000&${filter}`);
      if (!r.ok) { const t = await r.text(); return res.status(200).json({ ok: false, error: 'db ' + r.status + ' ' + t.slice(0, 160) }); }
      const rows = await r.json();
      return res.status(200).json({ ok: true, ws, records: rows.map(x => x.data).filter(Boolean) });
    }
    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e) }); }
}
