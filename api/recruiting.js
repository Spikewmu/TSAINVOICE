// /api/recruiting — Airtable proxy for the recruiting query + tag tool (reads the candidate pool, writes Campaign Tags).
// Env: AIRTABLE_TOKEN (required, a Personal Access Token with data.records:read + write on the recruiting base),
//      SESSION_SECRET (shared with /api/auth) + ADMIN_PASS (master fallback), optional AIRTABLE_REC_BASE / AIRTABLE_REC_TABLE overrides.
// Access is gated by the dashboard session: a valid session token with an allowed role, or the master admin pass.
import crypto from 'crypto';
const REC_ROLES = ['admin', 'manager', 'recruiter']; // roles allowed to use the recruiting tool
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
// returns { ok, role, username } for the caller: a valid session with an allowed role, or the master admin pass (treated as TSA admin)
function sessionInfo(req) {
  const b = req.body || {}, q = req.query || {}, h = req.headers || {};
  const s = verifySession(b.token || q.token || h['x-session-token'] || '');
  if (s && REC_ROLES.includes(s.role)) return { ok: true, role: s.role, username: s.username || '' };
  const ap = b.adminPass || q.adminPass || h['x-admin-pass'] || '';
  if (ap && (ap === process.env.ADMIN_PASS || ap === process.env.BOT_ADMIN_TOKEN)) return { ok: true, role: 'admin', username: '' };
  return { ok: false, role: null, username: '' };
}
const DEFAULT_WS = 'tsa';
async function supa(path) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.SUPABASE_URL || !key) return null;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
}
// which workspace the caller belongs to (master pass / no username -> TSA)
async function wsForUser(username) {
  if (!username) return DEFAULT_WS;
  const r = await supa(`records?select=data&type=eq.wsmember&data->>username=ilike.${encodeURIComponent(username)}&order=submitted_at.desc&limit=1`);
  if (!r || !r.ok) return DEFAULT_WS;
  const rows = await r.json();
  return (rows[0] && rows[0].data && rows[0].data.ws) || DEFAULT_WS;
}
// does a client workspace hold the Recruiter add-on? returns { on, hireCap }
async function recruiterAddon(ws) {
  if (ws === DEFAULT_WS) return { on: true, hireCap: Infinity };
  const r = await supa(`records?select=data&type=eq.workspace&data->>ws=eq.${encodeURIComponent(ws)}&order=submitted_at.desc&limit=1`);
  if (!r || !r.ok) return { on: false, hireCap: 0 };
  const rows = await r.json();
  const a = rows[0] && rows[0].data && rows[0].data.addons && rows[0].data.addons.recruiter;
  return a ? { on: true, hireCap: a.hireCap || 0 } : { on: false, hireCap: 0 };
}
async function supaPost(row) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.SUPABASE_URL || !key) return null;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/records', { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(row) });
}
// ---- cross-client pool lock: a candidate a client moves into their process is claimed for that workspace and
//      hidden from every OTHER client's search. Stored as global 'poolclaim' records, read server-side with the
//      service key (never ws-scoped) so all workspaces are checked against one another. Auto-releases after silence. ----
const CLAIM_TTL_DAYS = 14;
function lockActive(l) {
  if (!l || l.status === 'released') return false;
  if (l.status === 'hired') return true; // a hire holds the slot permanently
  const anchor = Date.parse(l.lastActivityAt || l.claimedAt || l.submittedAt || '') || 0;
  return (Date.now() - anchor) < CLAIM_TTL_DAYS * 86400000;
}
function lockOwner(l) { return lockActive(l) ? { ws: l.ws, wsName: l.wsName || l.ws, hired: l.status === 'hired' } : null; }
async function poolLocks() {
  const map = {};
  const r = await supa(`records?select=data&type=eq.poolclaim&order=submitted_at.asc&limit=100000`);
  if (r && r.ok) { (await r.json()).forEach(x => { const d = x.data; if (d && d.candId) map[d.candId] = d; }); } // asc -> last write wins
  return map;
}
function slotsUsed(ws, locks) { let n = 0; Object.values(locks).forEach(l => { const o = lockOwner(l); if (o && o.ws === ws) n++; }); return n; }
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
export const config = { maxDuration: 60 }; // give the multi-page Airtable fetch room (esp. on slow/504 responses)
async function atFetch(path, opts) {
  const key = process.env.AIRTABLE_TOKEN;
  return fetch('https://api.airtable.com/v0/' + path, { ...(opts || {}), headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
// GET with a couple of retries on transient Airtable errors (429/5xx incl. 504 gateway timeouts)
async function atGet(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await atFetch(path, { method: 'GET' });
    if (r.ok || i === tries - 1 || ![429, 500, 502, 503, 504].includes(r.status)) return r;
    await new Promise(res => setTimeout(res, 700 * (i + 1)));
  }
}
export default async function handler(req, res) {
  const sess = sessionInfo(req);
  if (!sess.ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const callerWs = await wsForUser(sess.username);
  // a client workspace can use recruiting only if it holds the Recruiter add-on (TSA always can)
  const addon = await recruiterAddon(callerWs);
  if (callerWs !== DEFAULT_WS && !addon.on) return res.status(200).json({ ok: false, error: 'The Recruiter add-on is not active on this account.' });
  // Contact PII in the shared pool: visible only to TSA staff above recruiter tier. Every client-side user, and TSA recruiters, are redacted.
  const redactContact = (callerWs !== DEFAULT_WS) || (sess.role === 'recruiter');
  if (!process.env.AIRTABLE_TOKEN) return res.status(200).json({ ok: false, error: 'AIRTABLE_TOKEN not set on the server' });
  const action = (req.query && req.query.action) || (req.body && req.body.action) || 'list';
  try {
    if (action === 'diag') {
      const tok = process.env.AIRTABLE_TOKEN || '';
      const info = { hasToken: !!tok, tokenPrefix: tok.slice(0, 3), tokenLen: tok.length, base: BASE, table: TABLE };
      try {
        const r = await atFetch('meta/bases', { method: 'GET' });
        const j = await r.json();
        if (r.ok) { info.visibleBases = (j.bases || []).map(b => ({ id: b.id, name: b.name })); info.baseInTokenAccess = (j.bases || []).some(b => b.id === BASE); }
        else info.metaBasesError = r.status + ' ' + JSON.stringify(j).slice(0, 160);
      } catch (e) { info.metaBasesError = String(e); }
      try {
        const r2 = await atFetch(`${BASE}/${TABLE}?maxRecords=1`, { method: 'GET' });
        info.readTableStatus = r2.status; if (!r2.ok) info.readTableError = (await r2.text()).slice(0, 200);
      } catch (e) { info.readTableError = String(e); }
      return res.status(200).json({ ok: true, diag: info });
    }
    if (action === 'list') {
      let records = [], offset;
      const qs = FIELDS.map(f => 'fields%5B%5D=' + encodeURIComponent(f)).join('&');
      do {
        const r = await atGet(`${BASE}/${TABLE}?pageSize=100&${qs}` + (offset ? `&offset=${encodeURIComponent(offset)}` : ''));
        if (!r.ok) { const t = await r.text(); return res.status(200).json({ ok: false, error: 'airtable ' + r.status + ' ' + t.slice(0, 160) }); }
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
        phone: redactContact ? '' : sval(f['Contact Number']),
        email: redactContact ? '' : sval(f['Contact Email']),
        timezones: sval(f['What Time Zones Are You Open To Working?']),
        tech: sval(f['Software / Tech']),
        languages: sval(f['What languages are you fluent in?']),
        workPref: sval(f['Work Preference']),
        summary: sval(f['Summary (Sales Call Recording)']),
        intro: sval(f['Intro Video Link']),
        resume: sval(f['Resume Link']),
        tags: sval(f['Campaign Tags'])
      }; });
      // pool exclusivity: annotate each candidate with its lock, and hide from a client anything owned by another workspace
      const locks = await poolLocks();
      let visible = out.map(c => { const o = lockOwner(locks[c.id]); return Object.assign(c, { lockedByWs: o ? o.ws : '', lockedByName: o ? o.wsName : '', lockedMine: !!(o && o.ws === callerWs), lockedHired: !!(o && o.hired) }); });
      if (callerWs !== DEFAULT_WS) visible = visible.filter(c => !c.lockedByWs || c.lockedMine); // clients never see another workspace's claimed candidates
      const capInfo = (addon.hireCap === Infinity) ? null : { cap: addon.hireCap, used: slotsUsed(callerWs, locks) };
      return res.status(200).json({ ok: true, count: visible.length, candidates: visible, capInfo });
    }
    if (action === 'claim') {
      // claim candidates for the caller's workspace (moving them into your process). Cap-enforced; skips any owned by another workspace.
      const ids = (req.body && req.body.candIds) || [];
      if (!ids.length) return res.status(200).json({ ok: false, error: 'no candidates' });
      const locks = await poolLocks();
      const cap = addon.hireCap;
      let slots = (cap === Infinity) ? Infinity : Math.max(0, cap - slotsUsed(callerWs, locks));
      const claimed = [], blocked = [];
      for (const id of ids) {
        const o = lockOwner(locks[id]);
        if (o && o.ws !== callerWs) { blocked.push({ id, reason: 'claimed' }); continue; }
        if (o && o.ws === callerWs) { claimed.push(id); continue; } // already mine
        if (slots <= 0) { blocked.push({ id, reason: 'cap' }); continue; }
        const now = new Date().toISOString();
        const rec = { id: crypto.randomUUID(), type: 'poolclaim', candId: String(id), ws: callerWs, wsName: String((req.body && req.body.wsName) || callerWs), claimedAt: now, lastActivityAt: now, status: 'active', by: sess.username || '' };
        await supaPost({ rid: rec.id, type: 'poolclaim', submitted_at: now, data: rec });
        claimed.push(id); slots--;
      }
      const capRemaining = (cap === Infinity) ? null : Math.max(0, cap - slotsUsed(callerWs, locks) - claimed.length);
      return res.status(200).json({ ok: true, claimed, blocked, capRemaining });
    }
    if (action === 'release') {
      const ids = (req.body && req.body.candIds) || [];
      const locks = await poolLocks();
      let released = 0;
      for (const id of ids) {
        const o = lockOwner(locks[id]);
        const isTsa = callerWs === DEFAULT_WS;
        if (o && (o.ws === callerWs || isTsa)) { // you can release your own; TSA can release any
          const now = new Date().toISOString();
          const rec = { id: crypto.randomUUID(), type: 'poolclaim', candId: String(id), ws: o.ws, status: 'released', releasedAt: now, by: sess.username || '' };
          await supaPost({ rid: rec.id, type: 'poolclaim', submitted_at: now, data: rec });
          released++;
        }
      }
      return res.status(200).json({ ok: true, released });
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
    if (action === 'stage') {
      // move a candidate's pipeline stage = the "Recruitment Status" singleSelect
      const recs = (req.body && req.body.records) || [];
      if (!recs.length) return res.status(200).json({ ok: false, error: 'no records' });
      let updated = 0;
      for (let i = 0; i < recs.length; i += 10) {
        const batch = recs.slice(i, i + 10).map(x => ({ id: x.id, fields: { 'Recruitment Status': x.status ? x.status : null } }));
        const r = await atFetch(`${BASE}/${TABLE}`, { method: 'PATCH', body: JSON.stringify({ records: batch, typecast: true }) });
        if (!r.ok) { const t = await r.text(); return res.status(200).json({ ok: false, error: 'airtable ' + r.status + ' ' + t.slice(0, 300), updated }); }
        const j = await r.json(); updated += (j.records || []).length;
      }
      return res.status(200).json({ ok: true, updated });
    }
    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e) }); }
}
