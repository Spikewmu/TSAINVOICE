// /api/onboarding-signoff — called when someone completes an onboarding step. Posts the sign-off
// AND the handoff: names + pings whoever owns the NEXT step in the sequence so they know they're up.
//
// Pings use OWNER_SLACK_IDS (a JSON map of person name -> Slack user id), e.g.
//   {"Steve":"U0123","Josh":"U0456","Khadija":"U0789","Ra-eez":"U0ABC"}
// If an owner isn't mapped (or is "Client"), it just shows the name, no ping.
//
// Env: SESSION_SECRET, SLACK_BOT_TOKEN, SIGNOFF_CHANNEL|DIGEST_CHANNEL, SUPABASE_URL, SUPABASE_SERVICE_KEY, OWNER_SLACK_IDS
import { verifyToken, supaJson, stepsConfig, addDays, daysLeft, usDate, q, slackPost } from './_lib.js';

function ownerMap() { try { return JSON.parse(process.env.OWNER_SLACK_IDS || '{}'); } catch (e) { return {}; } }
// return "<@Uxxx>" if any mapped name appears in the owner string; else the plain owner text
function pingFor(owner) {
  const o = String(owner || '');
  if (/client/i.test(o)) return o; // external, don't ping in the internal channel
  const map = ownerMap();
  for (const name of Object.keys(map)) { if (map[name] && o.toLowerCase().includes(name.toLowerCase())) return `<@${map[name]}>`; }
  return o;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  if (!verifyToken(body.token)) return res.status(200).json({ ok: false, error: 'unauthorized' });

  const client = String(body.client || '').trim();
  const step = String(body.step || '').trim();
  const by = String(body.by || 'a teammate');
  const note = String(body.note || '').trim();
  if (!client || !step) return res.status(400).json({ ok: false, error: 'client and step required' });

  try {
    const [steps, clientRows, onboardRows] = await Promise.all([
      stepsConfig(),
      supaJson(`records?type=eq.client&data->>name=eq.${q(client)}&select=submitted_at&order=id.asc`),
      supaJson(`records?type=eq.onboard&data->>client=eq.${q(client)}&select=data,submitted_at&order=id.asc`),
    ]);
    const start = clientRows[0] ? clientRows[0].submitted_at.slice(0, 10) : null;
    const latest = {};
    onboardRows.forEach((r) => { const d = r.data, k = d.step; if (!latest[k] || (r.submitted_at || '') > (latest[k]._t || '')) latest[k] = { ...d, _t: r.submitted_at }; });

    // next step = first NOT-done step in canonical order
    let next = null, done = 0;
    for (const s of steps) {
      const rec = latest[s.step];
      if (rec && rec.status === 'Done') { done++; continue; }
      if (!next) next = s;
    }

    let text = `:white_check_mark: *${client}* — ${step}\nCompleted by ${by} (${usDate(new Date().toISOString())})`;
    if (note) text += `\n> ${note}`;
    if (next) {
      const due = start != null ? addDays(start, next.days) : null;
      const dl = daysLeft(due);
      const dueTag = dl == null ? '' : dl < 0 ? ` (${-dl}d overdue)` : dl === 0 ? ' (due today)' : ` (${dl}d left)`;
      text += `\n\n:arrow_right: *Next up:* ${next.step} — ${pingFor(next.owner)}${dueTag}, you're up. (${done}/${steps.length} done)`;
    } else {
      text += `\n\n:tada: That was the last step — *${client}* onboarding is complete!`;
    }

    const channel = process.env.SIGNOFF_CHANNEL || process.env.DIGEST_CHANNEL;
    const resp = await slackPost(process.env.SLACK_BOT_TOKEN, channel, text);
    return res.status(200).json({ ok: !!resp.ok, error: resp.error, next: next ? next.step : null });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
