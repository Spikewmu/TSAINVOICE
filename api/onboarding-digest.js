// /api/onboarding-digest — computes the "due & overdue" onboarding list across ALL clients
// and posts it to Slack (internal accountability digest). Runs daily via Vercel Cron, and can
// be triggered manually with ?key=<BOT_ADMIN_TOKEN> for testing.
//
// Posts AS the TSA Ninja bot when SLACK_BOT_TOKEN + DIGEST_CHANNEL are set (chat.postMessage);
// otherwise falls back to a plain SLACK_WEBHOOK_URL.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_ADMIN_TOKEN, (CRON_SECRET optional),
//      and either { SLACK_BOT_TOKEN + DIGEST_CHANNEL }  or  SLACK_WEBHOOK_URL
async function postToSlack(text) {
  const bot = process.env.SLACK_BOT_TOKEN, channel = process.env.DIGEST_CHANNEL;
  if (bot && channel) {
    const r = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bot }, body: JSON.stringify({ channel, text }) });
    const j = await r.json().catch(() => ({}));
    return { ok: !!j.ok, via: 'bot', error: j.error };
  }
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (webhook) { const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); return { ok: r.ok, via: 'webhook' }; }
  return { ok: false, error: 'no SLACK_BOT_TOKEN+DIGEST_CHANNEL or SLACK_WEBHOOK_URL set' };
}

const DEFAULT_STEPS = [
  { step: 'Contract + NDA signed', owner: 'Client', days: 0 },
  { step: 'Welcome sequence sent (email, intake, recruiting form, kickoff sheet, call link)', owner: 'Auto / Steve', days: 1 },
  { step: 'Added to HQ / dashboard (fires email sequence)', owner: 'Steve', days: 1 },
  { step: 'Client invites us to Slack as a member (not Connect)', owner: 'Client', days: 1 },
  { step: 'Slack channels created (standard set)', owner: 'Josh', days: 2 },
  { step: 'Welcome video dropped in sales-management', owner: 'Josh', days: 2 },
  { step: 'Onboarding call booked', owner: 'Client', days: 2 },
  { step: 'Intake form completed', owner: 'Client', days: 3 },
  { step: 'Recruiting form completed', owner: 'Client', days: 3 },
  { step: 'Drive access + credentials (viewer / password manager)', owner: 'Client', days: 3 },
  { step: 'Drive folder set up (template duplicated)', owner: 'Steve', days: 4 },
  { step: 'CRM / systems build', owner: 'Steve', days: 5 },
  { step: 'Sales assets + scripts', owner: 'Josh', days: 5 },
  { step: 'Kickoff call done', owner: 'Manager', days: 5 },
  { step: '$1 test wire cleared', owner: 'Client', days: 6 },
  { step: 'Reps onboarded + dialing', owner: 'Manager', days: 6 },
  { step: 'Launched', owner: 'Manager', days: 7 },
];

function todayISO() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + (Number(n) || 0)); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function daysLeft(due) { if (!due) return null; return Math.round((new Date(due + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000); }
function usDate(d) { d = (d || '').slice(0, 10); const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return m ? `${+m[2]}-${+m[3]}-${m[1]}` : d; }

async function supa(path) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!r.ok) throw new Error('supabase ' + r.status);
  return r.json();
}

async function stepsConfig() {
  try {
    const rows = await supa('records?type=eq.onbconfig&select=data&order=id.desc&limit=1');
    if (rows[0] && rows[0].data && rows[0].data.steps) {
      const a = JSON.parse(rows[0].data.steps);
      if (Array.isArray(a) && a.length && a.some((s) => s && s.days != null)) return a;
    }
  } catch (e) {}
  return DEFAULT_STEPS;
}

export default async function handler(req, res) {
  // auth: Vercel Cron (Authorization: Bearer CRON_SECRET) OR manual ?key=BOT_ADMIN_TOKEN
  const key = (req.query && req.query.key) || '';
  const authed =
    (process.env.BOT_ADMIN_TOKEN && key === process.env.BOT_ADMIN_TOKEN) ||
    (process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET);
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const [steps, clients, onboard] = await Promise.all([
      stepsConfig(),
      supa('records?type=eq.client&select=data,submitted_at&order=id.asc'),
      supa('records?type=eq.onboard&select=data,submitted_at&order=id.asc'),
    ]);
    // earliest client record = onboarding start
    const start = {};
    clients.forEach((r) => { const n = r.data && r.data.name; if (!n) return; if (!start[n] || (r.submitted_at || '') < start[n]) start[n] = (r.submitted_at || '').slice(0, 10); });
    // latest onboard status per client+step
    const latest = {};
    onboard.forEach((r) => { const d = r.data; const k = (d.client || '') + '|' + (d.step || ''); if (!latest[k] || (r.submitted_at || '') > (latest[k]._t || '')) latest[k] = { ...d, _t: r.submitted_at }; });

    const open = [];
    Object.keys(start).forEach((client) => {
      steps.forEach((s) => {
        const rec = latest[client + '|' + s.step];
        if (rec && rec.status === 'Done') return;
        const due = addDays(start[client], s.days);
        open.push({ client, step: s.step, owner: s.owner || '', due, dl: daysLeft(due) });
      });
    });
    open.sort((a, b) => (a.dl == null ? 9999 : a.dl) - (b.dl == null ? 9999 : b.dl));

    const overdue = open.filter((o) => o.dl != null && o.dl < 0);
    const today = open.filter((o) => o.dl === 0);
    const soon = open.filter((o) => o.dl != null && o.dl > 0).slice(0, 12);

    let text = `*Onboarding standup — ${usDate(todayISO())}*`;
    if (!open.length) {
      text += `\n:white_check_mark: All clients caught up, nothing open.`;
    } else {
      if (overdue.length) text += `\n\n:red_circle: *Overdue (${overdue.length})*\n` + overdue.map((o) => `• *${o.client}*: ${o.step} — ${o.owner} — ${-o.dl}d overdue (was due ${usDate(o.due)})`).join('\n');
      if (today.length) text += `\n\n:large_yellow_circle: *Due today (${today.length})*\n` + today.map((o) => `• *${o.client}*: ${o.step} — ${o.owner}`).join('\n');
      if (soon.length) text += `\n\n:white_circle: *Coming up*\n` + soon.map((o) => `• *${o.client}*: ${o.step} — ${o.owner} — ${o.dl}d left`).join('\n');
    }

    const posted = await postToSlack(text);
    return res.status(200).json({ ok: posted.ok, via: posted.via, error: posted.error, counts: { overdue: overdue.length, today: today.length, soon: soon.length, openTotal: open.length } });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
