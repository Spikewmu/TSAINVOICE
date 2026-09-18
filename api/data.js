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
// ---- zero-dependency PDF builder (Vercel functions have no npm deps) ----
function pdfEsc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
function buildPdf(lines) { // lines: [{t,x,y,size,bold}]
  let content = '';
  lines.forEach(l => { content += `BT /F${l.bold ? 2 : 1} ${l.size || 11} Tf ${l.x} ${l.y} Td (${pdfEsc(l.t)}) Tj ET\n`; });
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`
  ];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offs.forEach(o => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
function invoicePdf(b) {
  const usd = n => '$' + Number(n || 0).toLocaleString('en-US');
  const dt = ss => { ss = String(ss || '').slice(0, 10); const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ss); return m ? (+m[2]) + '-' + (+m[3]) + '-' + m[1] : ss; };
  const L = [], add = (t, x, y, o) => L.push({ t, x, y, size: o && o.size, bold: o && o.bold });
  const rule = y => add('________________________________________________________________', 54, y, { size: 9 });
  let y = 744;
  add('THE SALES AGENCY', 54, y, { size: 18, bold: true }); y -= 18;
  add('Performance commission invoice', 54, y, { size: 11 }); y -= 30;
  add('Bill to:', 54, y, { bold: true }); add(b.client || '', 110, y); y -= 16;
  add('Period:', 54, y, { bold: true }); add(dt(b.from) + ' to ' + dt(b.to), 110, y); y -= 16;
  add('Invoice date:', 54, y, { bold: true }); add(dt(new Date().toISOString()), 130, y); y -= 26;
  add('Description', 54, y, { bold: true }); add('Amount', 470, y, { bold: true }); y -= 4; rule(y); y -= 18;
  add('Sales services' + (b.rateDesc ? ' (' + String(b.rateDesc).slice(0, 60) + ')' : ''), 54, y); add(usd(b.amount), 470, y); y -= 15;
  add('Cash collected in period', 54, y, { size: 10 }); add(usd(b.cash), 470, y, { size: 10 }); y -= 13;
  add('Deals', 54, y, { size: 10 }); add(String(b.deals || 0), 470, y, { size: 10 }); y -= 16; rule(y); y -= 20;
  add('Amount due', 54, y, { bold: true, size: 13 }); add(usd(b.amount), 450, y, { bold: true, size: 13 }); y -= 34;
  const r = b.remit || {};
  add('Remit / wire instructions', 54, y, { bold: true }); y -= 18;
  [['Beneficiary', r.beneficiary], ['Bank', r.bank], ['Bank address', r.bankAddr], ['Account type', r.acctType], ['Routing', r.routing], ['Account #', r.account], ['SWIFT', r.swift], ['Reference', r.reference]].forEach(([k, v]) => { if (v) { add(k + ':', 54, y, { size: 10 }); add(String(v), 160, y, { size: 10 }); y -= 14; } });
  y -= 10; add('Sales services provided by The Sales Agency. Thank you.', 54, y, { size: 9 });
  return buildPdf(L);
}
// upload a file to a Slack channel via files.uploadV2 (3-step). Needs a bot token with files:write + the channel_id.
async function slackUploadFile(bot, channelId, filename, buffer, comment) {
  try {
    const g = await fetch('https://slack.com/api/files.getUploadURLExternal', { method: 'POST', headers: { Authorization: 'Bearer ' + bot, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ filename, length: String(buffer.length) }) });
    const gj = await g.json(); if (!gj.ok) return { ok: false, error: 'getUploadURL: ' + gj.error };
    const form = new FormData(); form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
    const u = await fetch(gj.upload_url, { method: 'POST', body: form }); if (!u.ok) return { ok: false, error: 'upload ' + u.status };
    const c = await fetch('https://slack.com/api/files.completeUploadExternal', { method: 'POST', headers: { Authorization: 'Bearer ' + bot, 'Content-Type': 'application/json' }, body: JSON.stringify({ files: [{ id: gj.file_id, title: filename }], channel_id: channelId, initial_comment: comment }) });
    const cj = await c.json(); return cj.ok ? { ok: true } : { ok: false, error: 'complete: ' + cj.error };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
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
      const body = `🎉 *NEW CLOSED DEAL*${rec.client ? '  ·  *' + rec.client + '*' : ''}`
        + `\n${who} (Closer)`
        + L('Contact', rec.lead) + L('Email', rec.leadEmail) + L('Date', dateStr) + L('Offer', rec.product)
        + (rec.contractValue ? `\n*Contract value:* ${money(rec.contractValue)}` : '')
        + (rec.cashCollected ? `\n*Cash collected:* ${money(rec.cashCollected)}` : '')
        + (rec.depositCollected ? `\n*Deposit:* ${money(rec.depositCollected)}` : '')
        + L('Source', rec.source) + setterLine + L('Notes', rec.notes);
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
      let body = `📞 *Post-call checkout*${rec.client ? '  ·  *' + rec.client + '*' : ''}\n${who}${rec.role ? ' (' + rec.role + ')' : ''}`
        + L('Outcome', outcome) + L('Lead', rec.lead);
      if (won) {
        body += L('Offer', rec.product);
        if (rec.cashCollected) body += `\n*Cash collected:* ${money(rec.cashCollected)}` + (rec.contractValue ? `\n*Contract:* ${money(rec.contractValue)}` : '');
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
        lines = `*Calls today:* ${n(rec.sodCallsToday)}\n*Confirmed:* ${n(rec.sodConfirmed)}\n*Watched VSL:* ${n(rec.sodWatchedVsl)}\n*Set commitment today:* ${n(rec.sodSetTotal)}  (same-day ${n(rec.sodSameDay)} · 24h ${n(rec.sod24)} · 48h ${n(rec.sod48)} · 72h ${n(rec.sod72)})`;
      } else {
        const row = (lbl, v) => (v && String(v).trim()) ? `\n*${lbl}:* ${String(v).trim()}` : '';
        lines = `*Calls today:* ${n(rec.sodCallsToday)}\n*Confirmed:* ${n(rec.sodConfirmed)}`
          + row('Projected to close today', rec.sodProjClose) + row('In blood today', rec.sodBloodToday)
          + row('Projected to collect this week', rec.sodProjCollectWk) + row('In blood to collect this week', rec.sodBloodCollectWk);
      }
      const head = `📅 *Start of Day*${rec.client ? '  ·  *' + rec.client + '*' : ''}\n${who}${rec.role ? ' (' + rec.role + ')' : ''}`;
      await postChan(dest, `Start of Day · ${rec.client ? rec.client + ' · ' : ''}${who}`,
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
    if (rec.type === 'mgreod') line = `*Setters working:* ${n(rec.settersWorking)}\n*Closers working:* ${n(rec.closersWorking)}\n*Calls taken:* ${n(rec.closerCalls)}\n*Cash:* $${n(rec.cash).toLocaleString('en-US')}`;
    else if ((rec.role || 'Closer') === 'Setter') line = `*Hours dialing:* ${n(rec.hoursDialing)}\n*Dials:* ${n(rec.newOutreach)}\n*Connected:* ${n(rec.connectedCalls)}\n*Sets:* ${n(rec.callsSet)}`;
    else line = `*Hours dialing:* ${n(rec.hoursDialing)}\n*Calls taken:* ${n(rec.connectedMeetings)}\n*Deals:* ${n(rec.closedDeals)}\n*Cash:* $${n(rec.cashCollected).toLocaleString('en-US')}`;
    const head = `📝 *End of Day*${rec.client ? '  ·  *' + rec.client + '*' : ''}\n${who}${rec.role ? ' (' + rec.role + ')' : rec.type === 'mgreod' ? ' (Manager)' : ''}`;
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `${head}\n${line}` } }
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
    // auto-detect the key type: v2 Private Integration Token (starts "pit-") vs legacy v1 Location API Key (a JWT, "eyJ...")
    const key = String(cfg.ghlApiKey || ''), v2 = /^pit-/i.test(key), loc = String(cfg.ghlLocationId || '').trim();
    const base = v2 ? 'https://services.leadconnectorhq.com' : 'https://rest.gohighlevel.com/v1';
    const H = v2 ? { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Version: '2021-07-28' }
                 : { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    if (v2 && !loc) return { ok: false, error: 'This is a v2 Private Integration token - it needs the Location ID set on Integrations.' };
    // search contacts by a query (email or name); returns an array of {id,email,...} or {__err:status}
    const searchContacts = async (query) => {
      const url = v2 ? base + '/contacts/?locationId=' + encodeURIComponent(loc) + '&query=' + encodeURIComponent(query)
                     : base + '/contacts/?query=' + encodeURIComponent(query) + '&limit=5';
      const r = await fetch(url, { headers: H });
      if (!r.ok) return { __err: r.status };
      const j = await r.json().catch(() => ({}));
      return j.contacts || [];
    };
    let id = String(contactIdOverride || '').trim(); // when given, push straight to this contact
    if (!id) {
      const email = String(rec.leadEmail || rec.email || '').trim();
      if (email) { // 1) match by email (most reliable)
        let c = null;
        if (v2) { const arr = await searchContacts(email); if (arr.__err) return { ok: false, error: 'GHL lookup failed (' + arr.__err + ') - check the API token' }; c = (arr || []).find(x => x && x.id && String(x.email || '').toLowerCase() === email.toLowerCase()) || (arr || [])[0] || null; }
        else { const look = await fetch(base + '/contacts/lookup?email=' + encodeURIComponent(email), { headers: H }); if (!look.ok) return { ok: false, error: 'GHL lookup failed (' + look.status + ') - check the API key' }; const lj = await look.json().catch(() => ({})); c = (lj.contacts && lj.contacts[0]) || null; }
        if (c && c.id) id = c.id;
      }
      if (!id) { // 2) auto-fallback: match by the lead's name (covers closes logged without / with a wrong email)
        const name = String(rec.lead || '').trim();
        if (name) {
          const arr = await searchContacts(name);
          if (!arr.__err) {
            const list = (arr || []).filter(c => c && c.id);
            if (list.length === 1) id = list[0].id; // unique name match -> use it
            else if (list.length > 1) return { ok: false, ambiguous: true, error: 'multiple GHL contacts match "' + name + '" - push with the exact contact link' };
          }
        }
      }
      if (!id) return { ok: false, error: 'no GHL contact found' + (rec.leadEmail ? ' for ' + rec.leadEmail : rec.lead ? ' matching "' + rec.lead + '"' : '') };
    }
    const m = n => '$' + Number(n || 0).toLocaleString('en-US'), lines = [];
    const add = (l, v) => { if (v !== undefined && v !== null && v !== '') lines.push(l + ': ' + v); };
    add('Type', rec.type === 'deal' ? 'Closed deal' : 'Post-call'); add('Source', rec.source); add('Outcome', rec.outcome); add('Product', rec.product);
    if (rec.cashCollected) add('Cash collected', m(rec.cashCollected)); if (rec.contractValue) add('Contract value', m(rec.contractValue));
    add('Closer', rec.rep); add('Setter', rec.setter); add('Call type', rec.callType); add('Call date', String(rec.date || '').slice(0, 10));
    // payment plan: close-day cash + any logged/scheduled payments on this deal (e.g. "5k today, 10k in 2 days")
    const usd = ss => { ss = String(ss || '').slice(0, 10); const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ss); return dm ? (+dm[2]) + '-' + (+dm[3]) + '-' + dm[1] : ss; };
    const payLines = [];
    if (rec.cashCollected) payLines.push(m(rec.cashCollected) + ' collected at close' + (rec.date ? ' (' + usd(rec.date) + ')' : ''));
    if (rec.type === 'deal' && rec.id) {
      try {
        const pr = await supa('records?select=data&type=eq.payment&data->>dealId=eq.' + encodeURIComponent(rec.id));
        if (pr.ok) {
          const latest = {};
          (await pr.json()).map(x => x.data).filter(Boolean).forEach(p => { const k = p.pid || p.id; if (!latest[k] || String(p.submittedAt || '') > String(latest[k].submittedAt || '')) latest[k] = p; });
          Object.values(latest).filter(p => !p.deleted).sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).forEach(p => {
            payLines.push(m(p.amount) + (p.method ? ' by ' + p.method : '') + ' - ' + (p.status === 'confirmed' ? 'confirmed' : 'expected') + (p.date ? ' ' + usd(p.date) : ''));
          });
        }
      } catch (e) { }
    }
    if (payLines.length > 1) { lines.push('Payment plan:'); payLines.forEach(l => lines.push('  - ' + l)); } // only when there's more than the close-day cash
    const body = 'Sales HQ ' + (rec.type === 'deal' ? 'closed deal' : 'post-call') + ' (' + new Date().toISOString().slice(0, 10) + ')\n' + lines.join('\n');
    await fetch(base + '/contacts/' + id + '/notes', { method: 'POST', headers: H, body: JSON.stringify({ body }) }).catch(() => { });
    if (rec.source) await fetch(base + '/contacts/' + id, { method: 'PUT', headers: H, body: JSON.stringify({ source: rec.source }) }).catch(() => { });
    const tsaTag = rec.type === 'deal' ? 'tsa - closed deal' : 'tsa - post-call'; // append (never replaces existing tags) so the marketer can filter TSA outcomes
    await fetch(base + '/contacts/' + id + '/tags' + (v2 ? '' : '/'), { method: 'POST', headers: H, body: JSON.stringify({ tags: [tsaTag] }) }).catch(() => { });
    return { ok: true, contactId: id };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// list a client's GHL pipelines + stages (for the Admin > GHL Mapping section). Token stays server-side; only ids/names return.
async function ghlPipelines(cfg) {
  if (!cfg || !cfg.ghlApiKey) return { ok: false, error: 'no GHL API key set for this client' };
  try {
    const key = String(cfg.ghlApiKey || ''), v2 = /^pit-/i.test(key), loc = String(cfg.ghlLocationId || '').trim();
    const H = v2 ? { Authorization: 'Bearer ' + key, Version: '2021-07-28' } : { Authorization: 'Bearer ' + key };
    if (v2 && !loc) return { ok: false, error: 'This is a v2 Private Integration token - set the Location ID on Integrations first.' };
    const url = v2 ? 'https://services.leadconnectorhq.com/opportunities/pipelines?locationId=' + encodeURIComponent(loc)
                   : 'https://rest.gohighlevel.com/v1/pipelines/';
    const r = await fetch(url, { headers: H });
    if (!r.ok) { const t = await r.text(); return { ok: false, error: 'GHL pipelines lookup failed (' + r.status + ') ' + t.slice(0, 140) }; }
    const j = await r.json().catch(() => ({}));
    const pipelines = (j.pipelines || []).map(p => ({ id: p.id, name: p.name, stages: (p.stages || []).map(st => ({ id: st.id, name: st.name })) }));
    return { ok: true, pipelines };
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
      // SCALING: the `records` table grows fastest from daily operational/log rows (a report per rep per
      // day + login/password events). Those only need a recent window in the app, so we cap them by the
      // indexed `submitted_at` column. Everything else - deals, payments, and ALL config (users, teams,
      // integrations, meta) - loads in FULL so money history, retention and settings are always complete.
      // A client can request the full history (e.g. an "all time" analytics view) with full:true / ?full=1.
      const WINDOW_DAYS = Number(process.env.RECORDS_WINDOW_DAYS || 180);
      const WINDOWED_TYPES = ['eod', 'sod', 'postcall', 'mgreod', 'login', 'pwchange', 'pwreset'];
      const wantFull = b.full === true || q.full === '1' || q.full === 'true';
      const cutoff = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
      // page every row matching an extra PostgREST filter (server caps each response at 1000 rows)
      const pageAll = async (extra) => {
        const PAGE = 1000, out = [];
        for (let from = 0; ; from += PAGE) {
          const r = await supa(`records?select=data&order=id.asc&${filter}${extra || ''}`, { headers: { 'Range-Unit': 'items', Range: `${from}-${from + PAGE - 1}` } });
          if (!r.ok) { const t = await r.text(); throw new Error('db ' + r.status + ' ' + t.slice(0, 160)); }
          const rows = await r.json();
          for (const x of rows) if (x && x.data) out.push(x.data);
          if (rows.length < PAGE || from > 500000) break;
        }
        return out;
      };
      try {
        if (wantFull) { // explicit full-history read (unbounded) for all-time views
          const out = await pageAll('');
          return res.status(200).json({ ok: true, ws, records: out, windowDays: null });
        }
        const inList = WINDOWED_TYPES.join(',');
        const [full, windowed] = await Promise.all([
          pageAll(`&type=not.in.(${inList})`),                                              // deals + payments + config, complete
          pageAll(`&type=in.(${inList})&submitted_at=gte.${encodeURIComponent(cutoff)}`),   // operational logs, recent window only
        ]);
        return res.status(200).json({ ok: true, ws, records: full.concat(windowed), windowDays: WINDOW_DAYS });
      } catch (e) { return res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
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
    // ---------- list a client's GHL pipelines + stages (Admin > GHL Mapping) ----------
    if (action === 'ghlPipelines') {
      if (s && !['admin', 'director'].includes(s.role)) return res.status(200).json({ ok: false, error: 'Admins only' });
      const client = String(b.client || q.client || '').trim();
      if (!client) return res.status(200).json({ ok: false, error: 'client required' });
      const cfg = await integrationFor(callerWs, client);
      if (!cfg || !cfg.ghlApiKey) return res.status(200).json({ ok: false, error: 'No GHL API key set for ' + client + ' - add it on Integrations > CRM push (GHL) first.' });
      const out = await ghlPipelines(cfg);
      return res.status(200).json(out);
    }
    // ---------- SEND a founder-invoice summary to the client's invoicing Slack channel (T-546) ----------
    if (action === 'sendInvoice') {
      if (s && !['admin', 'director'].includes(s.role)) return res.status(200).json({ ok: false, error: 'Admins only' });
      const client = String(b.client || '').trim();
      if (!client) return res.status(200).json({ ok: false, error: 'client required' });
      const cfg = await integrationFor(callerWs, client);
      if (!cfg || !cfg.invoicingSlack) return res.status(200).json({ ok: false, error: 'No invoicing channel connected for ' + client + '. Connect it on Integrations › Invoicing, then send.' });
      const usd = ss => { ss = String(ss || '').slice(0, 10); const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ss); return dm ? (+dm[2]) + '-' + (+dm[3]) + '-' + dm[1] : ss; };
      const period = (b.from ? usd(b.from) : '?') + ' to ' + (b.to ? usd(b.to) : '?');
      const rateDesc = b.rateDesc ? ' (' + String(b.rateDesc).slice(0, 80) + ')' : '';
      const body = `🧾 *Invoice · ${client}*\n*Period:* ${period}\n*Cash collected:* ${money(b.cash)}\n*Amount due (TSA):* ${money(b.amount)}${rateDesc}\n*Deals:* ${Number(b.deals || 0)}`;
      // 1) Preferred: attach the invoice PDF via the Slack file API (needs the bot token + channel_id captured at connect + files:write)
      let pdfErr = '';
      if (cfg.invoicingSlackBot && cfg.invoicingSlackChanId) {
        try {
          // prefer the exact-match PDF captured from the on-screen invoice; fall back to the server-built one
          const pdf = (b.pdfBase64 && String(b.pdfBase64).length > 100) ? Buffer.from(String(b.pdfBase64), 'base64') : invoicePdf({ client, from: b.from, to: b.to, cash: b.cash, amount: b.amount, rateDesc: b.rateDesc, deals: b.deals, remit: b.remit || {} });
          const fname = ('Invoice - ' + client + ' - ' + period).replace(/[^A-Za-z0-9 .\-]/g, '').replace(/\s+/g, ' ').slice(0, 80) + '.pdf';
          const up = await slackUploadFile(cfg.invoicingSlackBot, cfg.invoicingSlackChanId, fname, pdf, body);
          if (up.ok) return res.status(200).json({ ok: true, pdf: true });
          pdfErr = up.error || 'upload failed';
        } catch (e) { pdfErr = String((e && e.message) || e); }
      }
      // 2) Fallback: post the text summary via the incoming webhook (no file attach possible on a webhook)
      let posted = false, perr = '';
      try { const pr = await fetch(chanDest(cfg.invoicingSlack), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `Invoice · ${client} · ${money(b.amount)}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: body } }] }) }); posted = pr.ok; if (!pr.ok) perr = 'Slack returned ' + pr.status; }
      catch (e) { perr = String((e && e.message) || e); }
      if (!posted) return res.status(200).json({ ok: false, error: 'Could not post to the billing channel' + (perr ? ': ' + perr : '') + '. Reconnect it on Integrations › Invoicing.' });
      return res.status(200).json({ ok: true, pdf: false, pdfNote: pdfErr ? ('summary posted, but the PDF failed to attach: ' + pdfErr) : 'summary posted (reconnect the billing channel with file access to attach the PDF)' });
    }
    // ---------- ONE-SHOT MAINTENANCE: normalize whitespace in person-name fields (rep/setter/by/closer) ----------
    // Historical records inherited trailing/duplicate spaces from user names (e.g. "Carolina "), because auto-populate
    // stamps rep/by from the stored user name. We PATCH the row IN PLACE by its DB id so there is NO Slack/GHL side
    // effect and NO new row (the normal append+dedup path would double-count a deal or drop the fix). Admin only.
    // Pass dryRun:true to see exactly what WOULD change without writing.
    if (action === 'normalizeNames') {
      if (s && s.role !== 'admin') return res.status(200).json({ ok: false, error: 'Admins only' });
      const ws = callerWs;
      const filter = ws === DEFAULT_WS
        ? `or=(data->>ws.eq.${DEFAULT_WS},data->>ws.is.null)`
        : `data->>ws=eq.${encodeURIComponent(ws)}`;
      const dryRun = !!b.dryRun;
      const FIELDS = ['rep', 'setter', 'by', 'closer'];
      const norm = v => String(v).trim().replace(/\s+/g, ' ');
      const isDirty = v => typeof v === 'string' && v !== norm(v);
      const PAGE = 1000; let scanned = 0, changed = 0; const samples = [];
      for (let from = 0; ; from += PAGE) {
        const r = await supa(`records?select=id,data&order=id.asc&${filter}`, { headers: { 'Range-Unit': 'items', Range: `${from}-${from + PAGE - 1}` } });
        if (!r.ok) { const t = await r.text(); return res.status(200).json({ ok: false, error: 'db ' + r.status + ' ' + t.slice(0, 160) }); }
        const rows = await r.json();
        for (const row of rows) {
          scanned++;
          const d = row.data; if (!d || typeof d !== 'object') continue;
          let hit = false; const nd = Object.assign({}, d);
          for (const f of FIELDS) { if (isDirty(d[f])) { nd[f] = norm(d[f]); hit = true; } }
          if (!hit) continue;
          changed++;
          if (samples.length < 30) samples.push({ id: row.id, type: d.type, fix: FIELDS.filter(f => isDirty(d[f])).map(f => f + ': ' + JSON.stringify(d[f]) + ' -> ' + JSON.stringify(norm(d[f]))).join(', ') });
          if (!dryRun) {
            const pr = await supa('records?id=eq.' + encodeURIComponent(row.id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ data: nd }) });
            if (!pr.ok) { const t = await pr.text(); return res.status(200).json({ ok: false, error: 'patch id ' + row.id + ': ' + pr.status + ' ' + t.slice(0, 160), changedSoFar: changed - 1 }); }
          }
        }
        if (rows.length < PAGE || from > 500000) break;
      }
      return res.status(200).json({ ok: true, dryRun, scanned, changed, samples });
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
