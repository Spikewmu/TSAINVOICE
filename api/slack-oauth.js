// /api/slack-oauth — Slack OAuth callback for "Connect Slack channel".
// The Integrations UI sends the admin to Slack's consent (via /api/integrations?action=connectUrl, which signs a
// `state`). Slack redirects here with ?code&state; we exchange the code, get the channel's incoming-webhook URL,
// and store it on the target webhook/config. Env: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SESSION_SECRET, SUPABASE_*.
import crypto from 'crypto';
const secret = () => process.env.SESSION_SECRET || 'tsa-session';
function verifyState(state) {
  try {
    const [body, mac] = String(state || '').split('.');
    if (!body || !mac) return null;
    const exp = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
    if (mac.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
async function supa(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { ...(opts || {}), headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
async function latest(type, field, val) {
  const r = await supa(`records?select=data&type=eq.${type}&data->>${field}=eq.${encodeURIComponent(val)}&order=submitted_at.desc&limit=1`);
  if (!r.ok) return null; const rows = await r.json(); return (rows[0] && rows[0].data) || null;
}
const page = (title, msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;background:#0e0c09;color:#ece5d7;font-family:system-ui,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center"><div style="text-align:center;max-width:420px;padding:24px"><div style="font-size:40px">${title.startsWith('Connected') ? '✅' : '⚠️'}</div><h2 style="margin:10px 0">${title}</h2><p style="color:#9a9081;line-height:1.5">${msg}</p><p style="color:#9a9081;font-size:13px">You can close this tab and return to Sales HQ (refresh the Integrations page).</p></div><script>try{if(window.opener)window.opener.postMessage('slack-connected','*')}catch(e){}</script>`;

export default async function handler(req, res) {
  res.setHeader('content-type', 'text/html');
  const q = req.query || {};
  if (q.error) return res.status(200).send(page('Not connected', 'Slack authorization was cancelled.'));
  const st = verifyState(q.state);
  if (!st) return res.status(200).send(page('Not connected', 'This link expired or was invalid. Start the connect again from Sales HQ.'));
  // pick the Slack app this connect was started with (each feed can have its own app so it posts under its own name)
  const APPS = { default: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'], deal: ['SLACK_CLIENT_ID_DEAL', 'SLACK_CLIENT_SECRET_DEAL'], postcall: ['SLACK_CLIENT_ID_POSTCALL', 'SLACK_CLIENT_SECRET_POSTCALL'], sod: ['SLACK_CLIENT_ID_SOD', 'SLACK_CLIENT_SECRET_SOD'] };
  const app = APPS[st.app] || APPS.default;
  const clientId = process.env[app[0]], clientSecret = process.env[app[1]];
  if (!clientId || !clientSecret) return res.status(200).send(page('Not configured', 'That Slack app is not set up on the server yet.'));
  const redirect_uri = (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host + '/api/slack-oauth';
  try {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: String(q.code || ''), redirect_uri });
    const r = await fetch('https://slack.com/api/oauth.v2.access', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json();
    const url = j && j.incoming_webhook && j.incoming_webhook.url;
    const channel = (j && j.incoming_webhook && j.incoming_webhook.channel) || 'the channel';
    if (!j.ok || !url) return res.status(200).send(page('Not connected', 'Slack did not return a webhook (' + ((j && j.error) || 'unknown') + '). Make sure you picked a channel.'));
    // store the webhook URL on the target
    const now = new Date().toISOString();
    if (st.t === 'webhook') {
      const cur = await latest('webhook', 'id', st.id);
      if (!cur) return res.status(200).send(page('Not connected', 'The webhook to attach this to was not found.'));
      const rec = Object.assign({}, cur, { slackWebhook: url, updatedAt: now });
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: crypto.randomUUID(), type: 'webhook', submitted_at: now, data: rec }) });
    } else {
      const map = { slack: 'slackWebhook', setter: 'eodSetterSlack', closer: 'eodCloserSlack', mgr: 'eodMgrSlack', deal: 'dealSlack', postcall: 'postcallSlack', sod: 'sodSlack', sodSetter: 'sodSetterSlack', sodCloser: 'sodCloserSlack' };
      const f = map[st.field] || 'slackWebhook';
      const cur = (await latest('integration', 'key', st.key)) || { id: crypto.randomUUID(), type: 'integration', key: st.key, ws: st.ws || 'tsa', client: '' };
      const rec = Object.assign({}, cur, { [f]: url, updatedAt: now });
      await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: crypto.randomUUID(), type: 'integration', submitted_at: now, data: rec }) });
    }
    return res.status(200).send(page('Connected to ' + channel, 'Sales HQ will post here.'));
  } catch (e) { return res.status(200).send(page('Not connected', 'Something went wrong: ' + String(e && e.message || e))); }
}
