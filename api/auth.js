// /api/auth — login + user management on Vercel + Supabase, replacing Apps Script.
//
// Migration is transparent: existing users keep their passwords. On login we check
// the Supabase `users` table; if the user has no stored hash yet, we PROXY to the
// old Apps Script login (server-side, which works), and on success store the hash so
// next time is pure Supabase. Apps Script can be deleted once everyone has logged in
// once (all rows have a pass_hash).
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   - server-side DB access (users table)
//   SUPABASE_ANON_KEY                    - publishable key returned to the client for record reads
//   AUTH_PEPPER                          - salt mixed into password hashes
//   SESSION_SECRET                       - signs session tokens
//   MASTER_USER (default 'tsaboss'), MASTER_PASS  - break-glass admin
//   APPS_SCRIPT_URL                      - old backend, used only to migrate un-migrated users
import crypto from 'crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hashPass = (pw) => crypto.createHmac('sha256', process.env.AUTH_PEPPER || 'tsa-pepper').update(String(pw)).digest('hex');

function sign(payload) {
  const secret = process.env.SESSION_SECRET || 'tsa-session';
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  try {
    const secret = process.env.SESSION_SECRET || 'tsa-session';
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const exp = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
const tokenFor = (u) => sign({ username: u.username, role: u.role, name: u.name, exp: Date.now() + 30 * 24 * 3600 * 1000 });

async function supa(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(opts && opts.headers) },
  });
  return r;
}
async function getUser(username) {
  // case-insensitive exact match (ilike, no wildcards) so a login works regardless of typed case
  // and regardless of how the username was stored (some are lowercase like "ra-eez", some capitalized like "Keith")
  const r = await supa(`users?username=ilike.${encodeURIComponent(username)}&select=username,name,role,pass_hash&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
const DEFAULT_WS = 'tsa';
// username -> workspace, from 'wsmember' records (latest wins). Unmapped users belong to TSA (the first workspace).
async function wsMemberMap() {
  const r = await supa("records?select=data&type=eq.wsmember&order=submitted_at.asc");
  const map = {};
  if (r.ok) { const rows = await r.json(); for (const row of rows) { const d = row.data; if (d && d.username) map[String(d.username).toLowerCase()] = d.ws || DEFAULT_WS; } }
  return map;
}
const wsOf = (map, username) => map[String(username || '').toLowerCase()] || DEFAULT_WS;
const SEATS = { trial: 5, starter: 5, growth: 15, scale: 40 };
async function wsPlan(ws) {
  const r = await supa(`records?select=data&type=eq.workspace&data->>ws=eq.${encodeURIComponent(ws)}&order=submitted_at.desc&limit=1`);
  if (!r.ok) return 'trial';
  const rows = await r.json();
  return (rows[0] && rows[0].data && rows[0].data.plan) || 'trial';
}
async function upsertUser(u) {
  await supa('users?on_conflict=username', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(u),
  });
}
async function appsScriptLogin(username, password) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) return null;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'login', username, password }) });
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch (e) { return null; }
}
const anonKey = () => process.env.SUPABASE_ANON_KEY || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const action = body.action || 'login';

  try {
    // ---------- LOGIN ----------
    if (action === 'login') {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username) return res.status(200).json({ ok: false });

      // master break-glass
      if (username === (process.env.MASTER_USER || 'tsaboss') && process.env.MASTER_PASS && password === process.env.MASTER_PASS) {
        const u = { username, name: 'Admin', role: 'admin' };
        return res.status(200).json({ ok: true, ...u, token: tokenFor(u), supaKey: anonKey() });
      }

      const existing = await getUser(username);
      // migrated user with a real hash → verify locally, no Apps Script
      if (existing && existing.pass_hash) {
        if (existing.pass_hash === hashPass(password)) {
          return res.status(200).json({ ok: true, username: existing.username, name: existing.name, role: existing.role, token: tokenFor(existing), supaKey: anonKey() });
        }
        return res.status(200).json({ ok: false });
      }
      // not migrated yet (missing, or seeded without a hash) → validate against Apps Script, then store the hash
      const as = await appsScriptLogin(username, password);
      if (as) {
        const u = { username, name: as.name || username, role: as.role || 'closer', pass_hash: hashPass(password) };
        await upsertUser(u);
        return res.status(200).json({ ok: true, username, name: u.name, role: u.role, token: tokenFor(u), supaKey: as.supaKey || anonKey() });
      }
      return res.status(200).json({ ok: false });
    }

    // ---------- SIGNUP (public: creates a new team/workspace + its owner) ----------
    if (action === 'signup') {
      const email = String(body.email || body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const teamName = String(body.teamName || '').trim();
      const name = String(body.name || '').trim() || email;
      if (!email || !teamName) return res.status(200).json({ ok: false, error: 'Team name and email are required' });
      if (password.length < 6) return res.status(200).json({ ok: false, error: 'Password must be at least 6 characters' });
      const existing = await getUser(email);
      if (existing) return res.status(200).json({ ok: false, error: 'An account with that email already exists. Sign in instead.' });
      const slug = (teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)) || 'team';
      const ws = slug + '-' + Math.random().toString(36).slice(2, 7);
      const u = { username: email, name, role: 'admin', pass_hash: hashPass(password) };
      await upsertUser(u);
      const now = new Date().toISOString();
      const wrec = { id: crypto.randomUUID(), type: 'workspace', ws, name: teamName, plan: 'trial', createdAt: now, owner: email, submittedAt: now };
      const mrec = { id: crypto.randomUUID(), type: 'wsmember', ws, username: email, name, role: 'owner', submittedAt: now };
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: wrec.id, type: 'workspace', submitted_at: now, data: wrec }) });
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: mrec.id, type: 'wsmember', submitted_at: now, data: mrec }) });
      return res.status(200).json({ ok: true, username: email, name, role: 'admin', token: tokenFor(u), supaKey: anonKey() });
    }

    // everything below needs a valid session token
    const session = verify(body.token);
    if (!session) return res.status(200).json({ ok: false, error: 'unauthorized' });

    // ---------- LIST USERS (any logged-in user; drives the rep dropdowns) ----------
    if (action === 'listUsers') {
      const r = await supa('users?select=username,name,role&order=name.asc');
      if (!r.ok) return res.status(200).json({ ok: false, error: 'read ' + r.status });
      const all = await r.json();
      const map = await wsMemberMap();
      const myWs = wsOf(map, session.username); // return only members of the caller's workspace
      return res.status(200).json({ ok: true, users: all.filter(u => wsOf(map, u.username) === myWs) });
    }

    // ---------- CHANGE OWN PASSWORD (any logged-in user) ----------
    if (action === 'changePassword') {
      const username = session.username;
      const cur = String(body.currentPassword || ''), nw = String(body.newPassword || '');
      if (nw.length < 6) return res.status(200).json({ ok: false, error: 'New password must be at least 6 characters' });
      if (username === (process.env.MASTER_USER || 'tsaboss')) return res.status(200).json({ ok: false, error: 'The master account password is set in Vercel, not here' });
      const u = await getUser(username);
      if (!u || !u.pass_hash) return res.status(200).json({ ok: false, error: 'Account not found' });
      if (u.pass_hash !== hashPass(cur)) return res.status(200).json({ ok: false, error: 'Current password is incorrect' });
      await upsertUser({ username, name: u.name, role: u.role, pass_hash: hashPass(nw) });
      return res.status(200).json({ ok: true });
    }

    // admin-only past here
    if (session.role !== 'admin') return res.status(200).json({ ok: false, error: 'admin only' });

    // ---------- PROVISION A CLIENT ACCOUNT (platform owner only: creates an independent workspace + its Founder-admin) ----------
    if (action === 'provisionAccount') {
      const map0 = await wsMemberMap();
      if (wsOf(map0, session.username) !== DEFAULT_WS) return res.status(200).json({ ok: false, error: 'Only the platform owner can create client accounts' });
      const teamName = String(body.teamName || '').trim();
      const email = String(body.founderEmail || '').trim().toLowerCase();
      const name = String(body.founderName || '').trim() || email;
      const password = String(body.password || '');
      const plan = ['trial', 'starter', 'growth', 'scale'].includes(body.plan) ? body.plan : 'starter';
      if (!teamName || !email) return res.status(200).json({ ok: false, error: 'Company name and founder email are required' });
      if (password.length < 6) return res.status(200).json({ ok: false, error: 'Founder password must be at least 6 characters' });
      const existing = await getUser(email);
      if (existing) return res.status(200).json({ ok: false, error: 'That founder email already has an account' });
      const slug = (teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)) || 'client';
      const ws = slug + '-' + Math.random().toString(36).slice(2, 7);
      await upsertUser({ username: email, name, role: 'admin', pass_hash: hashPass(password) });
      const now = new Date().toISOString();
      const wrec = { id: crypto.randomUUID(), type: 'workspace', ws, name: teamName, plan, kind: 'client', owner: email, createdAt: now, provisionedBy: session.name || 'TSA', submittedAt: now };
      const mrec = { id: crypto.randomUUID(), type: 'wsmember', ws, username: email, name, role: 'owner', submittedAt: now };
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: wrec.id, type: 'workspace', submitted_at: now, data: wrec }) });
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: mrec.id, type: 'wsmember', submitted_at: now, data: mrec }) });
      return res.status(200).json({ ok: true, ws, name: teamName, founder: email, plan });
    }

    // ---------- SAVE / CREATE USER ----------
    if (action === 'saveUser') {
      const u = body.user || {};
      const username = String(u.username || '').trim();
      if (!username) return res.status(200).json({ ok: false, error: 'username required' });
      const map = await wsMemberMap();
      const myWs = wsOf(map, session.username);
      const isNewMember = wsOf(map, username) !== myWs; // adding someone not already in my workspace
      // seat gate: paid/trial workspaces have a seat limit; TSA (internal) is unlimited
      if (isNewMember && myWs !== DEFAULT_WS) {
        const members = Object.values(map).filter(w => w === myWs).length;
        const plan = await wsPlan(myWs);
        const limit = SEATS[plan] || 5;
        if (members >= limit) return res.status(200).json({ ok: false, error: `Your ${plan} plan allows ${limit} seats. Upgrade to add more.` });
      }
      const row = { username, name: String(u.name || username), role: String(u.role || 'closer') };
      if (u.password) row.pass_hash = hashPass(u.password); // only overwrite the password when one is provided
      await upsertUser(row);
      if (isNewMember) { // stamp the new user into the creating admin's workspace so rosters stay isolated
        const now = new Date().toISOString();
        const mrec = { id: crypto.randomUUID(), type: 'wsmember', ws: myWs, username, name: row.name, role: 'member', submittedAt: now };
        await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: mrec.id, type: 'wsmember', submitted_at: now, data: mrec }) });
      }
      return res.status(200).json({ ok: true });
    }

    // ---------- DELETE USER ----------
    if (action === 'deleteUser') {
      const username = String(body.username || '').trim();
      if (!username) return res.status(200).json({ ok: false });
      await supa('users?username=eq.' + encodeURIComponent(username), { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // ---------- IMPORT ROSTER FROM APPS SCRIPT (one-time, so dropdowns are complete before everyone logs in) ----------
    if (action === 'importUsers') {
      const url = process.env.APPS_SCRIPT_URL;
      if (!url) return res.status(200).json({ ok: false, error: 'no APPS_SCRIPT_URL' });
      const master = process.env.MASTER_PASS || '';
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'listUsers', adminPass: master, actorUser: process.env.MASTER_USER || 'tsaboss', actorPass: master }) });
      const j = await r.json().catch(() => null);
      const list = (j && j.users) || [];
      let added = 0;
      for (const u of list) {
        if (!u || !u.username) continue;
        // insert without a hash, ignore-duplicates so we never clobber a migrated password
        const ins = await supa('users?on_conflict=username', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ username: u.username, name: u.name || u.username, role: u.role || 'closer' }) });
        if (ins.ok) added++;
      }
      return res.status(200).json({ ok: true, imported: added, total: list.length });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
