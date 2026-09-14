// /api/daily-report — each morning, compile every offer's SOD forecast (today) + prior-day EOD results
// into ONE report and post it to that offer's configured Daily-report Slack webhook.
// Only offers with { dailyReportOn: true, dailyReportSlack: <webhook> } are posted.
// Runs via Vercel Cron; manual test with ?key=<BOT_ADMIN_TOKEN>.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_ADMIN_TOKEN, (CRON_SECRET set by Vercel Cron)

async function supa(path) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' } });
}
const enc = s => encodeURIComponent(String(s == null ? '' : s));
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
const money = n => '$' + Number(n || 0).toLocaleString('en-US');
const sum = (a, f) => a.reduce((s, o) => s + (o[f] || 0), 0);

// Central-time calendar dates (today, and the prior business day)
function ctParts(offsetDays) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const y = +p.find(x => x.type === 'year').value, m = +p.find(x => x.type === 'month').value, d = +p.find(x => x.type === 'day').value;
  const base = new Date(Date.UTC(y, m - 1, d)); base.setUTCDate(base.getUTCDate() + (offsetDays || 0)); return base;
}
const iso = d => d.toISOString().slice(0, 10);
function prevBiz(d) { const x = new Date(d); do { x.setUTCDate(x.getUTCDate() - 1); } while (x.getUTCDay() === 0 || x.getUTCDay() === 6); return x; }
function usDate(isoStr) { const p = String(isoStr || '').slice(0, 10).split('-'); return p.length === 3 ? (Number(p[1]) + '-' + Number(p[2]) + '-' + p[0]) : isoStr; }

// latest record per rep+role for a list
function latestByRep(list) {
  const m = {};
  list.forEach(x => { const k = String(x.rep || '').trim().toLowerCase() + '|' + (x.role || ''); if (!m[k] || (x.submittedAt || '') > (m[k].submittedAt || '')) m[k] = x; });
  return Object.values(m);
}

function buildText(client, day, prev, sods, eods) {
  const fSet = sods.filter(x => x.role === 'Setter'), fClo = sods.filter(x => x.role !== 'Setter');
  const rSet = eods.filter(x => x.role === 'Setter'), rClo = eods.filter(x => x.role !== 'Setter');
  const map = (a, fn) => a.map(fn);
  const L = [`*${client} — Daily Report*`, `_Yesterday (${usDate(prev)})_`];
  if (rClo.length) L.push(`Closers: ${sum(map(rClo, x => ({ v: num(x.connectedMeetings) })), 'v')} calls taken, ${sum(map(rClo, x => ({ v: num(x.closedDeals) })), 'v')} closes, ${money(sum(map(rClo, x => ({ v: num(x.cashCollected) })), 'v'))} cash`);
  if (rSet.length) L.push(`Setters: ${sum(map(rSet, x => ({ v: num(x.newOutreach) })), 'v')} dials, ${sum(map(rSet, x => ({ v: num(x.connectedCalls) })), 'v')} connects, ${sum(map(rSet, x => ({ v: num(x.callsSet) })), 'v')} sets`);
  if (!rClo.length && !rSet.length) L.push('No EODs logged.');
  L.push(`*Today (${usDate(day)}) forecast*`);
  if (fClo.length) L.push(`Closers: ${sum(map(fClo, x => ({ v: num(x.sodCallsToday) })), 'v')} calls on calendar, ${sum(map(fClo, x => ({ v: num(x.sodConfirmed) })), 'v')} confirmed, ${sum(map(fClo, x => ({ v: num(x.sodProjClose) })), 'v')} projected closes, ${money(sum(map(fClo, x => ({ v: num(x.sodProjCollectWk) })), 'v'))} projected cash`);
  if (fSet.length) L.push(`Setters: ${sum(map(fSet, x => ({ v: num(x.sodSetTotal) })), 'v')} sets committed (same-day ${sum(map(fSet, x => ({ v: num(x.sodSameDay) })), 'v')} / 24h ${sum(map(fSet, x => ({ v: num(x.sod24) })), 'v')} / 48h ${sum(map(fSet, x => ({ v: num(x.sod48) })), 'v')} / 72h ${sum(map(fSet, x => ({ v: num(x.sod72) })), 'v')})`);
  if (!fClo.length && !fSet.length) L.push('No SODs submitted yet.');
  return L.join('\n');
}

export default async function handler(req, res) {
  const key = (req.query && req.query.key) || '';
  const authed =
    (process.env.BOT_ADMIN_TOKEN && key === process.env.BOT_ADMIN_TOKEN) ||
    (process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET);
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const day = iso(ctParts(0)), prev = iso(prevBiz(ctParts(0)));
    // latest integration config per key (order by db submitted_at, first per key wins)
    const cfgRows = (await (await supa('records?select=data&data->>type=eq.integration&order=submitted_at.desc')).json()).map(x => x.data);
    const latest = {}; cfgRows.forEach(x => { if (x && x.key && !latest[x.key]) latest[x.key] = x; });
    const targets = Object.values(latest).filter(c => c.dailyReportOn && c.dailyReportSlack && c.client);

    const results = [];
    for (const t of targets) {
      try {
        const sods = latestByRep((await (await supa(`records?select=data&data->>type=eq.sod&data->>date=eq.${enc(day)}&data->>client=eq.${enc(t.client)}`)).json()).map(x => x.data));
        const eods = latestByRep((await (await supa(`records?select=data&data->>type=eq.eod&data->>date=eq.${enc(prev)}&data->>client=eq.${enc(t.client)}`)).json()).map(x => x.data));
        if (!sods.length && !eods.length) { results.push({ client: t.client, skipped: 'no data' }); continue; }
        const text = buildText(t.client, day, prev, sods, eods);
        const r = await fetch(t.dailyReportSlack, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        results.push({ client: t.client, ok: r.ok, status: r.status });
      } catch (e) {
        results.push({ client: t.client, ok: false, error: String(e) });
      }
    }
    return res.status(200).json({ ok: true, day, prev, posted: results.filter(r => r.ok).length, targets: targets.length, results });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
