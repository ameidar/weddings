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

function eventClientUsers(ev) {
  const primary = { username: ev.clientUsername || ev.owner || 'client', password: ev.clientPassword || ev.password || '', name: ev.owner || 'לקוח ראשי' };
  const extra = Array.isArray(ev.clientUsers) ? ev.clientUsers : [];
  const users = [primary, ...extra]
    .map(u => ({ username: String(u.username || '').trim(), password: String(u.password || ''), name: String(u.name || u.label || '').trim(), email: String(u.email || '').trim(), phone: String(u.phone || '').trim() }))
    .filter(u => u.username && u.password);
  const seen = new Set();
  return users.filter(u => { const key = u.username.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
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
  const matchedUser = eventClientUsers(ev).find(u => u.username === username && u.password === password);
  if (!matchedUser) return jsonResponse({ ok: false, error: 'שם משתמש או סיסמה שגויים' }, 401);
  return jsonResponse({ ok: true, event: ev, user: { username: matchedUser.username, name: matchedUser.name }, token: await signSession(env, { role: 'client', eventId: id, username: matchedUser.username, name: matchedUser.name }) });
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
