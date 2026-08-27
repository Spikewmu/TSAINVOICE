// /api/slack — posts a message to Slack via an incoming webhook.
// The webhook URL is kept server-side in the SLACK_WEBHOOK_URL Vercel env var
// (Project → Settings → Environment Variables), never in the client.
//
// The dashboard calls this same-origin: fetch('/api/slack', {method:'POST', body: JSON.stringify({text})})
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return res.status(200).json({ ok: false, error: 'SLACK_WEBHOOK_URL not set' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const text = body && body.text ? String(body.text) : '';
    if (!text) return res.status(400).json({ ok: false, error: 'no text' });

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.status(200).json({ ok: r.ok });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
