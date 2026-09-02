// /api/twilio-inbound - webhook Twilio calls when a candidate TEXTS the TSA number.
//
// Routing: because each active candidate has exactly one owner, we match the sender's phone to
// the most recent OUTBOUND message we sent to that number, recover the candidate + owning recruiter,
// store the inbound reply on that thread, and refresh the claim so it re-sorts and the
// auto-release "silence" timer resets. The recruiter then sees the reply in their Messages tab;
// nobody else does.
//
// Configure in Twilio: set the number's "A message comes in" webhook to POST this URL.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Optional TWILIO_VALIDATE=1 + TWILIO_AUTH_TOKEN to
// verify the X-Twilio-Signature (turn on once you've confirmed the public URL matches).
import crypto from 'crypto';
const digits = s => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
async function supa(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { ...(opts || {}), headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
function twiml(res, msg) { res.setHeader('Content-Type', 'text/xml'); return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response>' + (msg || '') + '</Response>'); }
// Twilio request signature: base64( HMAC-SHA1(authToken, url + sorted(key+value)) )
function validTwilio(req, params) {
  if (process.env.TWILIO_VALIDATE !== '1') return true; // opt-in
  const tok = process.env.TWILIO_AUTH_TOKEN; if (!tok) return true;
  const sig = req.headers['x-twilio-signature']; if (!sig) return false;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = proto + '://' + req.headers.host + req.url;
  let data = url; Object.keys(params).sort().forEach(k => { data += k + params[k]; });
  const expect = crypto.createHmac('sha1', tok).update(Buffer.from(data, 'utf-8')).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch (e) { return false; }
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return twiml(res);
  let p = req.body;
  if (typeof p === 'string') { const o = {}; new URLSearchParams(p).forEach((v, k) => (o[k] = v)); p = o; }
  p = p || {};
  if (!validTwilio(req, p)) return res.status(403).send('bad signature');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return twiml(res);
  const from = digits(p.From), body = String(p.Body || '');
  if (!from) return twiml(res);
  try {
    // find the candidate + owner from the last outbound text to this number
    const r = await supa(`messages?select=cand_id,owner&contact=eq.${encodeURIComponent(from)}&order=created_at.desc&limit=1`);
    const rows = r.ok ? await r.json() : [];
    const hit = rows[0];
    if (!hit) return twiml(res); // unknown sender (we never texted them) - ignore
    const now = new Date().toISOString();
    await supa('messages', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ cand_id: hit.cand_id, owner: hit.owner, dir: 'in', channel: 'text', body, contact: from, created_at: now }) });
    // refresh the claim: keep the same owner but update lastInboundAt (re-locks + re-sorts, resets silence timer)
    const cr = await supa(`records?select=data&type=eq.claim&data->>candId=eq.${encodeURIComponent(hit.cand_id)}&order=submitted_at.desc&limit=1`);
    const crows = cr.ok ? await cr.json() : []; const cl = (crows[0] && crows[0].data) || {};
    const claim = { id: crypto.randomUUID(), type: 'claim', candId: hit.cand_id, candName: cl.candName || '', owner: hit.owner, ownerName: cl.ownerName || hit.owner, claimedAt: cl.claimedAt || now, lastInboundAt: now, status: 'active', by: 'inbound' };
    await supa('records', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rid: claim.id, type: 'claim', submitted_at: now, data: claim }) });
  } catch (e) { /* swallow - never 500 a webhook */ }
  return twiml(res);
}
