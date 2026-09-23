// /api/ghl-lead - relay a GHL workflow webhook into Slack in Slack's required shape.
// GHL's free "Webhook" action posts its own JSON (contact details + custom data); Slack incoming webhooks need a
// top-level {"text":...} or they reject with "no_text". This endpoint takes GHL's payload, pulls the message
// (custom-data "text" if set, else builds one from the contact fields) and posts a clean {text} to the Slack webhook.
// Free + instant (fires the moment GHL triggers). SSRF-safe: only forwards to hooks.slack.com.
//
// Query params:
//   ?to=<url-encoded Slack incoming webhook URL>   (required, must be hooks.slack.com)
//   ?kind=lead|booked                              (optional, default lead) - changes the header/format
//   ?seg=0                                          (optional) - disable the organic-vs-ads tag
//
// New lead:    https://<host>/api/ghl-lead?to=<slack>
// Booked call: https://<host>/api/ghl-lead?to=<slack>&kind=booked

// Classify a lead/booking as ads-driven vs organic from GHL's (messy) attribution fields.
// Returns { label: 'ADS'|'ORGANIC'|'', tag } - tag is a ready-to-append Slack chip, or '' when unsure.
function classifySource(strings) {
  const s = strings.filter(Boolean).join(' | ').toLowerCase();
  if (!s.trim()) return { label: '', tag: '' };
  // paid / ad-platform signals
  const ads = /\b(fb|facebook|ig|instagram|meta|tiktok|snapchat|youtube\s*ads?|yt\s*ads?|google\s*ads?|adwords|bing\s*ads?|paid|ppc|cpc|cpm|retarget|campaign|\bads?\b|utm_medium=?\s*(cpc|paid|ppc|ads?))\b/;
  // organic / earned signals
  const org = /\b(organic|referral|refer|direct|word[\s-]*of[\s-]*mouth|seo|organic\s*search|google\s*organic|website\s*form|opt[\s-]*in\s*form|manual|import)\b/;
  if (ads.test(s)) return { label: 'ADS', tag: ' • 🎯 ADS' };
  if (org.test(s)) return { label: 'ORGANIC', tag: ' • 🌱 ORGANIC' };
  return { label: '', tag: '' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: false, error: 'POST only' });

  // destination Slack webhook (from ?to=), restricted to Slack to prevent open-relay/SSRF
  const to = (req.query && req.query.to) || '';
  let slackUrl = '';
  try { slackUrl = decodeURIComponent(String(to)); } catch (e) { slackUrl = String(to); }
  if (!/^https:\/\/hooks\.slack\.com\/services\//.test(slackUrl)) {
    return res.status(200).json({ ok: false, error: 'to= must be a https://hooks.slack.com/services/ URL' });
  }

  const kind = String((req.query && req.query.kind) || 'lead').toLowerCase();
  const segOff = String((req.query && req.query.seg) || '') === '0';

  // parse GHL's body
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const cd = b.customData || b.custom_data || {};
  const contact = b.contact || {};
  const appt = b.appointment || b.calendar || {};

  // gather every place GHL might stash the source/attribution so we can classify organic vs ads
  const srcFields = [
    b.source, cd.source, contact.source,
    b.attributionSource, cd.attributionSource,
    cd.utm_source, b.utm_source, cd.utm_medium, b.utm_medium, cd.utm_campaign, b.utm_campaign,
    contact.attributionSource && (contact.attributionSource.utmSource || contact.attributionSource.medium || contact.attributionSource.source),
    cd.segment
  ];
  const seg = segOff ? { label: '', tag: '' } : classifySource(srcFields);

  // message: prefer the "text" GHL was told to send (merge fields already resolved there); else build from fields
  let text = cd.text || b.text;
  const built = !text;
  if (!text) {
    const name = b.full_name || [b.first_name, b.last_name].filter(Boolean).join(' ').trim()
      || contact.name || contact.full_name || (kind === 'booked' ? 'New booking' : 'New lead');
    const phone = b.phone || contact.phone || '';
    const email = b.email || contact.email || '';
    const srcRaw = b.source || cd.source || contact.source || '';
    const when = cd.appointment_time || cd.when || appt.start_time || appt.startTime || appt.selectedTimezone && appt.start_time || '';

    if (kind === 'booked') {
      text = `📅 New booked call: ${name}`
        + (when ? ' | ' + when : '')
        + (phone ? ' | ' + phone : '')
        + (email ? ' | ' + email : '')
        + (srcRaw ? ' | ' + srcRaw : '');
    } else {
      text = `🚨 New lead: ${name}`
        + (phone ? ' | ' + phone : '')
        + (email ? ' | ' + email : '')
        + (srcRaw ? ' | ' + srcRaw : '')
        + ' - call now (speed to lead!)';
    }
  }

  // append the clean organic/ads chip when we're confident and it isn't already stated
  if (seg.tag && !/\b(ADS|ORGANIC)\b/i.test(text)) text += seg.tag;

  text = String(text).slice(0, 1500);

  try {
    const r = await fetch(slackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const t = await r.text().catch(() => '');
    return res.status(200).json({ ok: r.ok && t === 'ok', slack: t || r.status, kind, segment: seg.label || null });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
