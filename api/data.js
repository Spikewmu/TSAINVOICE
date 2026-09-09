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
const chanDest = u => (/discord(app)?\.com\/api\/webhooks\//i.test(String(u || '')) && !/\/slack\/?$/i.test(String(u))) ? String(u).replace(/\/+$/, '') + '/slack' : u; // Discord accepts Slack payloads at /slack
const money = n => '$' + Number(n || 0).toLocaleString('en-US');
async function postChan(dest, text, blocks) { if (!dest) return; try { await fetch(chanDest(dest), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, blocks }) }); } catch (e) { } }
// in-app event feeds to Slack: New closed deal / Post-call checkout / Start-of-day projection (each to its own channel if set)
async function eventToSlack(rec) {
  try {
    if (!rec || !['deal', 'postcall', 'sod'].includes(rec.type)) return;
    const cfg = await integrationFor(rec.ws, rec.client); if (!cfg) return;
    const who = rec.rep || rec.by || 'Someone';
    if (rec.type === 'deal') {
      if (!cfg.dealSlack) return;
      const L = (label, val) => (val !== undefined && val !== null && String(val).trim() !== '') ? `\n*${label}:* ${String(val).trim()}` : ''; // only show a line if it has a value
      const dp = String(rec.date || '').slice(0, 10).split('-'); const dateStr = dp.length === 3 ? (Number(dp[1]) + '-' + Number(dp[2]) + '-' + dp[0]) : ''; // 2026-09-07 -> 9-7-2026
      const setterLine = (rec.setter && String(rec.setter).trim()) ? `\n*Setter:* ${String(rec.setter).trim()}` : '\n*Setter:* self-booked';
      const body = `🎉 *NEW CLOSED DEAL* · ${money(rec.cashCollected)} cash`
        + (rec.client ? `\n*Account:* ${rec.client}` : '')
        + L('Contact', rec.lead) + L('Email', rec.leadEmail) + L('Date', dateStr) + L('Offer', rec.product)
        + (rec.contractValue ? `\n*Contract value:* ${money(rec.contractValue)}` : '')
        + (rec.cashCollected ? `\n*Cash collected:* ${money(rec.cashCollected)}` : '')
        + (rec.depositCollected ? `\n*Deposit:* ${money(rec.depositCollected)}` : '')
        + L('Source', rec.source) + `\n*Closer:* ${who}` + setterLine + L('Notes', rec.notes);
      await postChan(cfg.dealSlack, `New closed deal${rec.client ? ' · ' + rec.client : ''} · ${money(rec.cashCollected)} (${who})`,
        [{ type: 'section', text: { type: 'mrkdwn', text: body } }]);
    } else if (rec.type === 'postcall') {
      const dest = (rec.role === 'Setter' ? (cfg.postcallSetterSlack || cfg.postcallSlack) : (cfg.postcallCloserSlack || cfg.postcallSlack));
      if (!dest) return;
      const L = (label, val) => (val !== undefined && val !== null && String(val).trim() !== '') ? `\n*${label}:* ${String(val).trim()}` : ''; // only show a line if it has a value
      const outcome = String(rec.outcome || '');
      const won = /^Won/.test(outcome), isFollow = /(Follow-up booked|Callback scheduled|Rescheduled)/.test(outcome), isDq = /^Disqualified/.test(outcome);
      const fmtDate = d => { const p = String(d || '').slice(0, 10).split('-'); return p.length === 3 ? (Number(p[1]) + '-' + Number(p[2]) + '-' + p[0]) : ''; }; // 2026-09-11 -> 9-11-2026
      const fmtTime = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); if (!m) return ''; let h = Number(m[1]); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + m[2] + ' ' + ap; }; // 14:30 -> 2:30 PM
      let body = `📞 *Post-call checkout* · ${who}${rec.role ? ' (' + rec.role + ')' : ''}${rec.client ? ' · ' + rec.client : ''}`
        + L('Outcome', outcome) + L('Lead', rec.lead);
      if (won) {
        body += L('Offer', rec.product);
        if (rec.cashCollected) body += `\n*Cash collected:* ${money(rec.cashCollected)}` + (rec.contractValue ? ` · *Contract:* ${money(rec.contractValue)}` : '');
        else if (rec.contractValue) body += `\n*Contract:* ${money(rec.contractValue)}`;
      }
      if (isFollow) { const fd = fmtDate(rec.followUpDate), ft = fmtTime(rec.followUpTime); if (fd || ft) body += `\n*Follow-up:* ${fd}${ft ? ' at ' + ft : ''}`; }
      if (isDq) body += L('DQ reason', rec.dqReason);
      body += L('Call type', rec.callType) + L('Source', rec.source);
      if (rec.role !== 'Setter') body += (rec.setter && String(rec.setter).trim()) ? `\n*Setter:* ${String(rec.setter).trim()}` : (won ? '\n*Setter:* self-booked' : '');
      body += L('Notes', rec.notes);
      if (won) body += `\n_(full deal detail also posts to the closed-deals channel)_`;
      if (rec.fathom && String(rec.fathom).trim()) body += `\n🎥 <${String(rec.fathom).trim()}|Recording>`;
      await postChan(dest, `Post-call · ${who}${rec.client ? ' · ' + rec.client : ''}${outcome ? ' · ' + outcome : ''}`,
        [{ type: 'section', text: { type: 'mrkdwn', text: body } }]);
    } else { // sod (start-of-day projection) — route by role to the setter/closer channel, else combined
      const dest = (rec.role === 'Setter' ? (cfg.sodSetterSlack || cfg.sodSlack) : (cfg.sodCloserSlack || cfg.sodSlack));
      if (!dest) return;
      const n = v => v || 0;
      let lines;
      if (rec.role === 'Setter') {
        lines = `*Calls today:* ${n(rec.sodCallsToday)}  ·  *Confirmed:* ${n(rec.sodConfirmed)}  ·  *Watched VSL:* ${n(rec.sodWatchedVsl)}\n*Set commitment today:* ${n(rec.sodSetTotal)}  (same-day ${n(rec.sodSameDay)} · 24h ${n(rec.sod24)} · 48h ${n(rec.sod48)} · 72h ${n(rec.sod72)})`;
      } else {
        const row = (lbl, v) => (v && String(v).trim()) ? `\n*${lbl}:* ${String(v).trim()}` : '';
        lines = `*Calls today:* ${n(rec.sodCallsToday)}  ·  *Confirmed:* ${n(rec.sodConfirmed)}`
          + row('Projected to close today', rec.sodProjClose) + row('In blood today', rec.sodBloodToday)
          + row('Projected to collect this week', rec.sodProjCollectWk) + row('In blood to collect this week', rec.sodBloodCollectWk);
      }
      const head = `📅 *Start-of-day projection* · ${who}${rec.role ? ' (' + rec.role + ')' : ''}${rec.client ? ' · ' + rec.client : ''}`;
      await postChan(dest, `Start-of-day projection · ${who}${rec.client ? ' · ' + rec.client : ''}`,
        [{ type: 'section', text: { type: 'mrkdwn', text: head + '\n' + lines } }].concat(rec.notes ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: '"' + String(rec.notes).slice(0, 200) + '"' }] }] : []));
    }
  } catch (e) { }
}
// post a submitted End-of-Day (or Manager EOD) to the client's Slack channel, if that client turned EOD alerts on
async function eodToSlack(rec) {
  try {
    if (!rec || (rec.type !== 'eod' && rec.type !== 'mgreod')) return;
    const cfg = await integrationFor(rec.ws, rec.client);
    if (!cfg || !cfg.eodToSlack) return;
    // route to the channel for this role (setter EOD, closer EOD, manager EOD can each be a different channel), fall back to the general one
    const dest = rec.type === 'mgreod' ? (cfg.eodMgrSlack || cfg.slackWebhook)
      : ((rec.role || 'Closer') === 'Setter' ? (cfg.eodSetterSlack || cfg.slackWebhook) : (cfg.eodCloserSlack || cfg.slackWebhook));
    if (!dest) return;
    const n = v => v || 0, who = rec.rep || rec.by || 'Someone';
    let line;
    if (rec.type === 'mgreod') line = `Setters ${n(rec.settersWorking)} · Closers ${n(rec.closersWorking)} · ${n(rec.closerCalls)} calls · $${n(rec.cash).toLocaleString('en-US')} cash`;
    else if ((rec.role || 'Closer') === 'Setter') line = `${n(rec.hoursDialing)}h · ${n(rec.newOutreach)} dials · ${n(rec.connectedCalls)} conn · ${n(rec.callsSet)} sets`;
    else line = `${n(rec.hoursDialing)}h · ${n(rec.connectedMeetings)} calls · ${n(rec.closedDeals)} deals · $${n(rec.cashCollected).toLocaleString('en-US')} cash`;
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `📝 *EOD · ${who}*${rec.role ? ' (' + rec.role + ')' : rec.type === 'mgreod' ? ' (Manager)' : ''}${rec.client ? ' · ' + rec.client : ''}\n${line}` } }
    ];
    if (rec.notes || rec.bottleneck) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '“' + String(rec.notes || rec.bottleneck).slice(0, 200) + '”' }] });
    await fetch(chanDest(dest), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `EOD from ${who}${rec.client ? ' · ' + rec.client : ''}`, blocks }) });
  } catch (e) { /* never block the write on a Slack failure */ }
}
// push a post-call / closed-deal disposition back to the client's GHL: find the contact by email, add a note + stamp the source.
// Returns a status so the Integrations "Test" button can surface errors; the write path fires it and ignores failures.
async function ghlPush(cfg, rec, contactIdOverride) {
  if (!cfg || !cfg.ghlApiKey) return { ok: false, error: 'no GHL API key set for this client' };
  try {
    const base = 'https://rest.gohighlevel.com/v1', H = { Authorization: 'Bearer ' + cfg.ghlApiKey, 'Content-Type': 'application/json' };
    let id = String(contactIdOverride || '').trim(); // when given, push straight to this contact (deals with no lead email)
    if (!id) {
      const email = String(rec.leadEmail || rec.email || '').trim();
      if (!email) return { ok: false, error: 'no lead email on this record (needed to match the GHL contact)' };
      const look = await fetch(base + '/contacts/lookup?email=' + encodeURIComponent(email), { headers: H });
      if (!look.ok) return { ok: false, error: 'GHL lookup failed (' + look.status + ') - check the API key' };
      const lj = await look.json().catch(() => ({}));
      const contact = (lj.contacts && lj.contacts[0]) || null;
      if (!contact || !contact.id) return { ok: false, error: 'no GHL contact found for ' + email };
      id = contact.id;
    }
    const m = n => '$' + Number(n || 0).toLocaleString('en-US'), lines = [];
    const add = (l, v) => { if (v !== undefined && v !== null && v !== '') lines.push(l + ': ' + v); };
    add('Type', rec.type === 'deal' ? 'Closed deal' : 'Post-call'); add('Source', rec.source); add('Outcome', rec.outcome); add('Product', rec.product);
    if (rec.cashCollected) add('Cash collected', m(rec.cashCollected)); if (rec.contractValue) add('Contract value', m(rec.contractValue));
    add('Closer', rec.rep); add('Setter', rec.setter); add('Call type', rec.callType); add('Call date', String(rec.date || '').slice(0, 10));
    const body = 'Sales HQ ' + (rec.type === 'deal' ? 'closed deal' : 'post-call') + ' (' + new Date().toISOString().slice(0, 10) + ')\n' + lines.join('\n');
    await fetch(base + '/contacts/' + id + '/notes', { method: 'POST', headers: H, body: JSON.stringify({ body }) }).catch(() => { });
    if (rec.source) await fetch(base + '/contacts/' + id, { method: 'PUT', headers: H, body: JSON.stringify({ source: rec.source }) }).catch(() => { });
    return { ok: true, contactId: id };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
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
      else if (rec.type === 'deal' || rec.type === 'postcall' || rec.type === 'sod') await eventToSlack(rec); // New closed deal / Post-call / SOD projection feeds
      if (rec.type === 'postcall' || rec.type === 'deal') { try { const gcfg = await integrationFor(rec.ws, rec.client); if (gcfg && gcfg.ghlEnabled && gcfg.ghlApiKey) await ghlPush(gcfg, rec); } catch (e) { } } // push the disposition back to the client's GHL (paid/organic attribution loop)
      return res.status(200).json({ ok: true });
    }
    // ---------- RESEND a record's Slack post (e.g. a closed deal whose channel wasn't connected at submit time) ----------
    if (action === 'resendSlack') {
      if (s && !['admin', 'director', 'manager'].includes(s.role)) return res.status(200).json({ ok: false, error: 'Managers/admins only' });
      const rec = b.record || {};
      if (!rec || !rec.type) return res.status(200).json({ ok: false, error: 'record required' });
      rec.ws = callerWs; // only ever post to the caller's own workspace / its client channel
      const cfg = await integrationFor(rec.ws, rec.client);
      if (!cfg) return res.status(200).json({ ok: false, error: 'No integration is set up for ' + (rec.client || 'this client') + '.' });
      // which channel would this event go to? if none, tell them to connect it first (mirrors eventToSlack/eodToSlack routing)
      let dest = '';
      if (rec.type === 'deal') dest = cfg.dealSlack;
      else if (rec.type === 'postcall') dest = (rec.role === 'Setter' ? (cfg.postcallSetterSlack || cfg.postcallSlack) : (cfg.postcallCloserSlack || cfg.postcallSlack));
      else if (rec.type === 'sod') dest = (rec.role === 'Setter' ? (cfg.sodSetterSlack || cfg.sodSlack) : (cfg.sodCloserSlack || cfg.sodSlack));
      else if (rec.type === 'eod') dest = cfg.eodToSlack ? ((rec.role || 'Closer') === 'Setter' ? (cfg.eodSetterSlack || cfg.slackWebhook) : (cfg.eodCloserSlack || cfg.slackWebhook)) : '';
      else if (rec.type === 'mgreod') dest = cfg.eodToSlack ? (cfg.eodMgrSlack || cfg.slackWebhook) : '';
      else return res.status(200).json({ ok: false, error: 'This record type cannot be posted to Slack.' });
      if (!dest) return res.status(200).json({ ok: false, error: 'No Slack channel is connected for this on ' + (rec.client || 'this client') + '. Connect it on Integrations, then resend.' });
      if (rec.type === 'eod' || rec.type === 'mgreod') await eodToSlack(rec); else await eventToSlack(rec);
      return res.status(200).json({ ok: true });
    }
    // ---------- PUSH one closed deal / post-call to the client's GHL on demand (admin only) ----------
    // Manual push using the record's REAL data (note + source stamp). Works even when the auto-toggle is off,
    // so it backfills closes logged before GHL was connected, and lets an admin re-push a specific record.
    if (action === 'pushGhl') {
      if (s && s.role !== 'admin') return res.status(200).json({ ok: false, error: 'Admins only' });
      const rec = b.record || {};
      if (!rec || !rec.type) return res.status(200).json({ ok: false, error: 'record required' });
      if (rec.type !== 'deal' && rec.type !== 'postcall') return res.status(200).json({ ok: false, error: 'Only closed deals and post-calls can push to GHL.' });
      rec.ws = callerWs; // only ever push within the caller's own workspace
      const cfg = await integrationFor(rec.ws, rec.client);
      if (!cfg || !cfg.ghlApiKey) return res.status(200).json({ ok: false, error: 'No GHL API key set for ' + (rec.client || 'this client') + ' - add it on Integrations first.' });
      const out = await ghlPush(cfg, rec, b.contactId); // real note + real source; contactId (optional) pushes straight to that contact when the deal has no lead email
      return res.status(200).json(out);
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
