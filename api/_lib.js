// Shared helpers for the Vercel API functions (files prefixed with _ are not routes).
import crypto from 'crypto';

export const DEFAULT_STEPS = [
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

export function todayISO() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
export function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + (Number(n) || 0)); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
export function daysLeft(due) { if (!due) return null; return Math.round((new Date(due + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000); }
export function usDate(d) { d = (d || '').slice(0, 10); const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return m ? `${+m[2]}-${+m[3]}-${m[1]}` : d; }
export const q = (v) => encodeURIComponent(String(v));

export async function supa(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(opts && opts.headers) },
  });
  return r;
}
export async function supaJson(path) { const r = await supa(path); if (!r.ok) throw new Error('supabase ' + r.status); return r.json(); }

export async function stepsConfig() {
  try {
    const rows = await supaJson('records?type=eq.onbconfig&select=data&order=id.desc&limit=1');
    if (rows[0] && rows[0].data && rows[0].data.steps) {
      const a = JSON.parse(rows[0].data.steps);
      if (Array.isArray(a) && a.length && a.some((s) => s && s.days != null)) return a;
    }
  } catch (e) {}
  return DEFAULT_STEPS;
}

// Open (not-done) onboarding steps for ONE client, with due dates. Always scoped to that client.
export async function clientOpenSteps(client) {
  const [steps, clientRows, onboardRows] = await Promise.all([
    stepsConfig(),
    supaJson(`records?type=eq.client&data->>name=eq.${q(client)}&select=submitted_at&order=id.asc`),
    supaJson(`records?type=eq.onboard&data->>client=eq.${q(client)}&select=data,submitted_at&order=id.asc`),
  ]);
  const start = clientRows[0] ? clientRows[0].submitted_at.slice(0, 10) : null;
  const latest = {};
  onboardRows.forEach((r) => { const d = r.data, k = d.step; if (!latest[k] || (r.submitted_at || '') > (latest[k]._t || '')) latest[k] = { ...d, _t: r.submitted_at }; });
  let done = 0; const open = [];
  steps.forEach((s) => {
    const rec = latest[s.step];
    if (rec && rec.status === 'Done') { done++; return; }
    const due = start != null ? addDays(start, s.days) : null;
    open.push({ step: s.step, owner: s.owner || '', due, dl: daysLeft(due) });
  });
  open.sort((a, b) => (a.dl == null ? 9999 : a.dl) - (b.dl == null ? 9999 : b.dl));
  return { done, total: steps.length, open };
}

export function verifyToken(token) {
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

export async function slackPost(botToken, channel, text) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + botToken },
    body: JSON.stringify({ channel, text }),
  });
  return r.json().catch(() => ({ ok: false }));
}
