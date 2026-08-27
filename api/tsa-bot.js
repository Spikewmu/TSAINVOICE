// /api/tsa-bot — Slack slash-command bot for TSA.
//
// MULTI-TENANT ISOLATION (the whole point):
//   The bot is installed in each client's Slack workspace. Slack signs every
//   request with the workspace's team_id. We map team_id -> exactly ONE client
//   (slack_workspaces table) and hard-filter EVERY query to that client. There
//   is no code path that returns another client's data. An unmapped workspace
//   gets nothing but a "not linked" message that surfaces its team_id so an
//   admin can add the mapping.
//
// Env vars (Vercel → Settings → Environment Variables):
//   SLACK_SIGNING_SECRET   - from the Slack app's Basic Information page
//   SUPABASE_URL           - https://wiwmogfurmdwrjndsuct.supabase.co
//   SUPABASE_SERVICE_KEY   - Supabase service_role key (server-side only, never shipped to the client)
//
// Slack app setup: create a Slash Command "/tsa" with Request URL
//   https://tsainvoice.vercel.app/api/tsa-bot  (see the setup notes handed over separately)

import crypto from 'crypto';

export const config = { api: { bodyParser: false } }; // we need the raw body to verify Slack's signature

function readRaw(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

// Slack request signing: https://api.slack.com/authentication/verifying-requests-from-slack
function verifySlack(rawBody, headers, secret) {
  const ts = headers['x-slack-request-timestamp'];
  const sig = headers['x-slack-signature'];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // >5 min old → reject replay
  const base = `v0:${ts}:${rawBody}`;
  const mine = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
  } catch (e) {
    return false;
  }
}

function parseForm(raw) {
  const out = {};
  new URLSearchParams(raw).forEach((v, k) => (out[k] = v));
  return out;
}

async function supa(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(url + '/rest/v1/' + path, {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  if (!r.ok) throw new Error('supabase ' + r.status);
  return r.json();
}
// PostgREST filter value, double-quoted so names with spaces/parens/commas (e.g. "Prime (Billy)") are literal
function q(v) {
  return encodeURIComponent('"' + String(v).replace(/"/g, '\\"') + '"');
}

function ephemeral(text) {
  return { response_type: 'ephemeral', text };
}

// ---- date helpers (mirror the dashboard) ----
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + (Number(n) || 0));
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function daysLeft(due) {
  if (!due) return null;
  return Math.round((new Date(due + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000);
}
function usDate(d) {
  d = (d || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${+m[2]}-${+m[3]}-${m[1]}` : d;
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

async function stepsConfig() {
  try {
    const rows = await supa('records?type=eq.onbconfig&select=data,submitted_at&order=id.desc&limit=1');
    if (rows[0] && rows[0].data && rows[0].data.steps) {
      const a = JSON.parse(rows[0].data.steps);
      if (Array.isArray(a) && a.length && a.some((s) => s && s.days != null)) return a;
    }
  } catch (e) {}
  return DEFAULT_STEPS;
}

// ---- commands (ALWAYS scoped to `client`) ----
async function cmdStatus(client) {
  // records for THIS client only
  const [steps, clientRows, onboardRows] = await Promise.all([
    stepsConfig(),
    supa(`records?type=eq.client&data->>name=eq.${q(client)}&select=submitted_at&order=id.asc`),
    supa(`records?type=eq.onboard&data->>client=eq.${q(client)}&select=data,submitted_at&order=id.asc`),
  ]);
  const start = clientRows[0] ? clientRows[0].submitted_at.slice(0, 10) : null;
  // latest onboard record per step
  const latest = {};
  onboardRows.forEach((r) => {
    const d = r.data, k = d.step;
    if (!latest[k] || (r.submitted_at || '') > (latest[k].submitted_at || '')) latest[k] = { ...d, submitted_at: r.submitted_at };
  });
  let done = 0;
  const open = [];
  steps.forEach((s) => {
    const rec = latest[s.step];
    if (rec && rec.status === 'Done') { done++; return; }
    const due = start != null ? addDays(start, s.days) : null;
    open.push({ step: s.step, owner: s.owner || '', due, dl: daysLeft(due) });
  });
  open.sort((a, b) => (a.dl == null ? 9999 : a.dl) - (b.dl == null ? 9999 : b.dl));
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  let text = `*${client} — onboarding: ${done}/${steps.length} done (${pct}%)*`;
  if (!open.length) { text += `\n:tada: Everything is complete.`; return ephemeral(text); }
  const overdue = open.filter((o) => o.dl != null && o.dl < 0);
  if (overdue.length) {
    text += `\n\n*Overdue (${overdue.length}):*\n` + overdue.map((o) => `• ${o.step} (${o.owner}) — ${-o.dl}d overdue, was due ${usDate(o.due)}`).join('\n');
  }
  const upcoming = open.filter((o) => !(o.dl != null && o.dl < 0)).slice(0, 5);
  if (upcoming.length) {
    text += `\n\n*Next up:*\n` + upcoming.map((o) => {
      const tag = o.dl == null ? 'no date' : o.dl === 0 ? 'due today' : `${o.dl}d left`;
      return `• ${o.step} (${o.owner}) — ${tag}`;
    }).join('\n');
  }
  return ephemeral(text);
}

async function cmdNumbers(client) {
  const month = todayISO().slice(0, 7);
  const deals = await supa(`records?type=eq.deal&data->>client=eq.${q(client)}&select=data`);
  const mdeals = deals.filter((r) => (r.data.date || '').slice(0, 7) === month);
  const cash = mdeals.reduce((s, r) => s + (Number(r.data.cashCollected) || 0), 0);
  const contract = mdeals.reduce((s, r) => s + (Number(r.data.contractValue) || 0), 0);
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  return ephemeral(
    `*${client} — this month (${usDate(month + '-01').slice(0, -5)}):*\n` +
    `• Deals closed: ${mdeals.length}\n• Cash collected: ${money(cash)}\n• Contract value: ${money(contract)}`
  );
}

function cmdHelp(client) {
  return ephemeral(
    `*TSA bot* — I only ever share info for *${client}* in this workspace.\n` +
    `• \`/tsa status\` — onboarding progress + what's overdue / next\n` +
    `• \`/tsa numbers\` — this month's closed deals and cash\n` +
    `• \`/tsa help\` — this message`
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const raw = await readRaw(req);
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !verifySlack(raw, req.headers, secret)) {
    return res.status(401).send('bad signature');
  }

  const body = parseForm(raw);
  const teamId = body.team_id || '';

  // Resolve the workspace to exactly one client. This is the isolation boundary.
  let client = null;
  try {
    const rows = await supa(`slack_workspaces?team_id=eq.${encodeURIComponent(teamId)}&select=client&limit=1`);
    if (rows[0]) client = rows[0].client;
  } catch (e) {
    return res.status(200).json(ephemeral('Bot backend error. Try again shortly.'));
  }

  if (!client) {
    return res.status(200).json(
      ephemeral(
        `This Slack workspace is not linked to a TSA client yet, so I can't share anything.\n` +
        `Ask your TSA admin to link workspace \`${teamId}\`.`
      )
    );
  }

  const text = (body.text || '').trim().toLowerCase();
  const sub = text.split(/\s+/)[0] || 'help';

  try {
    let out;
    if (sub === 'status') out = await cmdStatus(client);
    else if (sub === 'numbers' || sub === 'sales') out = await cmdNumbers(client);
    else out = cmdHelp(client);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json(ephemeral('Could not pull that right now. Try again in a moment.'));
  }
}
