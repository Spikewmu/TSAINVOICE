// /api/ghl-lead - relay a GHL workflow webhook into Slack in Slack's required shape.
// GHL's free "Webhook" action posts its own JSON (contact details + custom data); Slack incoming webhooks need a
// top-level {"text":...} or they reject with "no_text". This endpoint takes GHL's payload, pulls the message
// (custom-data "text" if set, else builds one from the contact fields) and posts a clean {text} to the Slack webhook.
// Free + instant (fires the moment GHL triggers). SSRF-safe: only forwards to hooks.slack.com.
//
// Point a GHL Webhook action at:  https://<host>/api/ghl-lead?to=<url-encoded Slack incoming webhook URL>

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: false, error: 'POST only' });

  // destination Slack webhook (from ?to=), restricted to Slack to prevent open-relay/SSRF
  const to = (req.query && req.query.to) || '';
  let slackUrl = '';
  try { slackUrl = decodeURIComponent(String(to)); } catch (e) { slackUrl = String(to); }
  if (!/^https:\/\/hooks\.slack\.com\/services\//.test(slackUrl)) {
    return res.status(200).json({ ok: false, error: 'to= must be a https://hooks.slack.com/services/ URL' });
  }

  // parse GHL's body
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const cd = b.customData || b.custom_data || {};

  // message: prefer the "text" GHL was told to send (merge fields already resolved there); else build from fields
  let text = cd.text || b.text;
  if (!text) {
    const name = b.full_name || [b.first_name, b.last_name].filter(Boolean).join(' ').trim() || (b.contact && (b.contact.name || b.contact.full_name)) || 'New lead';
    const phone = b.phone || (b.contact && b.contact.phone) || '';
    const email = b.email || (b.contact && b.contact.email) || '';
    const src = b.source || cd.source || (b.contact && b.contact.source) || '';
    text = `🚨 New lead: ${name}` + (phone ? ' | ' + phone : '') + (email ? ' | ' + email : '') + (src ? ' | ' + src : '') + ' - call now (speed to lead!)';
  }
  text = String(text).slice(0, 1500);

  try {
    const r = await fetch(slackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const t = await r.text().catch(() => '');
    return res.status(200).json({ ok: r.ok && t === 'ok', slack: t || r.status });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
