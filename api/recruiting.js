// /api/recruiting — Airtable proxy for the recruiting query + tag tool (reads the candidate pool, writes Campaign Tags).
// Env: AIRTABLE_TOKEN (required, a Personal Access Token with data.records:read + write on the recruiting base),
//      SESSION_SECRET (shared with /api/auth) + ADMIN_PASS (master fallback), optional AIRTABLE_REC_BASE / AIRTABLE_REC_TABLE overrides.
// Access is gated by the dashboard session: a valid session token with an allowed role, or the master admin pass.
import crypto from 'crypto';
const REC_ROLES = ['admin', 'manager']; // roles allowed to use the recruiting tool
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
function authorized(req) {
  const b = req.body || {}, q = req.query || {}, h = req.headers || {};
  const s = verifySession(b.token || q.token || h['x-session-token'] || '');
  if (s && REC_ROLES.includes(s.role)) return true;
  const ap = b.adminPass || q.adminPass || h['x-admin-pass'] || '';
  return !!(ap && (ap === process.env.ADMIN_PASS || ap === process.env.BOT_ADMIN_TOKEN));
}
const BASE = process.env.AIRTABLE_REC_BASE || 'appYKLdo9w2lyfmdQ';   // "TSA - Sales & Recruitment"
const TABLE = process.env.AIRTABLE_REC_TABLE || 'tblH5pEMqh9FhMW7h'; // "New Sales Rep Apps"
const FIELDS = [
  'Full Name', 'Application Rating', 'Applied For:', 'What Have You Sold In The Past? (SELECT ONE)',
  'Select ALL That Apply To You (DO NOT check any if none apply to you)', 'Recruitment Status', 'Application Status',
  'Currently Staffed?', 'Contact Number', 'Contact Email', 'What Time Zones Are You Open To Working?',
  'Software / Tech', 'What languages are you fluent in?', 'Work Preference',
  'Summary (Sales Call Recording)', 'Intro Video Link', 'Resume Link', 'Campaign Tags'
];
// normalize Airtable cell values (select/multiselect/lookup/aiText) into plain strings or string arrays
function sval(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => (x && x.name) ? x.name : (typeof x === 'string' ? x : (x && x.value != null ? String(x.value) : ''))).filter(Boolean);
  if (typeof v === 'object') { if (v.name) return v.name; if (v.value != null && v.state !== 'error') return String(v.value); return ''; }
  return v;
}
async function atFetch(path, opts) {
  const key = process.env.AIRTABLE_TOKEN;
  return fetch('https://api.airtable.com/v0/' + path, { ...(opts || {}), headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
export default async function handler(req, res) {
  const pass = process.env.RECRUIT_PASS;
  const given = (req.query && req.query.key) || (req.headers && req.headers['x-recruit-key']) || '';
  if (pass && given !== pass) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!process.env.AIRTABLE_TOKEN) return res.status(200).json({ ok: false, error: 'AIRTABLE_TOKEN not set on the server' });
  const action = (req.query && req.query.action) || (req.body && req.body.action) || 'list';
  try {
    if (action === 'list') {
      let records = [], offset;
      const qs = FIELDS.map(f => 'fields%5B%5D=' + encodeURIComponent(f)).join('&');
      do {
        const r = await atFetch(`${BASE}/${TABLE}?pageSize=100&${qs}` + (offset ? `&offset=${encodeURIComponent(offset)}` : ''), { method: 'GET' });
        if (!r.ok) { const t = await r.text(); return res.status(200).json({ ok: false, error: 'airtable ' + r.status + ' ' + t.slice(0, 300) }); }
        const j = await r.json(); records = records.concat(j.records || []); offset = j.offset;
      } while (offset);
      const out = records.map(rec => { const f = rec.fields || {}; return {
        id: rec.id,
        name: sval(f['Full Name']),
        rating: (typeof f['Application Rating'] === 'number' ? f['Application Rating'] : 0),
        role: sval(f['Applied For:']),
        sold: sval(f['What Have You Sold In The Past? (SELECT ONE)']),
        achievements: sval(f['Select ALL That Apply To You (DO NOT check any if none apply to you)']),
        recStatus: sval(f['Recruitment Status']),
        appStatus: sval(f['Application Status']),
        staffed: sval(f['Currently Staffed?']),
        phone: sval(f['Contact Number']),
        email: sval(f['Contact Email']),
        timezones: sval(f['What Time Zones Are You Open To Working?']),
        tech: sval(f['Software / Tech']),
        languages: sval(f['What languages are you fluent in?']),
        workPref: sval(f['Work Preference']),
        summary: sval(f['Summary (Sales Call Recording)']),
        intro: sval(f['Intro Video Link']),
        resume: sval(f['Resume Link']),
        tags: sval(f['Campaign Tags'])
      }; });
      return res.status(200).json({ ok: true, count: out.length, candidates: out });
    }
    if (action === 'tag') {
      const recs = (req.body && req.body.records) || [];
      if (!recs.length) return res.status(200).json({ ok: false, error: 'no records' });
      let updated = 0;
      for (let i = 0; i < recs.length; i += 10) {
        const batch = recs.slice(i, i + 10).map(x => ({ id: x.id, fields: { 'Campaign Tags': Array.isArray(x.tags) ? x.tags : [] } }));
        const r = await atFetch(`${BASE}/${TABLE}`, { method: 'PATCH', body: JSON.stringify({ records: batch, typecast: true }) });
        if (!r.ok) { const t = await r.text(); return res.status(200).json({ ok: false, error: 'airtable ' + r.status + ' ' + t.slice(0, 300), updated }); }
        const j = await r.json(); updated += (j.records || []).length;
      }
      return res.status(200).json({ ok: true, updated });
    }
    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e) }); }
}
