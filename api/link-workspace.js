// /api/link-workspace — admin-only management of the Slack team_id -> client map.
// Gated by BOT_ADMIN_TOKEN (a single secret an admin enters once in the dashboard's
// Settings → Slack panel). Uses the Supabase service key so it can read/write the
// slack_workspaces table (which is not anon-accessible).
//
// Env vars: BOT_ADMIN_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// Body (JSON): { token, action: 'list' | 'add' | 'remove', team_id?, client?, note? }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const secret = process.env.BOT_ADMIN_TOKEN;
  if (!secret) return res.status(200).json({ ok: false, error: 'BOT_ADMIN_TOKEN not set on the server' });
  if (body.token !== secret) return res.status(403).json({ ok: false, error: 'unauthorized' });

  const SUPA = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPA || !KEY) return res.status(200).json({ ok: false, error: 'Supabase env vars not set' });
  const h = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
    if (body.action === 'list') {
      const r = await fetch(SUPA + '/rest/v1/slack_workspaces?select=team_id,client,note,digest_channel,bot_token&order=client.asc', { headers: h });
      if (!r.ok) return res.status(200).json({ ok: false, error: 'read ' + r.status });
      const rows = (await r.json()).map((x) => ({ team_id: x.team_id, client: x.client, note: x.note, digest_channel: x.digest_channel, hasToken: !!x.bot_token })); // never expose the token to the client
      return res.status(200).json({ ok: true, rows });
    }

    if (body.action === 'add') {
      const team_id = String(body.team_id || '').trim();
      const client = String(body.client || '').trim();
      if (!team_id || !client) return res.status(400).json({ ok: false, error: 'team_id and client are required' });
      const row = { team_id, client, note: String(body.note || '').trim() };
      if (body.digest_channel !== undefined) row.digest_channel = String(body.digest_channel || '').trim();
      const r = await fetch(SUPA + '/rest/v1/slack_workspaces?on_conflict=team_id', {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
      return res.status(200).json({ ok: r.ok, error: r.ok ? undefined : 'write ' + r.status });
    }

    if (body.action === 'remove') {
      const team_id = String(body.team_id || '').trim();
      if (!team_id) return res.status(400).json({ ok: false, error: 'team_id required' });
      const r = await fetch(SUPA + '/rest/v1/slack_workspaces?team_id=eq.' + encodeURIComponent(team_id), { method: 'DELETE', headers: h });
      return res.status(200).json({ ok: r.ok });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
