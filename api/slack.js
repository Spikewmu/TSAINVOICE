// /api/slack — posts an internal notification (e.g. an onboarding step sign-off) to Slack.
// Posts AS the TSA bot (chat.postMessage) to SIGNOFF_CHANNEL (or DIGEST_CHANNEL), falling back
// to a plain SLACK_WEBHOOK_URL. Requires a valid dashboard session token so it can't be spammed.
//
// Env: SESSION_SECRET, SLACK_BOT_TOKEN, SIGNOFF_CHANNEL|DIGEST_CHANNEL (or SLACK_WEBHOOK_URL)
import crypto from 'crypto';

function verifyToken(token) {
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

async function postToSlack(text) {
  const bot = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SIGNOFF_CHANNEL || process.env.DIGEST_CHANNEL;
  if (bot && channel) {
    const r = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bot }, body: JSON.stringify({ channel, text }) });
    const j = await r.json().catch(() => ({}));
    return { ok: !!j.ok, error: j.error };
  }
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (webhook) { const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); return { ok: r.ok }; }
  return { ok: false, error: 'no SLACK_BOT_TOKEN+channel or SLACK_WEBHOOK_URL' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // must be a logged-in dashboard user
  if (!verifyToken(body.token)) return res.status(200).json({ ok: false, error: 'unauthorized' });

  const text = body.text ? String(body.text) : '';
  if (!text) return res.status(400).json({ ok: false, error: 'no text' });

  const posted = await postToSlack(text);
  return res.status(200).json(posted);
}
