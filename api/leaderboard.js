// /api/leaderboard - each day, post each offer's MONTH-TO-DATE leaderboard to that offer's leadership Slack channel.
// Closers ranked by cash (cash, deals, close %); Setters (dials, sets, cash). Mirrors the dashboard leaderboard
// money model (countsMoney = deals + confirmed payments, NOT EODs; dials/sets/close% from EODs).
// Only offers with { leaderboardOn: true, leaderboardSlack: <webhook> } post, gated on the Central-time slot.
// Runs via Vercel Cron; manual test with ?key=<BOT_ADMIN_TOKEN>. Env: SUPABASE_*, BOT_ADMIN_TOKEN, CRON_SECRET.

async function supa(path) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' } });
}
const enc = s => encodeURIComponent(String(s == null ? '' : s));
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
const money = n => '$' + Number(n || 0).toLocaleString('en-US');
const pct = n => n == null ? '-' : Math.round(n * 100) + '%';

// Central-time month start (yyyy-mm-01) and a readable month label
function ctMonth() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const y = +p.find(x => x.type === 'year').value, m = +p.find(x => x.type === 'month').value;
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return { start, label: `${label} ${y}` };
}

function buildBoard(client, monthLabel, recs) {
  const byRep = {};
  const bucket = (name, role) => { const k = name + '|' + role; if (!byRep[k]) byRep[k] = { rep: name, role, cash: 0, deals: 0, connected: 0, set: 0, dials: 0 }; return byRep[k]; };
  recs.forEach(x => {
    const rep = String(x.rep || '').trim(), setter = String(x.setter || '').trim();
    const isMoney = x.type !== 'eod' && x.type !== 'mgreod'; // countsMoney: deals + payments, not EODs
    if (rep) {
      const b = bucket(rep, x.role || 'Closer');
      if (isMoney) { b.cash += num(x.cashCollected); b.deals += num(x.closedDeals); }
      if (x.role !== 'Setter') b.connected += num(x.connectedMeetings);
      b.set += num(x.callsSet);
      if (x.role === 'Setter') b.dials += num(x.newOutreach);
    }
    if (isMoney && setter) { const s = bucket(setter, 'Setter'); s.cash += num(x.cashCollected); s.deals += num(x.closedDeals); }
  });
  const all = Object.values(byRep);
  const closers = all.filter(o => o.role !== 'Setter').map(o => ({ ...o, closeRate: o.connected ? o.deals / o.connected : null })).sort((a, b) => b.cash - a.cash || b.deals - a.deals);
  const setters = all.filter(o => o.role === 'Setter').sort((a, b) => b.cash - a.cash || b.dials - a.dials); // dashboard sorts setters by cash

  const L = [`${client} - Leaderboard`, `${monthLabel} month-to-date`, ''];
  L.push('*CLOSERS* (by cash collected)');
  if (closers.length) closers.forEach((r, i) => L.push(`${i + 1}. ${r.rep} - ${money(r.cash)} · ${r.deals} deal${r.deals === 1 ? '' : 's'} · ${pct(r.closeRate)} close`));
  else L.push(' • No closer data yet.');
  L.push('', '*SETTERS* (dials / sets / cash)');
  if (setters.length) setters.forEach((r, i) => L.push(`${i + 1}. ${r.rep} - ${r.dials} dials · ${r.set} sets · ${money(r.cash)}`));
  else L.push(' • No setter data yet.');
  return L.join('\n');
}

export default async function handler(req, res) {
  const key = (req.query && req.query.key) || '';
  const authed =
    (process.env.BOT_ADMIN_TOKEN && key === process.env.BOT_ADMIN_TOKEN) ||
    (process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET);
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const manual = !!(process.env.BOT_ADMIN_TOKEN && key === process.env.BOT_ADMIN_TOKEN); // ?key= run: post now, ignore the time gate
    const { start, label } = ctMonth();
    const ctNow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const slot = hm => { const p = String(hm || '10:00').split(':'); const h = +p[0] || 0, mi = +p[1] || 0; return String(h).padStart(2, '0') + ':' + (mi >= 30 ? '30' : '00'); };
    const curSlot = slot(ctNow);
    const cfgRows = (await (await supa('records?select=data&data->>type=eq.integration&order=submitted_at.desc')).json()).map(x => x.data);
    const latest = {}; cfgRows.forEach(x => { if (x && x.key && !latest[x.key]) latest[x.key] = x; });
    const targets = Object.values(latest).filter(c => c.leaderboardSlack && c.client && (manual || slot(c.leaderboardTime || '10:00') === curSlot)); // channel selected = on (no separate toggle)

    const results = [];
    for (const t of targets) {
      try {
        const rows = (await (await supa(`records?select=data&data->>client=eq.${enc(t.client)}&data->>type=in.(eod,deal,payment)&data->>date=gte.${enc(start)}`)).json()).map(x => x.data);
        // collapse payments by pid (latest wins), keep confirmed + not deleted, map amount -> cashCollected
        const recs = [], pmap = {};
        rows.forEach(d => {
          if (d.type === 'payment') { const k = d.pid || d.id; if (!pmap[k] || (d.submittedAt || '') > (pmap[k].submittedAt || '')) pmap[k] = d; }
          else recs.push(d);
        });
        Object.values(pmap).forEach(p => { if (p.status === 'confirmed' && !p.deleted) recs.push({ type: 'payment', role: 'Closer', client: p.client, rep: p.rep, setter: p.setter || '', date: p.date, cashCollected: num(p.amount), closedDeals: 0 }); });
        if (!recs.length) { results.push({ client: t.client, skipped: 'no data' }); continue; }
        const text = buildBoard(t.client, label, recs);
        const dest = t.leaderboardSlack === '__default__' ? (t.botChanId || '') : t.leaderboardSlack;
        if (!dest) { results.push({ client: t.client, skipped: 'no channel' }); continue; }
        let ok = false, info = 0;
        if (/^https?:\/\//i.test(dest)) { const r = await fetch(dest, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); ok = r.ok; info = r.status; }
        else if (t.botToken) {
          await fetch('https://slack.com/api/conversations.join', { method: 'POST', headers: { Authorization: 'Bearer ' + t.botToken, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ channel: dest }) }).catch(() => {});
          const br = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: 'Bearer ' + t.botToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: dest, text }) }); const bj = await br.json(); ok = !!bj.ok; info = bj.error || '';
        }
        results.push({ client: t.client, ok, status: info });
      } catch (e) {
        results.push({ client: t.client, ok: false, error: String(e) });
      }
    }
    return res.status(200).json({ ok: true, month: start, posted: results.filter(r => r.ok).length, targets: targets.length, results });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
