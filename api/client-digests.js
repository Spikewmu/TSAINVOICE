// /api/client-digests — posts each client their OWN onboarding digest into their OWN Slack
// workspace, using that workspace's bot token. Fully isolated: a workspace only ever gets its
// linked client's data. Runs daily via Vercel Cron; manual test with ?key=<BOT_ADMIN_TOKEN>.
//
// Only workspaces with all three of { client, bot_token, digest_channel } are posted to.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_ADMIN_TOKEN, (CRON_SECRET optional)
import { supaJson, clientOpenSteps, usDate, todayISO, slackPost } from './_lib.js';

function buildMessage(client, done, total, open) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  let text = `*${client} — onboarding update (${usDate(todayISO())})*\n${done}/${total} steps done (${pct}%).`;
  if (!open.length) { text += `\n:tada: Everything is complete.`; return text; }
  const overdue = open.filter((o) => o.dl != null && o.dl < 0);
  const upcoming = open.filter((o) => !(o.dl != null && o.dl < 0)).slice(0, 6);
  if (overdue.length) text += `\n\n*Needs attention (${overdue.length}):*\n` + overdue.map((o) => `• ${o.step} (${o.owner}) — was due ${usDate(o.due)}`).join('\n');
  if (upcoming.length) text += `\n\n*Coming up:*\n` + upcoming.map((o) => { const tag = o.dl == null ? '' : o.dl === 0 ? ' — due today' : ` — ${o.dl}d left`; return `• ${o.step} (${o.owner})${tag}`; }).join('\n');
  return text;
}

export default async function handler(req, res) {
  const key = (req.query && req.query.key) || '';
  const authed =
    (process.env.BOT_ADMIN_TOKEN && key === process.env.BOT_ADMIN_TOKEN) ||
    (process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET);
  if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const rows = await supaJson('slack_workspaces?select=team_id,client,bot_token,digest_channel');
    const targets = rows.filter((r) => r.client && r.bot_token && r.digest_channel);
    const results = [];
    for (const t of targets) {
      try {
        const { done, total, open } = await clientOpenSteps(t.client); // scoped to this client only
        const text = buildMessage(t.client, done, total, open);
        const resp = await slackPost(t.bot_token, t.digest_channel, text);
        results.push({ client: t.client, team_id: t.team_id, ok: !!resp.ok, error: resp.error });
      } catch (e) {
        results.push({ client: t.client, team_id: t.team_id, ok: false, error: String(e) });
      }
    }
    return res.status(200).json({ ok: true, posted: results.filter((r) => r.ok).length, skipped: rows.length - targets.length, results });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
