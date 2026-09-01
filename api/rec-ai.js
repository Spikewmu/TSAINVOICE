// /api/rec-ai — AI best-fit ranking for a recruiting query. Provider-agnostic: uses whichever key is set.
//   GROQ_API_KEY   (free tier, fast Llama) — recommended, https://console.groq.com
//   GEMINI_API_KEY (free tier, Gemini Flash) — https://aistudio.google.com
//   ANTHROPIC_API_KEY (paid) — https://console.anthropic.com
// Optional REC_AI_MODEL overrides the model for the chosen provider. Faceted search works even with no key.
// Access gated by the dashboard session (same as /api/recruiting): valid session token w/ allowed role, or master admin pass.
import crypto from 'crypto';
const REC_ROLES = ['admin', 'manager'];
function verifySession(token) {
  try {
    const secret = process.env.SESSION_SECRET || 'tsa-session';
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const exp = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (mac.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
function authorized(req) {
  const b = req.body || {}, q = req.query || {}, h = req.headers || {};
  const s = verifySession(b.token || q.token || h['x-session-token'] || '');
  if (s && REC_ROLES.includes(s.role)) return true;
  const ap = b.adminPass || q.adminPass || h['x-admin-pass'] || '';
  return !!(ap && (ap === process.env.ADMIN_PASS || ap === process.env.BOT_ADMIN_TOKEN));
}
function parseRanked(txt) {
  const m = String(txt || '').match(/\{[\s\S]*\}/);
  try { const p = JSON.parse(m ? m[0] : txt); return Array.isArray(p.ranked) ? p.ranked : []; } catch (e) { return []; }
}
async function callGroq(sys, user) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({ model: process.env.REC_AI_MODEL || 'openai/gpt-oss-20b', temperature: 0.2, max_tokens: 1400, messages: [{ role: 'system', content: sys }, { role: 'user', content: user + '\n\nRespond with ONLY the JSON object, nothing else.' }] })
  });
  const j = await r.json(); if (!r.ok) throw new Error('groq ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}
async function callGemini(sys, user) {
  const model = process.env.REC_AI_MODEL || 'gemini-1.5-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=` + process.env.GEMINI_API_KEY, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ parts: [{ text: user }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } })
  });
  const j = await r.json(); if (!r.ok) throw new Error('gemini ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '';
}
async function callAnthropic(sys, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.REC_AI_MODEL || 'claude-3-5-sonnet-latest', max_tokens: 2000, system: sys, messages: [{ role: 'user', content: user }] })
  });
  const j = await r.json(); if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return (j.content && j.content[0] && j.content[0].text) || '';
}
export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  // diagnostic: list the models the configured Groq key can actually use
  if ((req.query && req.query.action) === 'models' || (req.body && req.body.action) === 'models') {
    if (!process.env.GROQ_API_KEY) return res.status(200).json({ ok: false, error: 'no GROQ_API_KEY' });
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY } });
      const j = await r.json();
      if (!r.ok) return res.status(200).json({ ok: false, status: r.status, error: JSON.stringify(j).slice(0, 300) });
      return res.status(200).json({ ok: true, models: (j.data || []).map(m => m.id) });
    } catch (e) { return res.status(200).json({ ok: false, error: String(e) }); }
  }
  const provider = process.env.GROQ_API_KEY ? 'groq' : (process.env.GEMINI_API_KEY ? 'gemini' : (process.env.ANTHROPIC_API_KEY ? 'anthropic' : null));
  if (!provider) return res.status(200).json({ ok: false, error: 'No AI key set (GROQ_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY). Faceted search still works.' });
  const { query, candidates } = req.body || {};
  if (!query || !Array.isArray(candidates) || !candidates.length) return res.status(200).json({ ok: false, error: 'query and candidates required' });
  // keep the payload small — free Groq tiers cap tokens-per-minute, so send a lean, bounded set
  const rows = candidates.slice(0, 60).map(c => ({ id: c.id, name: c.name, rating: c.rating, role: c.role, sold: c.sold, tz: c.timezones, summary: String(c.summary || '').slice(0, 120) }));
  const sys = 'You are a recruiting assistant for a sales-staffing agency. Given a HIRING QUERY and a JSON list of candidates, choose the BEST-FIT candidates and rank them best-first. Weigh the star rating, what they have sold, achievements, timezone, and the call summary. Return ONLY JSON of the form {"ranked":[{"id":"rec...","reason":"<=12 words why they fit"}]}. Include only genuinely relevant candidates (max 40). No prose outside the JSON.';
  const user = 'HIRING QUERY:\n' + query + '\n\nCANDIDATES (JSON):\n' + JSON.stringify(rows);
  try {
    const txt = provider === 'groq' ? await callGroq(sys, user) : provider === 'gemini' ? await callGemini(sys, user) : await callAnthropic(sys, user);
    const ranked = parseRanked(txt);
    const resp = { ok: true, provider, ranked };
    if (!ranked.length && (req.body && req.body.debug)) resp._raw = String(txt || '').slice(0, 600);
    return res.status(200).json(resp);
  } catch (e) { return res.status(200).json({ ok: false, error: String(e && e.message || e) }); }
}
