// /api/slack-oauth — Slack OAuth redirect handler. When TSA Ninja is installed into a client
// workspace via the "Add to Slack" link, Slack redirects here with ?code=...; we exchange it for
// that workspace's bot token and store it in slack_workspaces (keyed by team_id). The admin then
// links the workspace to a client + digest channel in the dashboard.
//
// Env: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Slack app: add https://tsainvoice.vercel.app/api/slack-oauth as an OAuth Redirect URL.
import { supa } from './_lib.js';

export default async function handler(req, res) {
  const code = req.query && req.query.code;
  if (!code) return res.status(400).send('Missing ?code — start from the Add to Slack link.');
  const cid = process.env.SLACK_CLIENT_ID, cs = process.env.SLACK_CLIENT_SECRET;
  if (!cid || !cs) return res.status(200).send('SLACK_CLIENT_ID / SLACK_CLIENT_SECRET not set.');

  try {
    const params = new URLSearchParams({
      client_id: cid,
      client_secret: cs,
      code: String(code),
      redirect_uri: 'https://tsainvoice.vercel.app/api/slack-oauth',
    });
    const r = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const j = await r.json();
    if (!j.ok) return res.status(200).send('Install failed: ' + (j.error || 'unknown'));

    const team_id = j.team && j.team.id;
    const teamName = (j.team && j.team.name) || '';
    const bot_token = j.access_token; // xoxb- for this workspace
    if (!team_id || !bot_token) return res.status(200).send('Install returned no team/token.');

    // upsert: set the bot token (and workspace name as note); keep any existing client/digest_channel
    await supa('slack_workspaces?on_conflict=team_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ team_id, bot_token, note: teamName }),
    });

    res.writeHead(302, { Location: 'https://tsainvoice.vercel.app/?slack=installed' });
    res.end();
  } catch (e) {
    return res.status(200).send('Install error: ' + String(e));
  }
}
