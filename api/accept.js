// /api/accept - the candidate-facing "accept your offer" flow.
//
// A recruiter's offer message carries a signed accept link (accept.html?t=<token>). The candidate
// opens it (no login), sees the role, and clicks Accept. That marks them Hired in the pipeline,
// records the acceptance, and kicks off onboarding. The token is HMAC-signed so nobody can accept
// on someone else's behalf or tamper with the role.
//
// Actions:
//   mint   (authorized: session token w/ recruiter+ role) -> returns a signed accept link for a candidate
//   info   (public: ?t= token)   -> { name, position, company } to render the accept page
//   accept (public: body { t })  -> marks Hired + tags + writes a `hire` record (starts onboarding)
// Env: SESSION_SECRET, AIRTABLE_TOKEN (+ optional AIRTABLE_REC_BASE/TABLE), SUPABASE_URL, SUPABASE_SERVICE_KEY.
import crypto from 'crypto';
const ROLES = ['admin', 'manager', 'recruiter'];
const REC_BASE = process.env.AIRTABLE_REC_BASE || 'appYKLdo9w2lyfmdQ';
const REC_TABLE = process.env.AIRTABLE_REC_TABLE || 'tblH5pEMqh9FhMW7h';
const secret = () => process.env.SESSION_SECRET || 'tsa-session';
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(payload) {
  const body = b64u(payload);
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  try {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const exp = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
    if (mac.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
function sessionInfo(req) {
  const b = req.body || {}, q = req.query || {}, h = req.headers || {};
  const p = verify(b.token || q.token || h['x-session-token'] || '');
  if (p && ROLES.includes(p.role)) return { ok: true, role: p.role, username: p.username, name: p.name };
  const ap = b.adminPass || q.adminPass || h['x-admin-pass'] || '';
  if (ap && (ap === process.env.ADMIN_PASS || ap === process.env.BOT_ADMIN_TOKEN)) return { ok: true, role: 'admin' };
  return { ok: false };
}
const baseUrl = req => (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;
async function atFetch(path, opts) {
  return fetch('https://api.airtable.com/v0/' + path, { ...(opts || {}), headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_TOKEN, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
async function supaWrite(table, row) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + table, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(row) });
}
const usDate = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? (+m[2]) + '-' + (+m[3]) + '-' + m[1] : String(d || ''); };
// add a Campaign Tag (and optionally set the pipeline stage) on a candidate
async function markCandidate(candId, tag, status) {
  if (!process.env.AIRTABLE_TOKEN) return;
  const cur = await atFetch(`${REC_BASE}/${REC_TABLE}/${candId}`, { method: 'GET' });
  let tags = [];
  if (cur.ok) { const j = await cur.json(); tags = (j.fields && j.fields['Campaign Tags']) || []; }
  if (tag && !tags.includes(tag)) tags = [...tags, tag];
  const fields = { 'Campaign Tags': tags };
  if (status) fields['Recruitment Status'] = status;
  await atFetch(`${REC_BASE}/${REC_TABLE}`, { method: 'PATCH', body: JSON.stringify({ records: [{ id: candId, fields }], typecast: true }) });
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || (req.body && req.body.action) || 'info';
  try {
    if (action === 'mint') {
      const s = sessionInfo(req); if (!s.ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const b = req.body || {};
      if (!b.candId) return res.status(200).json({ ok: false, error: 'candId required' });
      const kind = b.kind === 'interview' ? 'interview' : 'offer';
      const token = sign({ candId: String(b.candId), name: b.name || '', position: b.position || '', company: b.company || 'The Sales Agency', kind, date: b.date || '', time: b.time || '', link: b.link || '', exp: Date.now() + 45 * 24 * 3600 * 1000 });
      return res.status(200).json({ ok: true, token, link: baseUrl(req) + '/accept.html?t=' + encodeURIComponent(token) });
    }
    if (action === 'info') {
      const p = verify((req.query && req.query.t) || (req.body && req.body.t)); if (!p) return res.status(200).json({ ok: false, error: 'This link is invalid or has expired.' });
      return res.status(200).json({ ok: true, name: p.name || '', position: p.position || '', company: p.company || 'The Sales Agency', kind: p.kind || 'offer', date: p.date || '', time: p.time || '', link: p.link || '' });
    }
    if (action === 'accept') {
      const p = verify((req.body && req.body.t) || (req.query && req.query.t)); if (!p) return res.status(200).json({ ok: false, error: 'This link is invalid or has expired.' });
      const today = new Date().toISOString().slice(0, 10);
      await markCandidate(p.candId, 'Offer accepted ' + usDate(today), 'Hired');
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        const rec = { id: crypto.randomUUID(), type: 'hire', candId: p.candId, name: p.name || '', position: p.position || '', company: p.company || '', acceptedAt: new Date().toISOString(), via: 'accept-link' };
        await supaWrite('records', { rid: rec.id, type: 'hire', submitted_at: rec.acceptedAt, data: rec });
      }
      return res.status(200).json({ ok: true, name: p.name || '', position: p.position || '', company: p.company || 'The Sales Agency' });
    }
    if (action === 'confirm' || action === 'decline') {
      const p = verify((req.body && req.body.t) || (req.query && req.query.t)); if (!p) return res.status(200).json({ ok: false, error: 'This link is invalid or has expired.' });
      const today = new Date().toISOString().slice(0, 10);
      if (action === 'confirm') await markCandidate(p.candId, 'Interview confirmed ' + usDate(today), null); // keep them booked
      else await markCandidate(p.candId, 'Interview declined ' + usDate(today), 'Standby'); // free them back to the pool
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        const rec = { id: crypto.randomUUID(), type: 'ivstatus', candId: p.candId, name: p.name || '', status: action === 'confirm' ? 'confirmed' : 'declined', at: new Date().toISOString() };
        await supaWrite('records', { rid: rec.id, type: 'ivstatus', submitted_at: rec.at, data: rec });
      }
      return res.status(200).json({ ok: true, name: p.name || '', position: p.position || '', company: p.company || 'The Sales Agency', kind: 'interview', outcome: action });
    }
    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e) }); }
}
