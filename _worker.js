function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

const enc = new TextEncoder();
const EVENTS_KEY = 'admin_events_v2';
const EVENT_STATE_PREFIX = 'event_state_v1:';

function base64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(String(value || '')));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function sessionSecret(env) {
  return env.SESSION_SECRET || env.ADMIN_PASSWORD_HASH || env.ADMIN_PASSWORD || 'dev-only-change-me';
}

async function signSession(env, claims) {
  const payload = base64url(enc.encode(JSON.stringify({ ...claims, exp: Date.now() + 1000 * 60 * 60 * 12 })));
  const sig = await hmac(sessionSecret(env), payload);
  return `${payload}.${sig}`;
}

async function verifySession(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = await hmac(sessionSecret(env), payload);
  if (!safeEqual(sig, expected)) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    if (!json.exp || json.exp < Date.now()) return null;
    return json;
  } catch {
    return null;
  }
}

async function requireAdmin(request, env) {
  const session = await verifySession(request, env);
  return session?.role === 'admin' ? session : null;
}

async function requireEventAccess(request, env, eventId) {
  const session = await verifySession(request, env);
  if (!session) return null;
  if (session.role === 'admin') return session;
  if (session.role === 'client' && session.eventId === eventId) return session;
  return null;
}

async function adminLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const expectedUser = env.ADMIN_USERNAME || 'admin';
  const expectedHash = env.ADMIN_PASSWORD_HASH || (env.ADMIN_PASSWORD ? await sha256Hex(env.ADMIN_PASSWORD) : '');
  if (!expectedHash) return jsonResponse({ ok: false, error: 'Admin password is not configured' }, 503);
  const ok = username === expectedUser && safeEqual(await sha256Hex(password), expectedHash);
  if (!ok) return jsonResponse({ ok: false, error: 'שם משתמש או סיסמה שגויים' }, 401);
  return jsonResponse({ ok: true, token: await signSession(env, { role: 'admin', username }) });
}

async function loadEvents(env) {
  if (!env.EVENTS_KV) return null;
  const raw = await env.EVENTS_KV.get(EVENTS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveEvents(env, events) {
  if (!env.EVENTS_KV) return false;
  await env.EVENTS_KV.put(EVENTS_KEY, JSON.stringify(events));
  return true;
}

async function eventsApi(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  const events = await loadEvents(env);
  if (!events) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  if (request.method === 'GET') return jsonResponse({ ok: true, events });
  if (request.method === 'POST') {
    const ev = await request.json().catch(() => null);
    if (!ev?.id) return jsonResponse({ ok: false, error: 'Missing event id' }, 400);
    const next = [ev, ...events.filter(x => x.id !== ev.id)];
    await saveEvents(env, next);
    return jsonResponse({ ok: true, event: ev, events: next });
  }
  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return jsonResponse({ ok: false, error: 'Missing id' }, 400);
    const next = events.filter(x => x.id !== id);
    await saveEvents(env, next);
    return jsonResponse({ ok: true, events: next });
  }
  return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
}


async function signRsvpToken(env, payload) {
  const body = base64url(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(sessionSecret(env), body);
  return `${body}.${sig}`;
}
async function verifyRsvpToken(env, token) {
  if (!token || !String(token).includes('.')) return null;
  const [body, sig] = String(token).split('.');
  const expected = await hmac(sessionSecret(env), body);
  if (!safeEqual(sig, expected)) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    if (json.exp && json.exp < Date.now()) return null;
    return json;
  } catch { return null; }
}
function htmlResponse(html, status=200) {
  return new Response(html, { status, headers: { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' } });
}
function escapeHtmlServer(value) {
  return String(value ?? '').replace(/[&<>\"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]));
}
async function rsvpLinkApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok:false, error:'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const body = await request.json().catch(() => ({}));
  const eventId = String(body.eventId || '').trim();
  const guestIndex = Number(body.guestIndex);
  if (!eventId || !Number.isFinite(guestIndex)) return jsonResponse({ ok:false, error:'Missing eventId or guestIndex' }, 400);
  const session = await requireEventAccess(request, env, eventId);
  if (!session) return jsonResponse({ ok:false, error:'Unauthorized' }, 401);
  const raw = await env.EVENTS_KV.get(EVENT_STATE_PREFIX + eventId);
  let state; try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
  const guest = state?.participants?.[guestIndex];
  if (!guest) return jsonResponse({ ok:false, error:'Guest not found' }, 404);
  const token = await signRsvpToken(env, { eventId, guestIndex, phone: String(guest['טלפון וואטסאפ'] || ''), name: String(guest['שם מלא / שם לקוח'] || ''), exp: Date.now() + 1000*60*60*24*45 });
  const url = new URL(request.url);
  const link = `${url.origin}/rsvp?t=${encodeURIComponent(token)}`;
  return jsonResponse({ ok:true, link });
}
async function rsvpPage(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('t') || '';
  const claims = await verifyRsvpToken(env, token);
  if (!claims?.eventId) return htmlResponse('<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:Arial;padding:24px"><h2>קישור אישור הגעה לא תקין או שפג תוקפו</h2></body>', 400);
  const raw = await env.EVENTS_KV?.get(EVENT_STATE_PREFIX + claims.eventId);
  let state; try { state = raw ? JSON.parse(raw) : {}; } catch { state = {}; }
  const guest = state?.participants?.[Number(claims.guestIndex)] || {};
  const name = escapeHtmlServer(guest['שם מלא / שם לקוח'] || claims.name || 'אורח/ת יקר/ה');
  const eventName = escapeHtmlServer(state?.eventSettings?.name || 'האירוע');
  const qty = Math.max(1, Number(guest['כמות מוזמנים']) || 1);
  return htmlResponse(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>אישור הגעה</title><style>body{font-family:Arial,sans-serif;background:#f6f7fb;margin:0;color:#101828}.box{max-width:520px;margin:28px auto;background:#fff;border:1px solid #e4e7ec;border-radius:20px;padding:24px;box-shadow:0 8px 28px #0001}.btn{width:100%;height:52px;border:0;border-radius:14px;font-size:18px;font-weight:800;margin:8px 0;cursor:pointer}.yes{background:#12b76a;color:#fff}.no{background:#f04438;color:#fff}.secondary{background:#fff;border:1px solid #d0d5dd;color:#344054}input{width:100%;height:48px;border:1px solid #d0d5dd;border-radius:12px;font-size:18px;padding:0 12px;box-sizing:border-box}.hidden{display:none}.status{font-weight:800;margin-top:12px;white-space:pre-wrap}</style></head><body><main class="box"><h1>אישור הגעה</h1><p>שלום ${name}, נשמח לדעת האם אתם מגיעים ל${eventName}.</p><button class="btn yes" onclick="showQty()">כן, אנחנו מגיעים ✅</button><button class="btn no" onclick="submitRsvp('לא מגיע')">לא נוכל להגיע</button><section id="qtyBox" class="hidden"><label>כמה מגיעים?</label><input id="qty" type="number" min="1" max="99" value="${qty}"><button class="btn yes" onclick="submitRsvp('אישר')">שליחת אישור</button><button class="btn secondary" onclick="document.getElementById('qtyBox').classList.add('hidden')">ביטול</button></section><div id="status" class="status"></div></main><script>const token=${JSON.stringify(token)};function showQty(){document.getElementById('qtyBox').classList.remove('hidden');document.getElementById('qty').focus()}async function submitRsvp(status){const el=document.getElementById('status');el.textContent='שומר תשובה...';try{const body={token,status,count:status==='אישר'?document.getElementById('qty').value:0};const r=await fetch('/api/rsvp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'שמירה נכשלה');el.textContent=d.message||'התשובה נשמרה, תודה רבה!';document.querySelectorAll('button,input').forEach(x=>x.disabled=true)}catch(e){el.textContent='לא הצלחנו לשמור: '+e.message}}</script></body></html>`);
}
async function rsvpSubmitApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok:false, error:'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const body = await request.json().catch(() => ({}));
  const claims = await verifyRsvpToken(env, body.token || '');
  if (!claims?.eventId) return jsonResponse({ ok:false, error:'קישור אישור הגעה לא תקין או שפג תוקפו' }, 400);
  const key = EVENT_STATE_PREFIX + claims.eventId;
  const raw = await env.EVENTS_KV.get(key);
  let state; try { state = raw ? JSON.parse(raw) : {}; } catch { state = {}; }
  const idx = Number(claims.guestIndex);
  const guest = state?.participants?.[idx];
  if (!guest) return jsonResponse({ ok:false, error:'המשתתף לא נמצא במערכת' }, 404);
  const status = String(body.status || '').includes('לא') ? 'לא מגיע' : 'אישר';
  guest['סטטוס אישור השתתפות'] = status;
  if (status === 'אישר') guest['כמות מוזמנים'] = String(Math.max(1, Math.min(99, Number(body.count) || 1)));
  guest['הערות'] = `${guest['הערות'] ? guest['הערות'] + ' | ' : ''}עודכן דרך קישור RSVP בתאריך ${new Date().toLocaleString('he-IL')}`;
  state.updatedAt = new Date().toISOString();
  await env.EVENTS_KV.put(key, JSON.stringify(state));
  return jsonResponse({ ok:true, eventId:claims.eventId, guestIndex:idx, status, count:guest['כמות מוזמנים'], message: status === 'אישר' ? `תודה! אישרנו הגעה עבור ${guest['כמות מוזמנים']} משתתפים.` : 'תודה על העדכון. סימנו שלא תוכלו להגיע.' });
}

async function eventStateApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const url = new URL(request.url);
  let eventId = url.searchParams.get('eventId');
  let body = null;
  if (request.method !== 'GET') {
    body = await request.json().catch(() => ({}));
    eventId = eventId || body.eventId;
  }
  eventId = String(eventId || '').trim();
  if (!eventId) return jsonResponse({ ok: false, error: 'Missing eventId' }, 400);
  const session = await requireEventAccess(request, env, eventId);
  if (!session) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  const key = EVENT_STATE_PREFIX + eventId;
  if (request.method === 'GET') {
    const raw = await env.EVENTS_KV.get(key);
    let state = null;
    try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
    return jsonResponse({ ok: true, eventId, state });
  }
  if (request.method === 'POST') {
    const state = body?.state;
    if (!state || typeof state !== 'object') return jsonResponse({ ok: false, error: 'Missing state' }, 400);
    const saved = { ...state, eventId, updatedAt: new Date().toISOString() };
    await env.EVENTS_KV.put(key, JSON.stringify(saved));
    return jsonResponse({ ok: true, eventId, state: saved });
  }
  return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
}

function summarizeStateForAi(state) {
  const participants = Array.isArray(state?.participants) ? state.participants : [];
  const hall = state?.hall || {};
  const vendors = Array.isArray(state?.vendors) ? state.vendors : [];
  const walletTx = Array.isArray(state?.walletTx) ? state.walletTx : [];
  return JSON.stringify({ eventSettings: state?.eventSettings || {}, participants, hall, vendors, walletTx }).slice(0, 90000);
}

async function eventAiApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const body = await request.json().catch(() => ({}));
  const eventId = String(body.eventId || '').trim();
  const question = String(body.question || '').trim();
  if (!eventId || !question) return jsonResponse({ ok: false, error: 'Missing eventId or question' }, 400);
  const session = await requireEventAccess(request, env, eventId);
  if (!session) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  const raw = await env.EVENTS_KV.get(EVENT_STATE_PREFIX + eventId);
  if (!raw) return jsonResponse({ ok: false, error: 'No event data was synced to DB yet' }, 404);
  let state;
  try { state = JSON.parse(raw); } catch { return jsonResponse({ ok: false, error: 'Invalid event data in DB' }, 500); }
  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ ok: false, error: 'OPENAI_API_KEY is not configured. DB sync is ready, but real AI needs an AI provider key.' }, 501);
  }
  const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'אתה עוזר AI לניהול אירוע. ענה בעברית, קצר וברור. השתמש רק בנתוני האירוע שנשלחו מה-DB. אם אין נתון, אמור שאין נתון במערכת. אל תמציא.' },
        { role: 'user', content: `נתוני האירוע מה-DB:\n${summarizeStateForAi(state)}\n\nשאלה: ${question}` }
      ]
    })
  });
  const aiText = await aiRes.text();
  let ai;
  try { ai = JSON.parse(aiText); } catch { ai = { raw: aiText }; }
  if (!aiRes.ok) return jsonResponse({ ok: false, error: ai.error?.message || 'AI request failed', details: ai }, 502);
  return jsonResponse({ ok: true, answer: ai.choices?.[0]?.message?.content || 'לא התקבלה תשובה מה-AI', eventId, updatedAt: state.updatedAt });
}

function defaultParticipant(n) {
  return {
    'מספר': n,
    'שם מלא / שם לקוח': '',
    'טלפון וואטסאפ': '',
    'קבוצה': '',
    'כמות מוזמנים': '1',
    'סטטוס אישור השתתפות': 'טרם נענה',
    'סכום לתשלום': '',
    'סטטוס תשלום': 'טרם שולם',
    'לינק תשלום/אסמכתא': '',
    'שולחן / אזור': '',
    'מיקום/אזור באולם': '',
    'העדפות/רגישויות מזון': '',
    'לא להושיב ליד': '',
    'הערות': ''
  };
}

function guestQty(g) { return Math.max(1, Number(g?.['כמות מוזמנים']) || 1); }
function tableOccupancyInState(state, table) {
  const participants = Array.isArray(state.participants) ? state.participants : [];
  return (table.guestIndexes || []).reduce((s, i) => s + guestQty(participants[i]), 0);
}
function findOrCreateTable(state, tableNumber, actionsLog) {
  state.hall = state.hall || { name: 'אולם מרכזי', columns: 5, feature: 'dance', tables: [] };
  state.hall.tables = Array.isArray(state.hall.tables) ? state.hall.tables : [];
  const id = Number(tableNumber);
  let table = state.hall.tables.find(t => Number(t.id) === id || String(t.name || '').includes(String(tableNumber)));
  if (!table) {
    table = { id, name: `שולחן ${id}`, capacity: 10, guestIndexes: [] };
    state.hall.tables.push(table);
    actionsLog.push(`נוצר שולחן ${id}`);
  }
  table.guestIndexes = Array.isArray(table.guestIndexes) ? table.guestIndexes : [];
  return table;
}
function findParticipantIndex(state, name) {
  const participants = Array.isArray(state.participants) ? state.participants : [];
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return -1;
  return participants.findIndex(g => String(g['שם מלא / שם לקוח'] || '').trim().toLowerCase() === needle);
}
function findParticipantIndexFlexible(state, name) {
  const exact = findParticipantIndex(state, name);
  if (exact >= 0) return exact;
  const participants = Array.isArray(state.participants) ? state.participants : [];
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return -1;
  return participants.findIndex(g => String(g['שם מלא / שם לקוח'] || '').toLowerCase().includes(needle) || needle.includes(String(g['שם מלא / שם לקוח'] || '').toLowerCase()));
}
function ensureParticipant(state, input, actionsLog) {
  state.participants = Array.isArray(state.participants) ? state.participants : [];
  const name = String(input.name || input.family || '').trim();
  if (!name) throw new Error('חסר שם משתתף/משפחה');
  let idx = state.participants.findIndex(g => String(g['שם מלא / שם לקוח'] || '').trim().toLowerCase() === name.toLowerCase());
  if (idx < 0) {
    idx = state.participants.findIndex(g => !g['שם מלא / שם לקוח'] && !g['טלפון וואטסאפ']);
    const row = defaultParticipant(idx >= 0 ? idx + 1 : state.participants.length + 1);
    if (idx >= 0) state.participants[idx] = row;
    else { state.participants.push(row); idx = state.participants.length - 1; }
    actionsLog.push(`נוסף משתתף/קבוצה: ${name}`);
  } else actionsLog.push(`עודכן משתתף/קבוצה קיימים: ${name}`);
  const g = state.participants[idx];
  g['מספר'] = idx + 1;
  g['שם מלא / שם לקוח'] = name;
  if (input.phone) g['טלפון וואטסאפ'] = String(input.phone);
  if (input.group) g['קבוצה'] = String(input.group);
  if (input.count || input.qty || input.people) g['כמות מוזמנים'] = String(input.count || input.qty || input.people);
  if (input.rsvp) g['סטטוס אישור השתתפות'] = String(input.rsvp);
  if (input.notes) g['הערות'] = String(input.notes);
  return { idx, guest: g };
}
function assignParticipantToTable(state, idx, tableNumber, actionsLog) {
  const g = state.participants[idx];
  const table = findOrCreateTable(state, tableNumber, actionsLog);
  state.hall.tables.forEach(t => { t.guestIndexes = (t.guestIndexes || []).filter(i => i !== idx); });
  const next = tableOccupancyInState(state, table) + guestQty(g);
  table.guestIndexes.push(idx);
  g['שולחן / אזור'] = table.name || `שולחן ${table.id}`;
  actionsLog.push(`${g['שם מלא / שם לקוח']} שובצו ב${g['שולחן / אזור']} (${next}/${table.capacity || 10} מקומות)`);
}
async function sendWhatsAppFromAgent(env, phone, message) {
  const idInstance = env.GREENAPI_ID_INSTANCE;
  const apiToken = env.GREENAPI_API_TOKEN_INSTANCE;
  if (!idInstance || !apiToken) throw new Error('Green API לא מוגדר במערכת');
  const chatId = normalizeChatId(phone);
  if (!chatId) throw new Error('חסר מספר וואטסאפ');
  const url = `https://api.green-api.com/waInstance${idInstance}/sendMessage/${apiToken}`;
  const upstream = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ chatId, message }) });
  const text = await upstream.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch { result = { raw:text }; }
  if (!upstream.ok) throw new Error(result?.message || result?.error || `Green API error ${upstream.status}`);
  return { chatId, result };
}
function defaultWhatsAppMessageForGuest(g, purpose) {
  const name = g?.['שם מלא / שם לקוח'] || 'אורח/ת יקר/ה';
  if (String(purpose || '').includes('אישור') || String(purpose || '').toLowerCase().includes('rsvp')) {
    return `היי ${name}, נשמח לדעת האם אתם מאשרים הגעה לאירוע. תודה רבה!`;
  }
  return `היי ${name}, רצינו לעדכן אותך לגבי האירוע.`;
}
async function applyAgentActions(state, actions, env) {
  const actionsLog = [];
  let needsFollowup = false;
  for (const action of actions || []) {
    if (action.type === 'ask_followup') {
      needsFollowup = true;
      actionsLog.push(action.question || 'חסר לי מידע כדי לבצע.');
    } else if (action.type === 'add_or_update_guest') {
      const { idx } = ensureParticipant(state, action, actionsLog);
      if (action.table) assignParticipantToTable(state, idx, action.table, actionsLog);
    } else if (action.type === 'assign_table') {
      const idx = findParticipantIndex(state, action.name || action.family);
      if (idx < 0) actionsLog.push(`לא מצאתי את ${action.name || action.family} לשיבוץ`);
      else assignParticipantToTable(state, idx, action.table, actionsLog);
    } else if (action.type === 'update_guest') {
      ensureParticipant(state, action, actionsLog);
    } else if (action.type === 'send_whatsapp') {
      let idx = findParticipantIndexFlexible(state, action.name || action.to);
      let guest = idx >= 0 ? state.participants[idx] : null;
      const phone = action.phone || guest?.['טלפון וואטסאפ'];
      if (!guest && !phone) { needsFollowup = true; actionsLog.push(`לא מצאתי את ${action.name || action.to || 'המשתתף'} במערכת. מה מספר הוואטסאפ?`); continue; }
      if (!phone) { needsFollowup = true; actionsLog.push(`מצאתי את ${guest['שם מלא / שם לקוח']}, אבל חסר מספר וואטסאפ. מה המספר?`); continue; }
      const message = action.message || defaultWhatsAppMessageForGuest(guest, action.purpose || action.message_type);
      await sendWhatsAppFromAgent(env, phone, message);
      state.whatsappLog = state.whatsappLog || {};
      const key = String(phone).replace(/\D/g,'');
      state.whatsappLog[key] = state.whatsappLog[key] || [];
      state.whatsappLog[key].unshift({ direction:'out', message, date:new Date().toISOString(), source:'agent', guest: guest?.['שם מלא / שם לקוח'] || action.name || '' });
      actionsLog.push(`שלחתי וואטסאפ ל${guest?.['שם מלא / שם לקוח'] || action.name || phone}: ${message}`);
    } else if (action.type === 'answer_only') {
      actionsLog.push(action.answer || 'אין פעולה לביצוע');
    }
  }
  state.participants?.forEach((g, i) => { g['מספר'] = i + 1; });
  state.updatedAt = new Date().toISOString();
  return { actionsLog, needsFollowup };
}

function extractPhoneFromText(text) {
  const m = String(text || '').match(/(?:טלפון|נייד|מספר)\s*[:\-]?\s*(\+?\d[\d\-\s]{7,}\d?)/) || String(text || '').match(/(\+?\d[\d\-\s]{8,}\d)/);
  return m?.[1] ? String(m[1]).replace(/[\s-]/g,'') : '';
}
function extractCountFromText(text) {
  const m = String(text || '').match(/(?:עם|כולל|יהיו|תהיו|אנחנו|הם)?\s*(\d+)\s*(?:משתתפים|מוזמנים|אנשים|מגיעים|אורחים|נפשות)/);
  return m?.[1] || '';
}
function extractTableFromText(text) {
  const m = String(text || '').match(/(?:שולחן|לשולחן|בשולחן)\s*(\d+)/);
  return m?.[1] || '';
}
function participantNameMentioned(state, text) {
  const lower = String(text || '').toLowerCase();
  const participants = Array.isArray(state?.participants) ? state.participants : [];
  let best = null;
  for (const g of participants) {
    const name = String(g['שם מלא / שם לקוח'] || '').trim();
    if (name && lower.includes(name.toLowerCase())) {
      if (!best || name.length > best.length) best = name;
    }
  }
  return best;
}
function cleanAgentName(raw) {
  return String(raw || '')
    .replace(/^(את|אל|ל|של)\s+/, '')
    .replace(/\s+(למערכת|לרשימה|באירוע|לאירוע)$/,'')
    .replace(/\s+$/, '')
    .trim();
}
function hasEventActionVerb(text) {
  return /(שלח|תשלח|לשלוח|הוסף|תוסיף|תכניס|הכנס|תרשום|רשום|עדכן|תעדכן|שבץ|תשבץ|מקם|תמקם|תושיב|סמן|תסמן|מחק|תמחק)/.test(String(text || ''));
}
function answerEventQuery(state, command) {
  const text = String(command || '');
  if (hasEventActionVerb(text)) return '';
  const participants = (Array.isArray(state?.participants) ? state.participants : []).filter(g => g['שם מלא / שם לקוח'] || g['טלפון וואטסאפ']);
  const totalPeople = participants.reduce((sum,g)=>sum+guestQty(g),0);
  if (/מי.*(משתתפים|מוזמנים|אורחים)|רשימת.*(משתתפים|מוזמנים|אורחים)/.test(text)) {
    if (!participants.length) return 'אין עדיין משתתפים רשומים באירוע.';
    return `כרגע רשומים ${participants.length} רשומות משתתפים / ${totalPeople} אנשים לפי כמות מוזמנים:\n` + participants.map((g,i)=>`${i+1}. ${g['שם מלא / שם לקוח']} — ${guestQty(g)} מוזמנים, ${g['סטטוס אישור השתתפות'] || 'ללא סטטוס'}${g['שולחן / אזור'] ? ', '+g['שולחן / אזור'] : ''}`).join('\n');
  }
  if (/כמה.*(משתתפים|מוזמנים|אורחים|אנשים)/.test(text)) return `כרגע יש ${participants.length} רשומות משתתפים, סה״כ ${totalPeople} אנשים לפי כמות מוזמנים.`;
  if (/מי.*(לא ענה|טרם|לא אישר)|טרם.*(ענו|אישרו)/.test(text)) {
    const pending = participants.filter(g => String(g['סטטוס אישור השתתפות'] || '').includes('טרם') || !g['סטטוס אישור השתתפות']);
    return pending.length ? `אלו עדיין לא אישרו הגעה:\n${pending.map(g=>`- ${g['שם מלא / שם לקוח']} (${guestQty(g)} מוזמנים)`).join('\n')}` : 'כולם עם סטטוס אישור שאינו “טרם נענה”.';
  }
  if (/מי.*(מאושר|אישר|מגיע)/.test(text)) {
    const ok = participants.filter(g => /מאושר|מגיע/.test(String(g['סטטוס אישור השתתפות'] || '')));
    return ok.length ? `אלו מאושרים/מגיעים:\n${ok.map(g=>`- ${g['שם מלא / שם לקוח']} (${guestQty(g)} מוזמנים)`).join('\n')}` : 'אין כרגע משתתפים שמסומנים כמאושרים.';
  }
  const name = participantNameMentioned(state, text);
  if (name && /איפה|איזה שולחן|שולחן/.test(text)) {
    const idx = findParticipantIndexFlexible(state, name);
    const g = idx >= 0 ? state.participants[idx] : null;
    return g ? `${name} משובץ/ת כרגע: ${g['שולחן / אזור'] || 'עדיין לא שובץ/ה לשולחן'}.` : '';
  }
  return '';
}
function isGenericAsk(actions) {
  return Array.isArray(actions) && actions.length === 1 && actions[0].type === 'ask_followup' && String(actions[0].question || '').includes('אני יכול לבצע פעולות');
}
function deterministicAgentActions(state, command) {
  const text = String(command || '');
  const answer = answerEventQuery(state, command);
  if (answer) return [{ type:'answer_only', answer }];
  return parseAgentActionsFallback(command, state);
}
function parseAgentActionsFallback(command, state={}) {
  const text = String(command || '');
  const table = extractTableFromText(text);
  const count = extractCountFromText(text);
  const phone = extractPhoneFromText(text);
  const mentioned = participantNameMentioned(state, text);

  const waMatch = text.match(/(?:שלח|תשלח|לשלוח).*?(?:וואטסאפ|הודעה).*?(?:ל|אל)\s+([^,\.\d]+?)(?:\s+\d|\s*,|\s+תשאל|\s+אם|$)/) || text.match(/(?:ל|אל)\s+([^,\.\d]+?)\s+(?:וואטסאפ|הודעה)/);
  if (waMatch || /וואטסאפ|הודעה/.test(text) && /שלח|תשלח|לשלוח/.test(text)) {
    const name = cleanAgentName(waMatch?.[1] || mentioned || '');
    const purpose = /אישור|מאשר|מאשרת|להגיע|הגעה/.test(text) ? 'אישור הגעה' : 'עדכון';
    return [{ type:'send_whatsapp', name, phone, purpose, message: deriveWhatsAppMessageFromCommand(command, name) }];
  }

  const phoneUpdate = text.match(/(?:תוסיף|הוסף|עדכן|תעדכן).*?(?:טלפון|מספר).*?(?:ל|של)\s+([^,\.\d]+?)\s+(\+?\d[\d\-\s]{7,}\d?)/) || text.match(/(?:ל|של)\s+([^,\.\d]+?)\s+(\+?\d[\d\-\s]{7,}\d?)/);
  if (phoneUpdate && /טלפון|מספר|נייד/.test(text)) return [{ type:'update_guest', name: cleanAgentName(phoneUpdate[1]), phone: phoneUpdate[2].replace(/[\s-]/g,'') }];

  const actionSegment = (text.match(/(?:תכניס|הכנס|הוסף|תוסיף|תרשום|רשום).*$/) || [text])[0];
  const familyMatch = actionSegment.match(/(?:משפחת|משפחה)\s+([^,\.]+?)(?:\s+למערכת|\s+לרשימה|\s+עם|\s+ותמקם|\s+ותשבץ|\s+לשולחן|\s+בשולחן|\s*,|$)/);
  const addMatch = actionSegment.match(/(?:תכניס|הכנס|הוסף|תוסיף|תרשום|רשום)\s+(?:את\s+)?([^,\.]+?)(?:\s+למערכת|\s+לרשימה|\s+עם|\s+ותמקם|\s+ותשבץ|\s+לשולחן|\s+בשולחן|\s+טלפון|\s*,|$)/);
  if (familyMatch || addMatch) {
    let name = familyMatch ? `משפחת ${familyMatch[1].trim()}` : cleanAgentName(addMatch[1]);
    const isFamily = name.includes('משפחת') || /משפחה/.test(text);
    const missing = [];
    if (!count) missing.push('כמה משתתפים/מוזמנים לרשום?');
    if (!phone) missing.push('מה מספר הטלפון לוואטסאפ?');
    if (missing.length && /תכניס|הכנס|הוסף|תוסיף|תרשום|רשום/.test(text)) {
      return [{ type: 'ask_followup', question: `כדי להוסיף את ${name} חסרים לי:\n${missing.map((m,i)=>`${i+1}. ${m}`).join('\n')}\nאפשר גם לציין שולחן אם תרצה לשבץ עכשיו.` }];
    }
    return [{ type:'add_or_update_guest', name, count, phone, table, group: isFamily ? 'משפחה' : '', rsvp:'טרם נענה' }];
  }

  const rsvpName = mentioned || cleanAgentName((text.match(/(?:את|של|ל)\s+([^,\.]+?)\s+(?:מאשר|מאשרת|מגיע|מגיעה|לא מגיע|לא מגיעה)/)||[])[1] || '');
  if (rsvpName && /מאשר|מאשרת|אישר|אישרה|מגיע|מגיעה|לא מגיע|לא מגיעה|ביטל|ביטלה/.test(text)) {
    let rsvp = /לא מגיע|לא מגיעה|ביטל|ביטלה|לא מאשר|לא מאשרת/.test(text) ? 'לא מגיע' : 'מאושר';
    return [{ type:'update_guest', name:rsvpName, rsvp }];
  }

  if (table) {
    const name = mentioned || cleanAgentName((text.match(/(?:שבץ|תשבץ|מקם|תמקם|להושיב|הושב)\s+(?:את\s+)?([^,\.]+?)\s+(?:לשולחן|בשולחן)/)||[])[1] || '');
    if (name) return [{ type:'assign_table', name, table }];
  }

  if (mentioned && (count || phone)) return [{ type:'update_guest', name:mentioned, count, phone }];
  return [{ type: 'ask_followup', question: 'אני איתך. מה לבצע באירוע? אפשר לכתוב חופשי, למשל: “תוסיף את משפחת כהן עם 4 מוזמנים, טלפון 052..., שולחן 7” או “מי עדיין לא אישר הגעה?”' }];
}

const AGENT_SCHEMA_PROMPT = `אתה סוכן אירועים אישי בתוך מערכת ניהול אירועים בעברית. התפקיד שלך: להבין הוראות חופשיות, לשאול רק כשחסר פרט קריטי, ולהפעיל כלים בטוחים על נתוני האירוע.

החזר JSON בלבד בפורמט {"actions":[...]} בלי טקסט נוסף.
פעולות מותרות: ask_followup {type,question}, add_or_update_guest {type,name,count,phone,group,rsvp,notes,table}, assign_table {type,name,table}, update_guest {type,name,count,phone,group,rsvp,notes}, send_whatsapp {type,name,phone,message,purpose}, answer_only {type,answer}.

כללים חשובים:
- אם המשתמש מבקש מידע על האירוע — ענה מתוך מצב האירוע, לא בפעולה כללית.
- אם המשתמש נתן שם+טלפון+מסר לשליחת וואטסאפ — החזר send_whatsapp. אל תשאל שוב על טלפון שכבר מופיע.
- אם המשתמש נתן הוראה חדשה, אל תמשיך שיחת follow-up קודמת אלא אם הטקסט מציין במפורש שהוא תשובה לשאלה.
- אל תמציא טלפונים, כמויות או שולחנות. אם חסר פרט קריטי — ask_followup בשאלה קצרה וממוקדת.
- בהוספת משתתף: שם נדרש. כמות וטלפון רצויים; אם חסרים, שאל. שולחן אופציונלי.
- בשיבוץ לשולחן: אם השולחן לא קיים, אפשר ליצור אותו.
- עדכן RSVP לפי מילים כמו מאושר/מגיע/לא מגיע/טרם נענה.
- כשמבקשים “תשאל אותו/אותה ...” בהודעת וואטסאפ, הפוך זאת לנוסח הודעה טבעי וקצר.

דוגמאות:
משתמש: "תכניס את משפחת ימיני עם 5 משתתפים לשולחן 5 טלפון 0528746137" => add_or_update_guest עם name=משפחת ימיני,count=5,phone=0528746137,table=5,group=משפחה.
משתמש: "שלח וואטסאפ לעמי 0528746137 תשאל אותו אם הוא מגיע" => send_whatsapp name=עמי,phone=0528746137,message="היי עמי, האם אתה מגיע לאירוע?".
משתמש: "מי עדיין לא אישר?" => answer_only עם תשובה לפי הנתונים.`;
async function planWithAnthropic(env, state, command) {
  const requested = env.ANTHROPIC_MODEL || 'claude-opus-4-7';
  const candidates = [...new Set([requested, 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-20250514'])];
  for (const model of candidates) {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 2200,
        temperature: 0,
        system: AGENT_SCHEMA_PROMPT,
        messages: [{ role: 'user', content: `מצב האירוע מה-DB:\n${summarizeStateForAi(state)}\n\nהוראת המשתמש בעברית:\n${command}` }]
      })
    });
    const txt = await anthropicRes.text();
    let parsed;
    try { parsed = JSON.parse(txt); } catch { continue; }
    if (!anthropicRes.ok) {
      const errType = parsed?.error?.type || parsed?.type || '';
      if (String(errType).includes('not_found') || String(parsed?.error?.message || '').includes('model')) continue;
      continue;
    }
    const content = parsed.content?.map(c => c.text || '').join('\n') || '{}';
    try { return JSON.parse(content).actions || parseAgentActionsFallback(command); }
    catch { return parseAgentActionsFallback(command); }
  }
  return parseAgentActionsFallback(command);
}
async function planWithOpenAi(env, state, command) {
  const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4.1',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: AGENT_SCHEMA_PROMPT },
        { role: 'user', content: `מצב האירוע:\n${summarizeStateForAi(state)}\n\nהוראת המשתמש בעברית:\n${command}` }
      ]
    })
  });
  const txt = await aiRes.text();
  let parsed;
  try { parsed = JSON.parse(txt); } catch { return parseAgentActionsFallback(command); }
  if (!aiRes.ok) return parseAgentActionsFallback(command);
  try { return JSON.parse(parsed.choices?.[0]?.message?.content || '{}').actions || parseAgentActionsFallback(command); }
  catch { return parseAgentActionsFallback(command); }
}
async function planAgentActionsWithAi(env, state, command) {
  const deterministic = deterministicAgentActions(state, command);
  if (!isGenericAsk(deterministic)) return deterministic;
  if (env.ANTHROPIC_API_KEY) return planWithAnthropic(env, state, command);
  if (env.OPENAI_API_KEY) return planWithOpenAi(env, state, command);
  return deterministic;
}



function deriveWhatsAppMessageFromCommand(command, recipientName='') {
  const text = String(command || '');
  let m = text.match(/תשאל(?:\s+אותו|\s+אותה|\s+את\s+[^,]+)?\s+(.+)$/);
  if (m?.[1]) return `היי ${recipientName || 'אורח/ת יקר/ה'}, ${m[1].trim().replace(/[?.!]*$/, '')}?`;
  m = text.match(/(?:תגיד|תכתוב|שלח(?:י)?(?:\s+לו|\s+לה)?)\s+(.+)$/);
  if (m?.[1] && !m[1].includes('וואטסאפ')) return m[1].trim();
  if (text.includes('אישור') || text.includes('מאשר') || text.includes('מאשרת')) return `היי ${recipientName || 'אורח/ת יקר/ה'}, נשמח לדעת האם אתם מאשרים הגעה לאירוע. תודה רבה!`;
  return '';
}
function repairAgentActions(state, command, actions) {
  const participants = Array.isArray(state.participants) ? state.participants : [];
  const text = String(command || '').toLowerCase();
  return (actions || []).map(action => {
    if (action.type !== 'send_whatsapp') return action;
    const phoneMatch = String(command || '').match(/(?:טלפון|נייד|מספר)\s*[:\-]?\s*(\+?\d[\d\-\s]{7,})/) || String(command || '').match(/(\+?\d[\d\-\s]{8,}\d)/);
    const currentName = String(action.name || action.to || '').trim();
    const badName = !currentName || ['אותה','אותו','לה','לו','אליו','אליה','הלקוח','הלקוחה'].includes(currentName);
    const found = participants.find(g => {
      const name = String(g['שם מלא / שם לקוח'] || '').trim();
      return name && text.includes(name.toLowerCase());
    });
    if ((badName || findParticipantIndexFlexible(state, currentName) < 0) && found) {
      return { ...action, name: found['שם מלא / שם לקוח'], phone: action.phone || phoneMatch?.[1], message: action.message || deriveWhatsAppMessageFromCommand(command, found['שם מלא / שם לקוח']) }; 
    }
    const m = String(command || '').match(/(?:וואטסאפ|הודעה)\s+ל([^,\.\d]+?)(?:\s+\d|\s*,|\s+תשאל|\s+אם|$)/);
    if (badName && m) return { ...action, name: m[1].trim(), phone: action.phone || phoneMatch?.[1], message: action.message || deriveWhatsAppMessageFromCommand(command, m[1].trim()) }; 
    return { ...action, phone: action.phone || phoneMatch?.[1], message: action.message || deriveWhatsAppMessageFromCommand(command, currentName) };
  });
}
async function eventAgentApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const body = await request.json().catch(() => ({}));
  const eventId = String(body.eventId || '').trim();
  const command = String(body.command || body.question || '').trim();
  if (!eventId || !command) return jsonResponse({ ok: false, error: 'Missing eventId or command' }, 400);
  const session = await requireEventAccess(request, env, eventId);
  if (!session) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  const key = EVENT_STATE_PREFIX + eventId;
  const raw = await env.EVENTS_KV.get(key);
  let state;
  try { state = raw ? JSON.parse(raw) : body.state || {}; } catch { state = body.state || {}; }
  if (!state || typeof state !== 'object') state = {};
  let actions = await planAgentActionsWithAi(env, state, command);
  actions = repairAgentActions(state, command, actions);
  const { actionsLog, needsFollowup } = await applyAgentActions(state, actions, env);
  if (!needsFollowup) await env.EVENTS_KV.put(key, JSON.stringify({ ...state, eventId, updatedAt: new Date().toISOString() }));
  return jsonResponse({ ok: true, eventId, actions, actionsLog, needsFollowup, answer: actionsLog.join('\n') || 'בוצע', state });
}

async function clientLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const id = String(body.eventId || '').trim();
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const events = await loadEvents(env);
  if (!events) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const ev = events.find(x => x.id === id);
  if (!ev) return jsonResponse({ ok: false, error: 'האירוע לא נמצא' }, 404);
  const expectedUser = ev.clientUsername || ev.owner || 'client';
  if ((username && username !== expectedUser) || password !== ev.clientPassword) {
    return jsonResponse({ ok: false, error: 'שם משתמש או סיסמה שגויים' }, 401);
  }
  return jsonResponse({ ok: true, event: ev, token: await signSession(env, { role: 'client', eventId: id, username: expectedUser }) });
}

function normalizeChatId(value) {
  let phone = String(value || '').trim();
  if (!phone) return '';
  if (phone.endsWith('@c.us') || phone.endsWith('@g.us')) return phone;
  phone = phone.replace(/\D/g, '');
  if (phone.startsWith('00')) phone = phone.slice(2);
  if (phone.startsWith('0')) phone = `972${phone.slice(1)}`;
  if (!phone.startsWith('972')) phone = `972${phone}`;
  return `${phone}@c.us`;
}

async function getWhatsAppHistory(request, env) {
  try {
    const idInstance = env.GREENAPI_ID_INSTANCE;
    const apiToken = env.GREENAPI_API_TOKEN_INSTANCE;
    if (!idInstance || !apiToken) return jsonResponse({ ok: false, error: 'Green API is not configured' }, 500);
    const body = await request.json().catch(() => ({}));
    const chatId = normalizeChatId(body.chatId || body.phone);
    const count = Math.min(Math.max(Number(body.count) || 50, 1), 100);
    if (!chatId) return jsonResponse({ ok: false, error: 'Missing phone/chatId' }, 400);
    const url = `https://api.green-api.com/waInstance${idInstance}/getChatHistory/${apiToken}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, count }),
    });
    const text = await upstream.text();
    let result;
    try { result = text ? JSON.parse(text) : []; } catch { result = { raw: text }; }
    if (!upstream.ok) return jsonResponse({ ok: false, status: upstream.status, result }, 502);
    return jsonResponse({ ok: true, chatId, messages: Array.isArray(result) ? result : (result.messages || result) });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || 'Unknown error' }, 500);
  }
}

async function sendWhatsApp(request, env) {
  try {
    const idInstance = env.GREENAPI_ID_INSTANCE;
    const apiToken = env.GREENAPI_API_TOKEN_INSTANCE;
    if (!idInstance || !apiToken) return jsonResponse({ ok: false, error: 'Green API is not configured' }, 500);
    const body = await request.json();
    const chatId = normalizeChatId(body.chatId || body.phone);
    const message = String(body.message || '').trim();
    if (!chatId || !message) return jsonResponse({ ok: false, error: 'Missing phone/chatId or message' }, 400);
    if (message.length > 3500) return jsonResponse({ ok: false, error: 'Message is too long' }, 400);
    const url = `https://api.green-api.com/waInstance${idInstance}/sendMessage/${apiToken}`;
    const upstream = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, message }) });
    const text = await upstream.text();
    let result;
    try { result = text ? JSON.parse(text) : {}; } catch { result = { raw: text }; }
    if (!upstream.ok) return jsonResponse({ ok: false, status: upstream.status, result }, 502);
    return jsonResponse({ ok: true, chatId, result });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || 'Unknown error' }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/admin-login' && request.method === 'POST') return adminLogin(request, env);
    if (url.pathname === '/api/auth/me') return jsonResponse({ ok: !!(await verifySession(request, env)), session: await verifySession(request, env) });
    if (url.pathname === '/api/events') return eventsApi(request, env);
    if (url.pathname === '/api/client-login' && request.method === 'POST') return clientLogin(request, env);
    if (url.pathname === '/api/event-state') return eventStateApi(request, env);
    if (url.pathname === '/api/rsvp-link' && request.method === 'POST') return rsvpLinkApi(request, env);
    if (url.pathname === '/api/rsvp' && request.method === 'POST') return rsvpSubmitApi(request, env);
    if (url.pathname === '/rsvp' && request.method === 'GET') return rsvpPage(request, env);
    if (url.pathname === '/api/event-ai' && request.method === 'POST') return eventAiApi(request, env);
    if (url.pathname === '/api/event-agent' && request.method === 'POST') return eventAgentApi(request, env);
    if (url.pathname === '/api/send-whatsapp') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      return sendWhatsApp(request, env);
    }
    if (url.pathname === '/api/whatsapp-history') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      return getWhatsAppHistory(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
