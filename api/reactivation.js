// /api/reactivation — admin-only GHL reactivation runner.
//   Pulls opportunities for a pipeline, filters to a created-date window, de-dupes by contact,
//   honors exclusion tags, then (execute) tags the contacts + creates opportunities in a target
//   pipeline/stage. Reuses a client's already-stored GHL Private Integration Token (never exposed).
//   v2 (pit-) tokens only. Admin-only (session token or admin pass), super-admin (tsa ws) required.
import crypto from 'crypto';
export const config = { maxDuration: 60 };
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
async function cfgAll() {
  const r = await supa(`records?select=data&type=eq.integration&order=submitted_at.asc&limit=100000`);
  if (!r || !r.ok) return [];
  const rows = await r.json(); const out = [];
  rows.forEach(x => { const d = x.data; if (d && d.ghlApiKey && String(d.ghlLocationId || '').trim()) out.push(d); });
  return out;
}
// pull calendar events for one v2 client in [fromMs,toMs]; returns normalized events
async function pullCalV2(cfg, fromMs, toMs) {
  const { loc, base, H } = ghlCtx(cfg);
  const clientName = cfg.client || cfg.key || loc;
  const events = [];
  // user map (assigned rep names)
  const usr = await jfetch(base + '/users/?locationId=' + encodeURIComponent(loc), { headers: H });
  const usrMap = {}; ((usr.j && usr.j.users) || []).forEach(u => { usrMap[u.id] = u.name || ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.email; });
  const cal = await jfetch(base + '/calendars/?locationId=' + encodeURIComponent(loc), { headers: H });
  const cals = ((cal.j && cal.j.calendars) || []).slice(0, 25);
  for (const c of cals) {
    const url = base + '/calendars/events?locationId=' + encodeURIComponent(loc) + '&calendarId=' + encodeURIComponent(c.id) + '&startTime=' + fromMs + '&endTime=' + toMs;
    const ev = await jfetch(url, { headers: H });
    ((ev.j && ev.j.events) || []).forEach(e => {
      events.push({ client: clientName, calendar: c.name, title: e.title, lead: e.title, status: e.appointmentStatus || e.status, start: e.startTime, end: e.endTime, bookedWith: usrMap[e.assignedUserId] || e.assignedUserId || '', contactId: e.contactId });
    });
    await sleep(60);
  }
  return events;
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

  // multi-client calendar aggregator (no single locationId)
  if (action === 'calendarEvents') {
    try {
      const from = b.from || q.from, to = b.to || q.to;
      if (!from || !to) return res.status(200).json({ ok: false, error: 'from and to (ISO dates) required' });
      const fromMs = new Date(from).getTime(), toMs = new Date(to).getTime();
      const cfgs = await cfgAll();
      const all = []; const clients = []; const skipped = [];
      for (const cfg of cfgs) {
        const v2 = /^pit-/i.test(String(cfg.ghlApiKey || ''));
        const label = cfg.client || cfg.key;
        if (!v2) { skipped.push({ client: label, reason: 'v1 (not yet supported)' }); continue; }
        try { const evs = await pullCalV2(cfg, fromMs, toMs); all.push(...evs); clients.push({ client: label, count: evs.length }); }
        catch (e) { skipped.push({ client: label, reason: String((e && e.message) || e).slice(0, 120) }); }
      }
      all.sort((a, b2) => String(a.start).localeCompare(String(b2.start)));
      return res.status(200).json({ ok: true, from, to, clients, skipped, count: all.length, events: all });
    } catch (e) { return res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
  }

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
      if (items.length > 50) return res.status(200).json({ ok: false, error: 'max 50 items per batch (serverless timeout)' });
      const skipDupCheck = !!b.skipDupCheck; // first run: no prior target opps exist, skip the extra GET
      const results = [];
      for (const it of items) {
        const id = String(it.id || '').trim(); if (!id) { results.push({ id: '', ok: false, error: 'no id' }); continue; }
        const r = { id, name: it.name || '' };
        try {
          // 1) warm tag (never replaces existing tags)
          const tagR = await jfetch(base + '/contacts/' + id + '/tags', { method: 'POST', headers: H, body: JSON.stringify({ tags: [tag] }) });
          r.tagged = tagR.ok; if (!tagR.ok) r.tagErr = tagR.status;
          // 2) idempotency: skip opp if one already exists for this contact in the target pipeline
          let already = false;
          if (!skipDupCheck) {
            const exU = base + '/opportunities/search?location_id=' + encodeURIComponent(loc) + '&pipeline_id=' + encodeURIComponent(targetPipelineId) + '&contact_id=' + encodeURIComponent(id) + '&limit=1';
            const ex = await jfetch(exU, { headers: H });
            already = ex.ok && ((ex.j && ex.j.opportunities) || []).length > 0;
          }
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

    if (action === 'appointments') {
      // Pull a contact's appointments with resolved calendar + assigned-user names.
      const contactId = String(b.contactId || '').trim();
      const email = String(b.email || '').trim();
      let cid = contactId;
      if (!cid && email) {
        const s = await jfetch(base + '/contacts/?locationId=' + encodeURIComponent(loc) + '&query=' + encodeURIComponent(email), { headers: H });
        const arr = (s.j && s.j.contacts) || [];
        const c = arr.find(x => x && String(x.email || '').toLowerCase() === email.toLowerCase()) || arr[0];
        cid = c && c.id;
      }
      if (!cid) return res.status(200).json({ ok: false, error: 'contactId or matchable email required' });
      const ap = await jfetch(base + '/contacts/' + cid + '/appointments', { headers: H });
      let events = (ap.j && (ap.j.events || ap.j.appointments)) || [];
      if (!Array.isArray(events)) events = [];
      // build calendar + user name maps
      const cal = await jfetch(base + '/calendars/?locationId=' + encodeURIComponent(loc), { headers: H });
      const calMap = {}; ((cal.j && cal.j.calendars) || []).forEach(c => { calMap[c.id] = c.name; });
      const usr = await jfetch(base + '/users/?locationId=' + encodeURIComponent(loc), { headers: H });
      const usrMap = {}; ((usr.j && usr.j.users) || []).forEach(u => { usrMap[u.id] = u.name || ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.email; });
      const out = events.map(e => ({ id: e.id, title: e.title, status: e.appointmentStatus || e.status, start: e.startTime, end: e.endTime, calendar: calMap[e.calendarId] || e.calendarId, bookedWith: usrMap[e.assignedUserId] || e.assignedUserId }));
      return res.status(200).json({ ok: true, contactId: cid, count: out.length, appointments: out, rawSample: out.length ? undefined : String(ap.t).slice(0, 400) });
    }

    if (action === 'sweepreplies') {
      // For each sent contact: if they replied -> move opp to Positive Response + tag; if opted out (DND) -> Not Interested + tag.
      const items = Array.isArray(b.items) ? b.items : null; // [{id}]
      const targetPipelineId = String(b.targetPipelineId || '').trim();
      const posStageId = String(b.posStageId || '').trim();
      const notIntStageId = String(b.notIntStageId || '').trim();
      const debug = !!b.debug;
      if (!items || !items.length) return res.status(200).json({ ok: false, error: 'items[] required' });
      if (!targetPipelineId || !posStageId) return res.status(200).json({ ok: false, error: 'targetPipelineId + posStageId required' });
      if (items.length > 40) return res.status(200).json({ ok: false, error: 'max 40 items per batch' });
      const results = []; let dbg = null;
      for (const it of items) {
        const id = String(it.id || '').trim(); if (!id) { results.push({ id: '', ok: false }); continue; }
        const r = { id };
        try {
          const c = await jfetch(base + '/contacts/' + id, { headers: H });
          const contact = (c.j && c.j.contact) || {};
          const dndSms = contact.dnd === true || (contact.dndSettings && contact.dndSettings.SMS && /active|perm/i.test(String(contact.dndSettings.SMS.status || '')));
          const cs = await jfetch(base + '/conversations/search?locationId=' + encodeURIComponent(loc) + '&contactId=' + encodeURIComponent(id) + '&limit=1', { headers: H });
          const conv = (cs.j && cs.j.conversations && cs.j.conversations[0]) || null;
          if (debug && !dbg && conv) dbg = { convKeys: Object.keys(conv), conv };
          const lastDir = conv && String(conv.lastMessageDirection || conv.direction || '').toLowerCase();
          const replied = !!conv && (String(lastDir).includes('inbound') || Number(conv.unreadCount || 0) > 0);
          r.dnd = !!dndSms; r.replied = replied;
          let move = null, tag = null;
          if (dndSms) { move = notIntStageId; tag = 'tsa - optout'; }
          else if (replied) { move = posStageId; tag = 'tsa - replied'; }
          if (move) {
            const os = await jfetch(base + '/opportunities/search?location_id=' + encodeURIComponent(loc) + '&pipeline_id=' + encodeURIComponent(targetPipelineId) + '&contact_id=' + encodeURIComponent(id) + '&limit=1', { headers: H });
            const opp = (os.j && os.j.opportunities && os.j.opportunities[0]) || null;
            if (opp && opp.id) { const up = await jfetch(base + '/opportunities/' + opp.id, { method: 'PUT', headers: H, body: JSON.stringify({ pipelineStageId: move }) }); r.moved = up.ok; if (!up.ok) r.moveErr = up.status; }
            else r.moved = false;
            if (tag) await jfetch(base + '/contacts/' + id + '/tags', { method: 'POST', headers: H, body: JSON.stringify({ tags: [tag] }) }).catch(() => {});
            r.routedTo = tag;
          }
          r.ok = true;
        } catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
        results.push(r);
        await sleep(90);
      }
      return res.status(200).json({ ok: true, processed: results.length, replied: results.filter(r => r.replied).length, optout: results.filter(r => r.dnd).length, moved: results.filter(r => r.moved).length, results: debug ? results : undefined, dbg });
    }

    if (action === 'send') {
      const items = Array.isArray(b.items) ? b.items : null; // [{id, firstName}]
      const template = String(b.template || '');
      const fromNumber = String(b.fromNumber || '').trim();
      const sentTag = String(b.sentTag || 'tsa - dbr sent').trim();
      const pace = Math.max(0, Number(b.pace || 300));
      if (!items || !items.length) return res.status(200).json({ ok: false, error: 'items[] required' });
      if (!template) return res.status(200).json({ ok: false, error: 'template required' });
      if (items.length > 60) return res.status(200).json({ ok: false, error: 'max 60 items per batch' });
      const results = [];
      for (const it of items) {
        const id = String(it.id || '').trim(); if (!id) { results.push({ id: '', ok: false }); continue; }
        const fn = (String(it.firstName || '').trim().split(/\s+/)[0]) || 'there';
        const msg = template.split('{{first_name}}').join(fn);
        const body = { type: 'SMS', contactId: id, message: msg };
        if (fromNumber) body.fromNumber = fromNumber;
        try {
          const r = await jfetch(base + '/conversations/messages', { method: 'POST', headers: H, body: JSON.stringify(body) });
          const rr = { id, ok: r.ok };
          if (!r.ok) { rr.status = r.status; rr.err = String(r.t).slice(0, 200); }
          else { rr.messageId = r.j && (r.j.messageId || r.j.id); if (sentTag) await jfetch(base + '/contacts/' + id + '/tags', { method: 'POST', headers: H, body: JSON.stringify({ tags: [sentTag] }) }).catch(() => {}); }
          results.push(rr);
        } catch (e) { results.push({ id, ok: false, err: String((e && e.message) || e) }); }
        await sleep(pace);
      }
      return res.status(200).json({ ok: true, processed: results.length, sent: results.filter(r => r.ok).length, results });
    }

    if (action === 'readmsgs') {
      const contactId = String(b.contactId || '').trim();
      if (!contactId) return res.status(200).json({ ok: false, error: 'contactId required' });
      const s1 = await jfetch(base + '/conversations/search?locationId=' + encodeURIComponent(loc) + '&contactId=' + encodeURIComponent(contactId), { headers: H });
      const conv = (s1.j && s1.j.conversations && s1.j.conversations[0]) || null;
      if (!conv) return res.status(200).json({ ok: true, none: true, raw: String(s1.t).slice(0, 300) });
      const m = await jfetch(base + '/conversations/' + conv.id + '/messages', { headers: H });
      let msgs = (m.j && m.j.messages && m.j.messages.messages) || (m.j && m.j.messages) || [];
      if (!Array.isArray(msgs)) msgs = [];
      return res.status(200).json({ ok: true, conversationId: conv.id, msgs: msgs.slice(0, 6).map(x => ({ dir: x.direction, type: x.messageType || x.type, status: x.status, body: x.body })) , raw: msgs.length ? undefined : String(m.t).slice(0, 400) });
    }

    if (action === 'addtags') {
      const items = Array.isArray(b.items) ? b.items : null; // [{id}]
      const tags = (b.tags || []).map(t => String(t).trim()).filter(Boolean);
      if (!items || !items.length) return res.status(200).json({ ok: false, error: 'items[] required' });
      if (!tags.length) return res.status(200).json({ ok: false, error: 'tags[] required' });
      if (items.length > 50) return res.status(200).json({ ok: false, error: 'max 50 items per batch' });
      const results = [];
      for (const it of items) {
        const id = String(it.id || '').trim(); if (!id) { results.push({ id: '', ok: false }); continue; }
        try {
          const r = await jfetch(base + '/contacts/' + id + '/tags', { method: 'POST', headers: H, body: JSON.stringify({ tags }) });
          results.push({ id, ok: r.ok, status: r.ok ? undefined : r.status });
        } catch (e) { results.push({ id, ok: false, error: String((e && e.message) || e) }); }
        await sleep(80);
      }
      return res.status(200).json({ ok: true, processed: results.length, done: results.filter(r => r.ok).length, results });
    }

    return res.status(200).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
