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
  const S = (a, f) => a.reduce((s, x) => s + num(x[f]), 0);
  const pct = n => n == null ? '—' : Math.round(n * 100) + '%';
  const b = s => ' • ' + s; // one metric per line (stacked), no emoji, plain text
  const L = [`${client} — Daily Report`];

  // SETTERS first: yesterday's activity, then today's commitment
  if (fSet.length || rSet.length) {
    L.push('SETTERS', '', `Yesterday (${usDate(prev)})`);
    L.push(b(`${S(rSet, 'newOutreach')} dials`));
    L.push(b(`${S(rSet, 'connectedCalls')} connects`));
    L.push(b(`${S(rSet, 'callsSet')} sets`));
    L.push('', `Today (${usDate(day)})`);
    L.push(b(`${S(fSet, 'sodSetTotal')} sets committed`));
    L.push(b(`same-day ${S(fSet, 'sodSameDay')} · 24h ${S(fSet, 'sod24')} · 48h ${S(fSet, 'sod48')} · 72h ${S(fSet, 'sod72')}`));
  }

  // CLOSERS below: yesterday's results, then today's forecast
  if (fClo.length || rClo.length) {
    const taken = S(rClo, 'connectedMeetings'), noShow = S(rClo, 'noShows'), held = S(rClo, 'newMeetings') + S(rClo, 'followUpMeetings'), spots = S(rClo, 'callCapacity');
    const show = (taken + noShow) ? taken / (taken + noShow) : null, util = spots ? held / spots : null;
    L.push('', 'CLOSERS', '', `Yesterday (${usDate(prev)})`);
    L.push(b(`${taken} calls taken`));
    L.push(b(`${pct(show)} show rate`));
    L.push(b(`${pct(util)} call utilization`));
    L.push(b(`${S(rClo, 'closedDeals')} closes`));
    L.push(b(`${money(S(rClo, 'cashCollected'))} cash`));
    L.push('', `Today (${usDate(day)})`);
    L.push(b(`${S(fClo, 'sodCallsToday')} on the calendar`));
    L.push(b(`${S(fClo, 'sodConfirmed')} confirmed`));
    L.push(b(`projecting ${S(fClo, 'sodProjClose')} closes / ${money(S(fClo, 'sodProjCollectWk'))}`));
  }

  if (!fClo.length && !rClo.length && !fSet.length && !rSet.length) L.push('', 'No SOD or EOD data logged.');
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
    const day = iso(ctParts(0)), prev = iso(prevBiz(ctParts(0)));
    // current Central time, floored to a 30-min slot (matches the UI's 30-min send-time steps)
    const ctNow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const slot = hm => { const p = String(hm || '09:30').split(':'); const h = +p[0] || 0, mi = +p[1] || 0; return String(h).padStart(2, '0') + ':' + (mi >= 30 ? '30' : '00'); };
    const curSlot = slot(ctNow);
    // latest integration config per key (order by db submitted_at, first per key wins)
    const cfgRows = (await (await supa('records?select=data&data->>type=eq.integration&order=submitted_at.desc')).json()).map(x => x.data);
    const latest = {}; cfgRows.forEach(x => { if (x && x.key && !latest[x.key]) latest[x.key] = x; });
    const targets = Object.values(latest).filter(c => c.dailyReportOn && c.dailyReportSlack && c.client && (manual || slot(c.dailyReportTime || '09:30') === curSlot));

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
