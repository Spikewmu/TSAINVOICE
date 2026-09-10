// /api/reactivation — admin-only GHL reactivation runner.
//   Pulls opportunities for a pipeline, filters to a created-date window, de-dupes by contact,
//   honors exclusion tags, then (execute) tags the contacts + creates opportunities in a target
//   pipeline/stage. Reuses a client's already-stored GHL Private Integration Token (never exposed).
//   v2 (pit-) tokens only. Admin-only (session token or admin pass), super-admin (tsa ws) required.
import crypto from 'crypto';
const DEFAULT_WS = 'tsa';

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
async function supa(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.SUPABASE_URL || !key) return null;
  return fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, { ...(opts || {}), headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) } });
}
async function cfgForLocation(locationId) {
  const r = await supa(`records?select=data&type=eq.integration&order=submitted_at.asc&limit=100000`);
  if (!r || !r.ok) return null;
  const rows = await r.json(); let found = null;
  rows.forEach(x => { const d = x.data; if (d && String(d.ghlLocationId || '').trim() === String(locationId).trim() && d.ghlApiKey) found = d; });
  return found;
}
function ghlCtx(cfg) {
  const key = String(cfg.ghlApiKey || ''), v2 = /^pit-/i.test(key), loc = String(cfg.ghlLocationId || '').trim();
  const base = v2 ? 'https://services.leadconnectorhq.com' : 'https://rest.gohighlevel.com/v1';
  const H = v2 ? { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Version: '2021-07-28' }
               : { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  return { v2, loc, base, H };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jfetch(url, opts) {
  const r = await fetch(url, opts); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { ok: r.ok, status: r.status, j, t };
}
const dayOf = s => String(s || '').slice(0, 10); // ISO date portion

// paginate all opportunities for a pipeline (v2), via startAfter/startAfterId
async function allOpps(base, H, loc, pipelineId, cap) {
  const out = []; let startAfter = null, startAfterId = null;
  for (let i = 0; i < (cap || 40); i++) {
    let url = base + '/opportunities/search?location_id=' + encodeURIComponent(loc) + '&pipeline_id=' + encodeURIComponent(pipelineId) + '&limit=100';
    if (startAfterId) url += '&startAfterId=' + encodeURIComponent(startAfterId) + '&startAfter=' + encodeURIComponent(startAfter);
    const { ok, j, status, t } = await jfetch(url, { headers: H });
    if (!ok) return { error: 'opp search ' + status + ' ' + String(t).slice(0, 200), out };
    const arr = (j && j.opportunities) || []; out.push(...arr);
    const meta = (j && j.meta) || {};
    if (arr.length < 100 || (!meta.startAfterId && !meta.nextPageUrl)) break;
    startAfter = meta.startAfter; startAfterId = meta.startAfterId;
    if (!startAfterId) break;
    await sleep(120);
  }
  return { out };
}
// select the reactivation audience from a pipeline
async function selectAudience(base, H, loc, pipelineId, fromDay, toDay, excludeTags) {
  const { out, error } = await allOpps(base, H, loc, pipelineId);
  if (error) return { error };
  const ex = (excludeTags || []).map(t => String(t).toLowerCase());
  const seen = new Set(); const items = []; let inWindow = 0, excluded = 0, noContact = 0, tagsSeen = false;
  for (const o of out) {
    const created = dayOf(o.createdAt || o.dateAdded || (o.contact && o.contact.dateAdded));
    if (fromDay && created < fromDay) continue;
    if (toDay && created > toDay) continue;
    inWindow++;
    const cId = o.contactId || (o.contact && o.contact.id);
    if (!cId) { noContact++; continue; }
    if (seen.has(cId)) continue;
    seen.add(cId);
    const tags = ((o.contact && o.contact.tags) || []).map(t => String(t).toLowerCase());
    if (tags.length) tagsSeen = true;
    if (ex.length && tags.some(t => ex.some(e => t === e || t.includes(e)))) { excluded++; continue; }
    items.push({ id: cId, name: (o.contact && (o.contact.name || o.contact.contactName)) || o.name || '', created, phone: (o.contact && o.contact.phone) || '', tags });
  }
  return { totalOpps: out.length, inWindow, uniqueContacts: seen.size, excluded, noContact, tagsInlinePresent: tagsSeen, count: items.length, items };
}

export default async function handler(req, res) {
  const b = req.body || {}, q = req.query || {}, h = req.headers || {};
  const s = verifySession(b.token || q.token || h['x-session-token'] || '');
  let isSuper = false;
  if (s) { if (s.role !== 'admin') return res.status(200).json({ ok: false, error: 'Admins only' }); isSuper = true; }
  else { const ap = b.adminPass || q.adminPass || h['x-admin-pass'] || ''; if (ap && (ap === process.env.ADMIN_PASS || ap === process.env.BOT_ADMIN_TOKEN)) isSuper = true; }
  if (!isSuper) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: false, error: 'not-provisioned' });

  const action = q.action || b.action || 'dryrun';
  const locationId = String(b.locationId || q.locationId || '').trim();
  if (!locationId) return res.status(200).json({ ok: false, error: 'locationId required' });
  const cfg = await cfgForLocation(locationId);
  if (!cfg) return res.status(200).json({ ok: false, error: 'no stored integration with a GHL key for location ' + locationId });
  const { v2, loc, base, H } = ghlCtx(cfg);
  if (!v2) return res.status(200).json({ ok: false, error: 'this runner supports v2 (pit-) tokens only' });

  try {
    if (action === 'pipelines') {
      const { ok, j, status, t } = await jfetch(base + '/opportunities/pipelines?locationId=' + encodeURIComponent(loc), { headers: H });
      if (!ok) return res.status(200).json({ ok: false, error: 'pipelines ' + status + ' ' + String(t).slice(0, 200) });
      const pipelines = ((j && j.pipelines) || []).map(p => ({ id: p.id, name: p.name, stages: (p.stages || []).map(st => ({ id: st.id, name: st.name })) }));
      return res.status(200).json({ ok: true, pipelines });
    }

    if (action === 'dryrun') {
      const pipelineId = String(b.pipelineId || q.pipelineId || '').trim();
      if (!pipelineId) return res.status(200).json({ ok: false, error: 'pipelineId required' });
      const fromDay = dayOf(b.fromDate || q.fromDate || '');
      const toDay = dayOf(b.toDate || q.toDate || '');
      const excludeTags = b.excludeTags || ['exclusion', 'inactive', 'ltcb'];
      const r = await selectAudience(base, H, loc, pipelineId, fromDay, toDay, excludeTags);
      if (r.error) return res.status(200).json({ ok: false, error: r.error });
      return res.status(200).json({ ok: true, window: { fromDay, toDay }, excludeTags, ...r, sample: r.items.slice(0, 8) });
    }

    if (action === 'execute') {
      const items = Array.isArray(b.items) ? b.items : null; // [{id,name}]
      const targetPipelineId = String(b.targetPipelineId || '').trim();
      const targetStageId = String(b.targetStageId || '').trim();
      const tag = String(b.tag || 'snoop-reactivation-warm').trim();
      const markerTag = String(b.markerTag || 'snoop-reactivated-opp').trim();
      const source = String(b.source || 'Snoop Reactivation').trim();
      if (!items || !items.length) return res.status(200).json({ ok: false, error: 'items[] required' });
      if (!targetPipelineId || !targetStageId) return res.status(200).json({ ok: false, error: 'targetPipelineId and targetStageId required' });
      if (items.length > 30) return res.status(200).json({ ok: false, error: 'max 30 items per batch (serverless timeout)' });
      const results = [];
      for (const it of items) {
        const id = String(it.id || '').trim(); if (!id) { results.push({ id: '', ok: false, error: 'no id' }); continue; }
        const r = { id, name: it.name || '' };
        try {
          // 1) warm tag (never replaces existing tags)
          const tagR = await jfetch(base + '/contacts/' + id + '/tags', { method: 'POST', headers: H, body: JSON.stringify({ tags: [tag] }) });
          r.tagged = tagR.ok; if (!tagR.ok) r.tagErr = tagR.status;
          // 2) idempotency: skip opp if one already exists for this contact in the target pipeline
          const exU = base + '/opportunities/search?location_id=' + encodeURIComponent(loc) + '&pipeline_id=' + encodeURIComponent(targetPipelineId) + '&contact_id=' + encodeURIComponent(id) + '&limit=1';
          const ex = await jfetch(exU, { headers: H });
          const already = ex.ok && ((ex.j && ex.j.opportunities) || []).length > 0;
          if (already) { r.oppSkipped = true; }
          else {
            const body = { pipelineId: targetPipelineId, locationId: loc, contactId: id, pipelineStageId: targetStageId, status: 'open', name: (it.name || 'Reactivation'), source };
            const oppR = await jfetch(base + '/opportunities/', { method: 'POST', headers: H, body: JSON.stringify(body) });
            r.oppCreated = oppR.ok; r.oppId = oppR.ok && oppR.j && (oppR.j.opportunity ? oppR.j.opportunity.id : oppR.j.id);
            if (!oppR.ok) r.oppErr = oppR.status + ' ' + String(oppR.t).slice(0, 160);
            else if (markerTag) await jfetch(base + '/contacts/' + id + '/tags', { method: 'POST', headers: H, body: JSON.stringify({ tags: [markerTag] }) }).catch(() => {});
          }
          r.ok = r.tagged && (r.oppSkipped || r.oppCreated);
        } catch (e) { r.ok = false; r.error = String((e && e.message) || e); }
        results.push(r);
        await sleep(120);
      }
      const done = results.filter(r => r.ok).length;
      return res.status(200).json({ ok: true, processed: results.length, done, results });
    }

    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
