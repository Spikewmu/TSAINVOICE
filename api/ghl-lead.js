// /api/ghl-lead - relay a GHL workflow webhook into Slack in Slack's required shape.
// GHL's free "Webhook" action posts its own JSON (contact details + custom data); this endpoint pulls the message
// (custom-data "text" if set, else builds one from the contact fields) and posts a clean message to Slack.
// Free + instant (fires the moment GHL triggers).
//
// TWO destination modes:
//   1) Bot mode (preferred):  ?client=<name>&kind=booked|lead
//      -> looks up that client's connected Slack bot + the channel picked in Integrations
//         ("New booked call" / "New lead" feed). No raw webhook URL needed; pick the channel from the dropdown.
//   2) Webhook mode (legacy): ?to=<url-encoded Slack incoming webhook URL>   (must be hooks.slack.com)
//
//   ?kind=lead|booked   (default lead) - header/format
//   ?seg=0              (optional)     - disable the organic-vs-ads tag
//
// Booked call (bot):     https://<host>/api/ghl-lead?client=Social%20Revelation&kind=booked
// Booked call (webhook): https://<host>/api/ghl-lead?to=<slack>&kind=booked
import { supa, slackPost } from './_lib.js';

// load a client's integration config (bot token + per-feed channels), same key scheme as data.js integrationFor
async function loadIntegration(client) {
  try {
    const r = await supa(`records?select=data&type=eq.integration&data->>key=eq.${encodeURIComponent('tsa:' + client)}&order=submitted_at.desc&limit=1`);
    if (!r || !r.ok) return null;
    const rows = await r.json();
    return (rows[0] && rows[0].data) || null;
  } catch (e) { return null; }
}

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

  const client = String((req.query && req.query.client) || '').trim(); // bot mode
  const to = (req.query && req.query.to) || '';                        // legacy webhook mode
  let slackUrl = '';
  try { slackUrl = decodeURIComponent(String(to)); } catch (e) { slackUrl = String(to); }
  if (!client && !/^https:\/\/hooks\.slack\.com\/services\//.test(slackUrl)) {
    return res.status(200).json({ ok: false, error: 'pass ?client=<name> (bot) or ?to=<hooks.slack.com webhook>' });
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
    const when = cd.appointment_time || cd.when || appt.start_time || appt.startTime || (appt.selectedTimezone && appt.start_time) || '';
    // setter (who booked) + closer (the call is with). Map these in the GHL Webhook action's Custom Data
    // (setter / closer) for reliable names; else fall back to the appointment's assigned user for the closer.
    const setter = cd.setter || cd.setter_name || cd.setterName || b.setter || '';
    const closer = cd.closer || cd.closer_name || cd.closerName || b.closer
      || (appt.user && (appt.user.name || appt.user.full_name)) || appt.assignedUserName || cd.assigned_user || '';

    if (kind === 'booked') {
      text = `📅 *New booked call*`
        + `\n• Prospect: ${name}`
        + (phone ? `\n• Phone: ${phone}` : '')
        + (email ? `\n• Email: ${email}` : '')
        + `\n• Setter: ${setter || 'Auto booking'}`
        + (closer ? `\n• Closer: ${closer}` : '')
        + (when ? `\n• When: ${when}` : '')
        + (srcRaw ? `\n• Source: ${srcRaw}` : '');
    } else {
      text = `🚨 *New lead* - call now (speed to lead!)`
        + `\n• Name: ${name}`
        + (phone ? `\n• Phone: ${phone}` : '')
        + (email ? `\n• Email: ${email}` : '')
        + (srcRaw ? `\n• Source: ${srcRaw}` : '');
    }
  }

  // append the clean organic/ads chip when we're confident and it isn't already stated
  if (seg.tag && !/\b(ADS|ORGANIC)\b/i.test(text)) text += seg.tag;

  text = String(text).slice(0, 1500);

  // ---- Bot mode: look up the client's connected Slack bot + the channel picked for this feed ----
  if (client) {
    const cfg = await loadIntegration(client);
    if (!cfg) return res.status(200).json({ ok: false, error: 'no integration for client "' + client + '" (check the name matches HQ exactly)' });
    const raw = kind === 'booked' ? (cfg.bookedCallSlack || '') : (cfg.newLeadSlack || '');
    if (!raw) return res.status(200).json({ ok: true, skipped: 'feed off - pick a channel in Integrations > Slack bot', kind });
    const channel = raw === '__default__' ? (cfg.botChanId || '') : raw;
    if (!channel) return res.status(200).json({ ok: false, error: 'no channel set (and no default bot channel)' });
    try {
      if (/^https?:\/\//i.test(channel)) { // an external webhook was kept for this feed
        const r = await fetch(channel, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        return res.status(200).json({ ok: r.ok, kind, via: 'webhook', segment: seg.label || null });
      }
      if (!cfg.botToken) return res.status(200).json({ ok: false, error: 'Slack bot not connected for this client' });
      const j = await slackPost(cfg.botToken, channel, text);
      return res.status(200).json({ ok: !!j.ok, kind, via: 'bot', error: j.ok ? undefined : (j.error + (j.error === 'not_in_channel' ? ' (invite the bot to that channel)' : '')), segment: seg.label || null });
    } catch (e) { return res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
  }

  // ---- Legacy webhook mode: post straight to the given hooks.slack.com URL ----
  try {
    const r = await fetch(slackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const t = await r.text().catch(() => '');
    return res.status(200).json({ ok: r.ok && t === 'ok', slack: t || r.status, kind, via: 'webhook', segment: seg.label || null });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
