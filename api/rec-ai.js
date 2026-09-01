// /api/rec-ai — AI best-fit ranking for a recruiting query (Claude). Optional: the tool works with
// faceted/keyword filtering even if this is not configured. Env: ANTHROPIC_API_KEY (required for AI),
// RECRUIT_PASS (same gate as /api/recruiting), optional REC_AI_MODEL override.
export default async function handler(req, res) {
  const pass = process.env.RECRUIT_PASS;
  const given = (req.headers && req.headers['x-recruit-key']) || (req.query && req.query.key) || '';
  if (pass && given !== pass) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not set (AI search off; faceted search still works)' });
  const { query, candidates } = req.body || {};
  if (!query || !Array.isArray(candidates) || !candidates.length) return res.status(200).json({ ok: false, error: 'query and candidates required' });
  // compact rows so a few hundred candidates fit comfortably in context
  const rows = candidates.slice(0, 400).map(c => ({
    id: c.id, name: c.name, rating: c.rating, role: c.role, sold: c.sold,
    achievements: c.achievements, tz: c.timezones, tech: c.tech, lang: c.languages,
    summary: String(c.summary || '').slice(0, 300)
  }));
  const sys = 'You are a recruiting assistant for a sales-staffing agency. Given a HIRING QUERY and a JSON list of candidates, choose the BEST-FIT candidates and rank them best-first. Weigh the star rating, what they have sold, achievements, timezone, and the call-summary. Return ONLY compact JSON of the form {"ranked":[{"id":"rec...","reason":"<=12 words why they fit"}]}. Include only genuinely relevant candidates (max 40). No prose outside the JSON.';
  const user = 'HIRING QUERY:\n' + query + '\n\nCANDIDATES (JSON):\n' + JSON.stringify(rows);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.REC_AI_MODEL || 'claude-3-5-sonnet-latest', max_tokens: 2000, system: sys, messages: [{ role: 'user', content: user }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(200).json({ ok: false, error: 'anthropic ' + r.status + ' ' + JSON.stringify(j).slice(0, 300) });
    let txt = (j.content && j.content[0] && j.content[0].text) || '';
    const m = txt.match(/\{[\s\S]*\}/); let parsed = { ranked: [] };
    try { parsed = JSON.parse(m ? m[0] : txt); } catch (e) {}
    return res.status(200).json({ ok: true, ranked: Array.isArray(parsed.ranked) ? parsed.ranked : [] });
  } catch (e) { return res.status(200).json({ ok: false, error: String(e) }); }
}
