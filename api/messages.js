// /api/messages - private candidate messaging (email + text), scoped by role.
//
// Why this is a separate endpoint (not the shared `records` table the client reads directly):
// message CONTENT and candidate contact info must NOT be visible to every logged-in user. This
// endpoint reads/writes a dedicated `messages` table using the Supabase SERVICE key only, and
// returns only the threads the caller is allowed to see (a recruiter sees their own owned
// conversations; managers/admins see all). Candidate email/phone is never returned to the client.
//
// Provisioning required before this works:
//   1) Create the `messages` table in Supabase (see /db/messages.sql) with RLS on and NO anon policy.
//   2) Twilio env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (a TSA number).
//   3) Email send is pending the native platform (T-371) - email sends return 'email-not-connected'.
// Env also used: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SECRET, ADMIN_PASS/BOT_ADMIN_TOKEN,
//   AIRTABLE_TOKEN (+ optional AIRTABLE_REC_BASE / AIRTABLE_REC_TABLE) to look up candidate contact.
import crypto from 'crypto';
const ROLES = ['admin', 'manager', 'recruiter'];
const OVERSIGHT = ['admin', 'manager'];
const REC_BASE = process.env.AIRTABLE_REC_BASE || 'appYKLdo9w2lyfmdQ';
const REC_TABLE = process.env.AIRTABLE_REC_TABLE || 'tblH5pEMqh9FhMW7h';

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
function sessionInfo(req) {
  const b = req.body || {}, q = req.query || {}, h = req.headers || {};
  const s = verifySession(b.token || q.token || h['x-session-token'] || '');
  if (s && ROLES.includes(s.role)) return { ok: true, role: s.role, username: s.username, name: s.name };
  const ap = b.adminPass || q.adminPass || h['x-admin-pass'] || '';
  if (ap && (ap === process.env.ADMIN_PASS || ap === process.env.BOT_ADMIN_TOKEN)) return { ok: true, role: 'admin', username: 'admin', name: 'Admin' };
  return { ok: false };
}
const nrm = s => String(s || '').trim().toLowerCase();
const digits = s => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); // normalize US phone to 10 digits

async function supa(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { ...(opts || {}), headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
// latest non-released claim owner for a candidate (claims live in the shared `records` table)
async function claimOwner(candId) {
  const r = await supa(`records?select=data,submitted_at&type=eq.claim&data->>candId=eq.${encodeURIComponent(candId)}&order=submitted_at.desc&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json(); const d = rows[0] && rows[0].data;
  if (!d || !d.owner || d.status === 'released') return null;
  return { owner: d.owner, ownerName: d.ownerName || d.owner };
}
async function writeClaim(rec) {
  rec.id = crypto.randomUUID(); rec.submittedAt = new Date().toISOString(); rec.type = 'claim';
  await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: rec.id, type: 'claim', submitted_at: rec.submittedAt, data: rec }) });
}
async function candContact(candId, channel) {
  const key = process.env.AIRTABLE_TOKEN; if (!key) return '';
  const r = await fetch(`https://api.airtable.com/v0/${REC_BASE}/${REC_TABLE}/${candId}`, { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) return '';
  const j = await r.json(); const f = j.fields || {};
  return channel === 'email' ? String(f['Contact Email'] || '') : String(f['Contact Number'] || '');
}
async function sendText(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from) return { ok: false, error: 'text-not-connected' };
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: 'twilio ' + r.status + ' ' + (j.message || '') };
  return { ok: true, sid: j.sid };
}
const clientRow = m => ({ candId: m.cand_id, owner: m.owner, dir: m.dir, channel: m.channel, body: m.body, subject: m.subject, byName: m.by_name, by: m.by_user, at: m.created_at }); // never expose `contact`

export default async function handler(req, res) {
  const sess = sessionInfo(req);
  if (!sess.ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, error: 'not-provisioned' });
  const action = (req.query && req.query.action) || (req.body && req.body.action) || 'threads';
  const oversight = OVERSIGHT.includes(sess.role);
  try {
    if (action === 'threads' || action === 'thread') {
      const b = req.body || {};
      let path = 'messages?select=*&order=created_at.asc';
      if (!oversight) path += `&owner=eq.${encodeURIComponent(sess.username)}`; // recruiters: own conversations only
      if (action === 'thread' && b.candId) path += `&cand_id=eq.${encodeURIComponent(b.candId)}`;
      const r = await supa(path);
      if (r.status === 404 || r.status === 400) return res.status(200).json({ ok: false, error: 'not-provisioned' });
      if (!r.ok) return res.status(200).json({ ok: false, error: 'db ' + r.status });
      const rows = await r.json();
      return res.status(200).json({ ok: true, messages: rows.map(clientRow) });
    }
    if (action === 'send') {
      const b = req.body || {};
      const candId = String(b.candId || ''); const channel = b.channel === 'email' ? 'email' : 'text';
      const body = String(b.body || '').trim(); const subject = String(b.subject || '');
      if (!candId || !body) return res.status(200).json({ ok: false, error: 'candId and body required' });
      // ownership: a recruiter may only message a candidate they own (or an unowned one, which they then claim)
      let own = await claimOwner(candId);
      if (!oversight) {
        if (own && nrm(own.owner) !== nrm(sess.username)) return res.status(200).json({ ok: false, error: 'owned by ' + own.ownerName });
        if (!own) { await writeClaim({ candId, candName: b.candName || '', owner: sess.username, ownerName: sess.name || sess.username, claimedAt: new Date().toISOString(), status: 'active', by: sess.name || '' }); own = { owner: sess.username, ownerName: sess.name || sess.username }; }
      } else if (!own) { own = { owner: sess.username, ownerName: sess.name || sess.username }; }
      const to = await candContact(candId, channel);
      if (!to) return res.status(200).json({ ok: false, error: 'no ' + channel + ' on file for this candidate' });
      let sent;
      if (channel === 'text') sent = await sendText(to, body);
      else sent = { ok: false, error: 'email-not-connected' }; // pending the native email platform (T-371)
      if (!sent.ok) return res.status(200).json({ ok: false, error: sent.error });
      const row = { cand_id: candId, owner: own.owner, dir: 'out', channel, body, subject, contact: channel === 'text' ? digits(to) : nrm(to), by_user: sess.username, by_name: sess.name || sess.username, created_at: new Date().toISOString() };
      const w = await supa('messages', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      if (!w.ok) return res.status(200).json({ ok: false, error: 'store ' + w.status });
      return res.status(200).json({ ok: true, message: clientRow(row) });
    }
    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e) }); }
}
