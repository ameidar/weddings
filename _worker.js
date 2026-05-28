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
const EVENT_ASSISTANT_CHAT_PREFIX = 'event_assistant_chat_v1:';
const ADMIN_CONFIG_KEY = 'admin_config_v1';
const ADMIN_RESET_PREFIX = 'admin_password_reset_v1:';
const MORNING_WEBHOOK_PREFIX = 'morning_webhook_v1:';
const PAYMENT_SHORT_LINK_PREFIX = 'payment_short_link_v1:';
const RSVP_SHORT_LINK_PREFIX = 'rsvp_short_link_v1:';
const APPROVED_MESSAGE_HOSTS = ['wedding.orma-ai.com','orma-ai.com','morning.co.il','greeninvoice.co.il','payboxapp.page.link','waze.com','ul.waze.com','google.com','maps.google.com','goo.gl'];

function extractUrls(text) {
  return String(text || '').match(/https?:\/\/[^\s<>"]+/g) || [];
}

function approvedMessageHosts(request) {
  const host = new URL(request.url).hostname.toLowerCase();
  return Array.from(new Set([host, ...APPROVED_MESSAGE_HOSTS].filter(Boolean).map(x => x.toLowerCase())));
}

function validateApprovedMessageLinks(request, message) {
  const hosts = approvedMessageHosts(request);
  const blocked = extractUrls(message).filter(raw => {
    try {
      const url = new URL(String(raw).replace(/[),.;]+$/, ''));
      const host = url.hostname.toLowerCase();
      return !hosts.some(allowed => host === allowed || host.endsWith('.' + allowed));
    } catch {
      return true;
    }
  });
  return { ok: blocked.length === 0, blocked };
}

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
  const expectedHash = await adminPasswordHash(env);
  if (!expectedHash) return jsonResponse({ ok: false, error: 'Admin password is not configured' }, 503);
  const ok = username === expectedUser && safeEqual(await sha256Hex(password), expectedHash);
  if (!ok) return jsonResponse({ ok: false, error: 'שם משתמש או סיסמה שגויים' }, 401);
  return jsonResponse({ ok: true, token: await signSession(env, { role: 'admin', username }) });
}

async function adminPasswordHash(env) {
  if (env.EVENTS_KV) {
    const raw = await env.EVENTS_KV.get(ADMIN_CONFIG_KEY);
    try {
      const config = raw ? JSON.parse(raw) : null;
      if (config?.adminPasswordHash) return String(config.adminPasswordHash);
    } catch {}
  }
  return env.ADMIN_PASSWORD_HASH || (env.ADMIN_PASSWORD ? await sha256Hex(env.ADMIN_PASSWORD) : '');
}

function configuredAdminResetEmail(env) {
  return String(env.ADMIN_RESET_EMAIL || env.ADMIN_EMAIL || '').trim().toLowerCase();
}

async function sendResetEmail(env, to, link) {
  if (env.COMPOSIO_API_KEY && env.COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID) {
    return sendResetEmailViaComposioGmail(env, to, link);
  }
  if (!env.RESEND_API_KEY) return { ok: false, error: 'Email provider is not configured' };
  const from = env.RESET_FROM_EMAIL || 'Event Admin <onboarding@resend.dev>';
  const subject = 'איפוס סיסמה למערכת ניהול האירועים';
  const text = `שלום,\n\nקיבלנו בקשה לאיפוס סיסמת האדמין למערכת ניהול האירועים.\n\nלאיפוס הסיסמה יש לפתוח את הקישור הבא בתוך 30 דקות:\n${link}\n\nאם לא ביקשת איפוס, אפשר להתעלם מהמייל.`;
  const upstream = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  const body = await upstream.text();
  if (!upstream.ok) return { ok: false, error: body || `Email send failed (${upstream.status})` };
  return { ok: true };
}

async function composioRequest(env, path, body) {
  const upstream = await fetch(`https://backend.composio.dev${path}`, {
    method: 'POST',
    headers: { 'x-api-key': env.COMPOSIO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await upstream.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!upstream.ok) throw new Error(data?.error?.message || data?.message || text || `Composio request failed (${upstream.status})`);
  return data;
}

async function sendResetEmailViaComposioGmail(env, to, link) {
  const subject = 'איפוס סיסמה למערכת ניהול האירועים';
  const body = `שלום,\n\nקיבלנו בקשה לאיפוס סיסמת האדמין למערכת ניהול האירועים.\n\nלאיפוס הסיסמה יש לפתוח את הקישור הבא בתוך 30 דקות:\n${link}\n\nאם לא ביקשת איפוס, אפשר להתעלם מהמייל.`;
  try {
    const session = await composioRequest(env, '/api/v3.1/tool_router/session', {
      user_id: env.COMPOSIO_USER_ID || 'opal-agent',
      toolkits: { enable: ['gmail'] },
      connected_accounts: { gmail: [env.COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID] },
    });
    const sent = await composioRequest(env, `/api/v3.1/tool_router/session/${session.session_id}/execute`, {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: { recipient_email: to, subject, body },
    });
    if (sent?.error) return { ok: false, error: sent.error };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Gmail send failed' };
  }
}

async function requestAdminPasswordReset(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const resetEmail = configuredAdminResetEmail(env);
  if (!resetEmail) return jsonResponse({ ok: false, error: 'ADMIN_RESET_EMAIL is not configured' }, 501);
  if (!email) return jsonResponse({ ok: false, error: 'נא להזין אימייל' }, 400);
  // Do not reveal whether an email exists, but only send when it matches the configured admin reset email.
  if (email !== resetEmail) return jsonResponse({ ok: true, message: 'אם האימייל מורשה, נשלח אליו קישור איפוס.' });
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64url(bytes);
  const tokenHash = await sha256Hex(token);
  await env.EVENTS_KV.put(ADMIN_RESET_PREFIX + tokenHash, JSON.stringify({ email, exp: Date.now() + 1000 * 60 * 30 }), { expirationTtl: 60 * 30 });
  const url = new URL(request.url);
  const link = `${url.origin}/?adminReset=${encodeURIComponent(token)}`;
  const sent = await sendResetEmail(env, email, link);
  if (!sent.ok) return jsonResponse({ ok: false, error: sent.error || 'שליחת המייל נכשלה' }, 502);
  return jsonResponse({ ok: true, message: 'נשלח קישור איפוס לאימייל האדמין.' });
}

async function completeAdminPasswordReset(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '').trim();
  const password = String(body.password || '');
  if (!token || !password) return jsonResponse({ ok: false, error: 'Missing token or password' }, 400);
  if (password.length < 10) return jsonResponse({ ok: false, error: 'הסיסמה חייבת להיות באורך 10 תווים לפחות' }, 400);
  const key = ADMIN_RESET_PREFIX + await sha256Hex(token);
  const raw = await env.EVENTS_KV.get(key);
  let reset;
  try { reset = raw ? JSON.parse(raw) : null; } catch { reset = null; }
  if (!reset?.exp || reset.exp < Date.now()) return jsonResponse({ ok: false, error: 'קישור האיפוס אינו תקין או שפג תוקפו' }, 400);
  await env.EVENTS_KV.put(ADMIN_CONFIG_KEY, JSON.stringify({ adminPasswordHash: await sha256Hex(password), updatedAt: new Date().toISOString(), updatedBy: 'email-reset' }));
  await env.EVENTS_KV.delete(key);
  return jsonResponse({ ok: true, message: 'הסיסמה עודכנה בהצלחה. אפשר להתחבר עם הסיסמה החדשה.' });
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
  if (!token) return null;
  if (!String(token).includes('.') && env.EVENTS_KV) {
    const raw = await env.EVENTS_KV.get(RSVP_SHORT_LINK_PREFIX + String(token).trim());
    if (raw) {
      try {
        const json = JSON.parse(raw);
        if (json.exp && json.exp < Date.now()) return null;
        return json;
      } catch { return null; }
    }
    return null;
  }
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
  const claims = { eventId, guestIndex, phone: String(guest['טלפון וואטסאפ'] || ''), name: String(guest['שם מלא / שם לקוח'] || ''), exp: Date.now() + 1000*60*60*24*45 };
  const token = await signRsvpToken(env, claims);
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const code = base64url(bytes).slice(0, 7).toUpperCase();
  await env.EVENTS_KV.put(RSVP_SHORT_LINK_PREFIX + code, JSON.stringify(claims), { expirationTtl: 60 * 60 * 24 * 45 });
  const url = new URL(request.url);
  const publicOrigin = url.hostname.endsWith('.pages.dev') ? 'https://wedding.orma-ai.com' : url.origin;
  const link = `${publicOrigin}/r/${encodeURIComponent(code)}`;
  return jsonResponse({ ok:true, link, code, legacyLink: `${publicOrigin}/rsvp?t=${encodeURIComponent(token)}` });
}
async function rsvpPage(request, env) {
  const url = new URL(request.url);
  const pathCode = url.pathname.startsWith('/r/') ? decodeURIComponent(url.pathname.split('/').filter(Boolean)[1] || '') : '';
  const token = pathCode || url.searchParams.get('c') || url.searchParams.get('t') || '';
  const claims = await verifyRsvpToken(env, token);
  if (!claims?.eventId) return htmlResponse('<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:Assistant,Arial,sans-serif;padding:24px"><h2>קישור אישור הגעה לא תקין או שפג תוקפו</h2></body>', 400);
  const raw = await env.EVENTS_KV?.get(EVENT_STATE_PREFIX + claims.eventId);
  let state; try { state = raw ? JSON.parse(raw) : {}; } catch { state = {}; }
  const settings = state?.eventSettings || {};
  const guest = state?.participants?.[Number(claims.guestIndex)] || {};
  const name = escapeHtmlServer(guest['שם מלא / שם לקוח'] || claims.name || 'אורח/ת יקר/ה');
  const eventName = escapeHtmlServer(settings.name || 'האירוע');
  const eventType = escapeHtmlServer(settings.type || 'אירוע');
  const eventDateRaw = String(settings.date || '').trim();
  const eventDate = escapeHtmlServer(eventDateRaw ? new Date(eventDateRaw + 'T00:00:00').toLocaleDateString('he-IL') : 'תאריך יעודכן בהמשך');
  const venue = escapeHtmlServer(settings.venue || 'מיקום יעודכן בהמשך');
  const address = escapeHtmlServer(settings.venueAddress || settings.venue || '');
  const qty = Math.max(1, Number(guest['כמות מוזמנים']) || 1);
  const bg = String(settings.invitationBackground || '').startsWith('data:image/') ? settings.invitationBackground : '';
  const navigateQuery = encodeURIComponent([settings.venue, settings.venueAddress].filter(Boolean).join(', '));
  const navLink = navigateQuery ? `https://www.google.com/maps/search/?api=1&query=${navigateQuery}` : '#';
  const calDates = eventDateRaw ? `${eventDateRaw.replaceAll('-','')}T160000Z/${eventDateRaw.replaceAll('-','')}T210000Z` : '';
  const calLink = calDates ? `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(settings.name || 'אירוע')}&dates=${calDates}&location=${encodeURIComponent([settings.venue, settings.venueAddress].filter(Boolean).join(', '))}` : '#';
  const currentStatus = escapeHtmlServer(guest['סטטוס אישור השתתפות'] || 'טרם נענה');
  return htmlResponse(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>אישור הגעה - ${eventName}</title><style>@import url("https://fonts.googleapis.com/css2?family=Assistant:wght@300;400;500;600;700;800&display=swap");*{box-sizing:border-box}body{font-family:Assistant,Arial,sans-serif;background:linear-gradient(180deg,#f5efe7,#fbfaf7);margin:0;color:#21160f}.wrap{max-width:430px;margin:0 auto;min-height:100vh;background:#fff;box-shadow:0 18px 60px #2b170d20}.hero{min-height:220px;background:${bg ? `linear-gradient(180deg,#0002,#0007),url(${bg}) center/cover` : 'linear-gradient(135deg,#1e130c,#8b6f47,#d8b07a)'};color:#fff;display:flex;align-items:end;justify-content:center;text-align:center;padding:28px 24px}.hero h1{margin:0;font-size:38px;letter-spacing:.5px;line-height:1}.hero p{margin:8px 0 0;font-size:15px;opacity:.92}.card{padding:22px 22px 30px}.hello{text-align:center;font-size:18px;margin:0 0 18px}.details{display:grid;gap:12px;margin:16px 0}.detail{display:grid;grid-template-columns:34px 1fr;gap:10px;align-items:center;border-bottom:1px solid #eee2d5;padding:0 0 12px}.ico{width:34px;height:34px;border-radius:50%;background:#f4eadc;color:#8b5e2b;display:flex;align-items:center;justify-content:center;font-size:19px}.detail b{display:block;font-size:16px}.detail span{display:block;color:#6f6259;font-size:14px;margin-top:2px}.rings{text-align:center;color:#b78a50;font-size:28px;margin:6px 0 2px}.choice-title{text-align:center;font-weight:900;margin:18px 0 10px}.choices{display:grid;grid-template-columns:1fr 1fr 1.35fr;gap:8px;direction:rtl}.choice{border:1px solid #e6d8c7;background:#fff;border-radius:16px;min-height:54px;font-size:16px;font-weight:900;color:#3a2a1f;cursor:pointer}.choice.active,.choice:hover{background:#1f7a4d;color:#fff;border-color:#1f7a4d}.choice.maybe.active,.choice.maybe:hover{background:#c98222;border-color:#c98222}.choice.no.active,.choice.no:hover{background:#a43c34;border-color:#a43c34}.qtyBox,.submitBox{display:none;margin-top:14px}.qtyBox.open,.submitBox.open{display:block}.qtyBox label,.submitBox label{font-weight:800}.qtyRow{display:grid;grid-template-columns:1fr 1.25fr;gap:10px;margin-top:8px}input{width:100%;height:52px;border:1px solid #d8c8b5;border-radius:14px;font-size:20px;padding:0 12px;text-align:center}.cta{width:100%;height:54px;border:0;border-radius:16px;background:#1f7a4d;color:#fff;font-size:18px;font-weight:900;cursor:pointer}.cta.secondary{background:#efe6da;color:#2d2118}.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}.actions a{text-decoration:none;text-align:center;border:1px solid #e6d8c7;border-radius:15px;padding:13px 8px;color:#3a2a1f;font-weight:900;background:#fff}.status{font-weight:900;margin-top:14px;white-space:pre-wrap;text-align:center;color:#1f7a4d}.brand{text-align:center;color:#9b8c7d;font-size:12px;padding:12px 0 20px}.hidden{display:none}@media(max-width:460px){.wrap{max-width:none}.hero h1{font-size:34px}.choices{grid-template-columns:1fr}.actions{grid-template-columns:1fr}}</style></head><body><main class="wrap"><section class="hero"><div><h1>${eventName}</h1><p>${eventType} · ${eventDate}</p></div></section><section class="card"><p class="hello">שלום ${name}, נשמח לעדכון הגעה לאירוע</p><div class="details"><div class="detail"><div class="ico">📅</div><div><b>${eventDate}</b><span>תאריך האירוע</span></div></div><div class="detail"><div class="ico">📍</div><div><b>${venue}</b><span>${address || 'כתובת תעודכן בהמשך'}</span></div></div></div><div class="rings">💍</div><div class="choice-title">האם תגיעו?</div><div class="choices"><button id="yesBtn" class="choice" onclick="selectStatus('אישר')">נגיע</button><button id="maybeBtn" class="choice maybe" onclick="selectStatus('אולי')">אולי</button><button id="noBtn" class="choice no" onclick="selectStatus('לא מגיע')">לא נוכל להגיע</button></div><section id="qtyBox" class="qtyBox"><label>בחירת כמות משתתפים</label><div class="qtyRow"><input id="qty" type="number" min="1" max="99" value="${qty}"><button class="cta" onclick="submitRsvp()">שליחת אישור</button></div></section><section id="submitBox" class="submitBox"><label>לאחר הבחירה, לחצו לשליחת התשובה</label><button class="cta secondary" onclick="submitRsvp()">שליחת תשובה</button></section><div class="actions"><a href="${navLink}" target="_blank" rel="noopener">ניווט לאירוע</a><a href="${calLink}" target="_blank" rel="noopener">הוספה ליומן</a></div><div id="status" class="status">סטטוס נוכחי: ${currentStatus}</div></section><div class="brand">powered by Orma</div></main><script>const token=${JSON.stringify(token)};let selected='';function setActive(){document.getElementById('yesBtn').classList.toggle('active',selected==='אישר');document.getElementById('maybeBtn').classList.toggle('active',selected==='אולי');document.getElementById('noBtn').classList.toggle('active',selected==='לא מגיע');document.getElementById('qtyBox').classList.toggle('open',selected==='אישר');document.getElementById('submitBox').classList.toggle('open',selected==='אולי'||selected==='לא מגיע')}function selectStatus(s){selected=s;setActive();document.getElementById('status').textContent=s==='אישר'?'בחרו כמות ולחצו שליחת אישור':'לחצו שליחת תשובה כדי לעדכן את המערכת'}async function submitRsvp(){const el=document.getElementById('status');if(!selected)selected='אישר';el.textContent='שומר תשובה...';try{const body={token,status:selected,count:selected==='אישר'?document.getElementById('qty').value:0};const r=await fetch('/api/rsvp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'שמירה נכשלה');el.textContent=d.message||'התשובה נשמרה, תודה רבה!'}catch(e){el.textContent='לא הצלחנו לשמור: '+e.message}}setActive();</script></body></html>`);
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
  const rawStatus = String(body.status || '');
  const status = rawStatus.includes('לא') ? 'לא מגיע' : rawStatus.includes('אולי') ? 'אולי' : 'אישר';
  guest['סטטוס אישור השתתפות'] = status;
  if (status === 'אישר') guest['כמות מוזמנים'] = String(Math.max(1, Math.min(99, Number(body.count) || 1)));
  guest['הערות'] = `${guest['הערות'] ? guest['הערות'] + ' | ' : ''}עודכן דרך קישור RSVP בתאריך ${new Date().toLocaleString('he-IL')}`;
  state.updatedAt = new Date().toISOString();
  await env.EVENTS_KV.put(key, JSON.stringify(state));
  const message = status === 'אישר' ? `תודה! אישרנו הגעה עבור ${guest['כמות מוזמנים']} משתתפים.` : status === 'אולי' ? 'תודה על העדכון. סימנו כרגע “אולי”.' : 'תודה על העדכון. סימנו שלא תוכלו להגיע.';
  return jsonResponse({ ok:true, eventId:claims.eventId, guestIndex:idx, status, count:guest['כמות מוזמנים'], message });
}


async function pendingParticipantsApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const eventId = String(new URL(request.url).searchParams.get('eventId') || '').trim();
  if (!eventId) return jsonResponse({ ok: false, error: 'Missing eventId' }, 400);
  const session = await requireEventAccess(request, env, eventId);
  if (!session) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  const raw = await env.EVENTS_KV.get(EVENT_STATE_PREFIX + eventId);
  let state = null;
  try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
  return jsonResponse({ ok: true, eventId, pendingParticipants: Array.isArray(state?.pendingParticipants) ? state.pendingParticipants : [] });
}

function sanitizeEventStateForTenant(state, eventId) {
  const src = state && typeof state === 'object' ? state : {};
  const saved = { ...src, eventId, updatedAt: new Date().toISOString() };
  saved.eventSettings = { ...(src.eventSettings && typeof src.eventSettings === 'object' ? src.eventSettings : {}), id: eventId };
  for (const key of ['participants', 'vendors', 'walletTx', 'payments', 'pendingParticipants']) {
    if (Array.isArray(saved[key])) saved[key] = saved[key].map(item => item && typeof item === 'object' ? { ...item, eventId } : item);
  }
  if (saved.hall && typeof saved.hall === 'object') saved.hall = { ...saved.hall, eventId };
  if (saved.paymentAutomation && typeof saved.paymentAutomation === 'object') saved.paymentAutomation = { ...saved.paymentAutomation, eventId };
  return saved;
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
    const saved = sanitizeEventStateForTenant(state, eventId);
    await env.EVENTS_KV.put(key, JSON.stringify(saved));
    return jsonResponse({ ok: true, eventId, state: saved });
  }
  return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
}

function eventAssistantChatKey(eventId, session = {}) {
  const who = session.role === 'admin' ? 'admin' : String(session.username || session.name || 'client').trim().toLowerCase() || 'client';
  return `${EVENT_ASSISTANT_CHAT_PREFIX}${eventId}:${who}`;
}

function sanitizeAssistantHistory(messages, limit = 24) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => ({
      role: m?.role === 'assistant' || m?.role === 'bot' ? 'assistant' : 'user',
      content: String(m?.content || m?.text || '').trim().slice(0, 1200),
      ts: m?.ts || m?.time || new Date().toISOString(),
    }))
    .filter((m) => m.content)
    .slice(-limit);
}

async function loadEventAssistantHistory(env, eventId, session) {
  const raw = await env.EVENTS_KV.get(eventAssistantChatKey(eventId, session));
  try { return sanitizeAssistantHistory(raw ? JSON.parse(raw) : [], 30); } catch { return []; }
}

async function saveEventAssistantHistory(env, eventId, session, messages) {
  await env.EVENTS_KV.put(eventAssistantChatKey(eventId, session), JSON.stringify(sanitizeAssistantHistory(messages, 60)));
}

async function eventAssistantHistoryApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const url = new URL(request.url);
  let body = {};
  if (request.method !== 'GET') body = await request.json().catch(() => ({}));
  const eventId = String(url.searchParams.get('eventId') || body.eventId || '').trim();
  if (!eventId) return jsonResponse({ ok:false, error:'Missing eventId' }, 400);
  const session = await requireEventAccess(request, env, eventId);
  if (!session) return jsonResponse({ ok:false, error:'Unauthorized' }, 401);
  if (request.method === 'GET') return jsonResponse({ ok:true, eventId, messages: await loadEventAssistantHistory(env, eventId, session) });
  if (request.method === 'DELETE') { await env.EVENTS_KV.put(eventAssistantChatKey(eventId, session), JSON.stringify([])); return jsonResponse({ ok:true, eventId, messages: [] }); }
  return jsonResponse({ ok:false, error:'Method not allowed' }, 405);
}

function eventAssistantStateSnapshot(state) {
  const participants = Array.isArray(state?.participants) ? state.participants.filter(g => g && (g['שם מלא / שם לקוח'] || g['טלפון וואטסאפ'])) : [];
  const qty = g => Math.max(1, Number(g?.['כמות מוזמנים']) || 1);
  const status = g => String(g?.['סטטוס אישור השתתפות'] || 'טרם נענה');
  const confirmed = participants.filter(g => /אישר|מאושר|מגיע/.test(status(g)) && !/לא מגיע/.test(status(g)));
  const declined = participants.filter(g => /לא מגיע|ביטל|סירב/.test(status(g)));
  const pending = participants.filter(g => !confirmed.includes(g) && !declined.includes(g));
  const assigned = participants.filter(g => g['שולחן / אזור']);
  const vendors = Array.isArray(state?.vendors) ? state.vendors : [];
  const walletTx = Array.isArray(state?.walletTx) ? state.walletTx : [];
  const groupBy = field => participants.reduce((acc,g)=>{ const key=String(g?.[field] || 'לא שויך').trim() || 'לא שויך'; acc[key]=acc[key]||{records:0,people:0,pending:0,confirmed:0,declined:0}; acc[key].records+=1; acc[key].people+=qty(g); if(confirmed.includes(g)) acc[key].confirmed+=qty(g); else if(declined.includes(g)) acc[key].declined+=qty(g); else acc[key].pending+=qty(g); return acc; },{});
  return { settings: state?.eventSettings || {}, participants, vendors, walletTx, qty, totalPeople: participants.reduce((s,g)=>s+qty(g),0), confirmed, confirmedPeople: confirmed.reduce((s,g)=>s+qty(g),0), declined, declinedPeople: declined.reduce((s,g)=>s+qty(g),0), pending, pendingPeople: pending.reduce((s,g)=>s+qty(g),0), assigned, bySide:groupBy('צד באירוע'), byInviter:groupBy('גורם מזמין') };
}
function eventAssistantName(state) { return String(state?.eventSettings?.assistantName || 'עוזר האירוע האישי').trim(); }
function eventAssistantIntro(state) {
  const snap = eventAssistantStateSnapshot(state), s = snap.settings;
  return `היי, אני ${eventAssistantName(state)}. אני העוזר האישי של ${s.name || 'האירוע שלך'}${s.owner ? ' עבור ' + s.owner : ''}.\nאני יכול לענות על מצב אישורי הגעה, משתתפים, שולחנות, ספקים ומשימות; וגם לעזור לעדכן נתונים כשמבקשים פעולה ברורה.`;
}
function eventAssistantTasks(state) {
  const snap = eventAssistantStateSnapshot(state), s = snap.settings;
  const tasks = [];
  if (!s.date) tasks.push('להגדיר תאריך אירוע.');
  if (!s.venue) tasks.push('להשלים מקום/אולם אירוע.');
  if (snap.pending.length) tasks.push(`לטפל באישורי הגעה: ${snap.pending.length} רשומות / ${snap.pendingPeople} אנשים עדיין ללא אישור.`);
  const missingPhones = snap.participants.filter(g => !g['טלפון וואטסאפ']);
  if (missingPhones.length) tasks.push(`להשלים מספרי וואטסאפ ל-${missingPhones.length} משתתפים.`);
  const unassigned = snap.participants.filter(g => !g['שולחן / אזור']);
  if (unassigned.length) tasks.push(`לשבץ לשולחנות ${unassigned.reduce((sum,g)=>sum+snap.qty(g),0)} אנשים.`);
  const openVendors = snap.vendors.filter(v => !/סגור|שולם|הושלם/.test(String(v.status || '')));
  if (openVendors.length) tasks.push(`לסגור סטטוס מול ${openVendors.length} ספקים פתוחים.`);
  if (!tasks.length) tasks.push('האירוע נראה מסודר. מומלץ לבצע בדיקת RSVP, שולחנות והודעות אחרונה.');
  return `לוח משימות עבור ${s.name || 'האירוע'}:\n${tasks.map((t,i)=>`${i+1}. ${t}`).join('\n')}`;
}
function findGuestByName(state, rawName) {
  const name = String(rawName || '').trim().toLowerCase();
  if (!name) return { index: -1, guest: null };
  const participants = Array.isArray(state.participants) ? state.participants : [];
  let index = participants.findIndex(g => String(g['שם מלא / שם לקוח'] || '').trim().toLowerCase() === name);
  if (index < 0) index = participants.findIndex(g => { const n = String(g['שם מלא / שם לקוח'] || '').trim().toLowerCase(); return n && (n.includes(name) || name.includes(n)); });
  return { index, guest: index >= 0 ? participants[index] : null };
}
function cleanEventAssistantName(value) { return String(value || '').replace(/^(את|אל|ל|של)\s+/, '').replace(/\s+(למערכת|לרשימה|באירוע|לאירוע)$/,'').trim(); }
function cleanAssistantRecipient(value) {
  return cleanEventAssistantName(String(value || '')
    .replace(/^(?:את|אל)\s+/, '')
    .replace(/^ל(?=[א-ת]{2,}\s+[א-ת]{2,})/, '')
    .replace(/\s+(?:בבקשה|עכשיו|היום|מחר|והוא.*|והיא.*)$/,'')
    .trim());
}
function extractAssistantRecipientName(text) {
  const raw = String(text || '');
  const patterns = [
    /(?:אישור הגעה|בקשת אישור|בקשה לאישור הגעה|rsvp)\s+(?:ל|אל)\s*([^,.!?：:\n]+)/i,
    /(?:וואטסאפ|הודעה|תזכורת)\s+(?:ל|אל)\s*([^,.!?：:\n]+)/i,
    /(?:שלח|תשלח|שלחי|שלחו)\s+.*?(?:ל|אל)\s*([^,.!?：:\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const name = cleanAssistantRecipient(match?.[1] || '');
    if (name) return name;
  }
  return '';
}
function extractAssistantCount(text) { const m = String(text || '').match(/(\d+)\s*(?:משתתפים|מוזמנים|אנשים|מגיעים|אורחים|נפשות)/); return m ? Number(m[1]) : 0; }
function extractAssistantPhone(text) { const m = String(text || '').match(/(\+?\d[\d\-\s]{8,}\d)/); return m ? m[1].replace(/[\s-]/g,'') : ''; }
function normalizeEventAction(action) {
  return String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeRsvp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/לא\s*(מגיע|יגיע|מאשר|אישר)|declin|no/i.test(raw)) return 'לא מגיע';
  if (/טרם|ממתין|pending|unknown/i.test(raw)) return 'טרם נענה';
  if (/אישר|מאשר|מגיע|יגיע|כן|confirmed|yes/i.test(raw)) return 'אישר';
  return raw;
}

function normalizeTable(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^שולחן\s+/i.test(raw) ? raw : `שולחן ${raw.replace(/^table\s*/i, '').trim()}`;
}

function normalizeInvitationTone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/כלה/.test(raw) && /הור/.test(raw)) return 'בשם הורי הכלה';
  if (/חתן/.test(raw) && /הור/.test(raw)) return 'בשם הורי החתן';
  if (/כלה/.test(raw)) return 'בשם הכלה';
  if (/חתן/.test(raw)) return 'בשם החתן';
  if (/זוג|בעלי/.test(raw)) return 'בשם הזוג';
  if (/משפחה/.test(raw)) return 'בשם המשפחה';
  if (/רשמי/.test(raw)) return 'רשמי';
  return raw;
}

function appendGuestNote(guest, note) {
  note = String(note || '').trim();
  if (!note) return;
  const existing = String(guest['הערות'] || '').trim();
  if (existing.includes(note)) return;
  guest['הערות'] = existing ? `${existing} | ${note}` : note;
}

function nextParticipantNumber(state) {
  const participants = Array.isArray(state.participants) ? state.participants : [];
  return participants.reduce((max, g) => Math.max(max, Number(g?.['מספר']) || 0), 0) + 1;
}

function executeEventAction(state, action, payload = {}) {
  state.participants = Array.isArray(state.participants) ? state.participants : [];
  state.eventSettings = state.eventSettings || {};
  const type = normalizeEventAction(action || payload.action);
  const name = cleanEventAssistantName(payload.name || payload.guestName || payload.participantName || '');
  const count = Number(payload.count || payload.guestCount || payload.quantity || 0);
  const table = payload.table || payload.tableNumber || payload.seating || '';
  const rsvp = normalizeRsvp(payload.rsvp || payload.status || '');
  const phone = String(payload.phone || payload.whatsapp || '').trim();
  const note = String(payload.note || payload.notes || '').trim();
  const side = String(payload.side || payload.eventSide || payload.guestSide || '').trim();
  const inviter = String(payload.inviter || payload.invitedBy || payload.sender || payload.host || '').trim();
  const relation = String(payload.relation || payload.relationship || payload.groupRelation || '').trim();
  const invitationTone = normalizeInvitationTone(payload.invitationTone || payload.tone || payload.messageTone || '');

  if (type === 'get_summary') {
    return { ok:true, changed:false, intent:'query', answer: answerEventAssistantQuery(state, 'מצב האירוע') };
  }
  if (type === 'list_pending_rsvp') {
    return { ok:true, changed:false, intent:'query', answer: answerEventAssistantQuery(state, 'מי טרם אישר') };
  }
  if (type === 'rename_assistant') {
    const assistantName = cleanEventAssistantName(payload.assistantName || name);
    if (!assistantName) return { ok:false, changed:false, intent:'clarify', error:'missing_assistant_name', answer:'איזה שם לתת לעוזר?' };
    state.eventSettings.assistantName = assistantName;
    return { ok:true, changed:true, intent:'action', answer:`מעולה, מעכשיו אפשר לקרוא לי ${assistantName}.` };
  }
  if (type === 'add_guest') {
    if (!name) return { ok:false, changed:false, intent:'clarify', error:'missing_name', answer:'את מי להוסיף?' };
    if (!count) return { ok:false, changed:false, intent:'clarify', error:'missing_count', answer:`כמה מוזמנים לרשום עבור ${name}?` };
    const existing = findGuestByName(state, name);
    if (existing.guest && !payload.allowUpdateExisting) {
      return { ok:false, changed:false, intent:'clarify', error:'guest_exists', answer:`${existing.guest['שם מלא / שם לקוח']} כבר קיים/ת ברשימת המשתתפים. האם לעדכן את הרשומה הקיימת?` };
    }
    const guest = existing.guest || { 'מספר': nextParticipantNumber(state), 'שם מלא / שם לקוח': name, 'סטטוס אישור השתתפות':'טרם נענה', 'סטטוס תשלום':'טרם שולם' };
    guest['שם מלא / שם לקוח'] = name;
    guest['כמות מוזמנים'] = String(count);
    if (phone) guest['טלפון וואטסאפ'] = phone;
    if (side) guest['צד באירוע'] = side;
    if (inviter) guest['גורם מזמין'] = inviter;
    if (relation) guest['קרבה למזמין'] = relation;
    if (invitationTone) guest['נוסח פנייה'] = invitationTone;
    if (rsvp) guest['סטטוס אישור השתתפות'] = rsvp;
    if (table) guest['שולחן / אזור'] = normalizeTable(table);
    appendGuestNote(guest, note);
    if (!existing.guest) state.participants.push(guest);
    state.participants.forEach((g,i)=>g['מספר']=i+1);
    return { ok:true, changed:true, intent:'action', action:type, answer:`הוספתי את ${name} עם ${count} מוזמנים${rsvp ? `, סטטוס ${rsvp}` : ''}${table ? ` ושיבוץ ל${normalizeTable(table)}` : ''}.`, guest };
  }
  if (type === 'update_guest') {
    if (!name) return { ok:false, changed:false, intent:'clarify', error:'missing_name', answer:'את מי לעדכן?' };
    const found = findGuestByName(state, name);
    if (!found.guest) return { ok:false, changed:false, intent:'clarify', error:'guest_not_found', answer:`לא מצאתי את ${name} ברשימת המשתתפים. אם זה משתתף חדש, כתבו “הוסף את ${name}”.` };
    const updates = [];
    if (count > 0) { found.guest['כמות מוזמנים'] = String(count); updates.push(`${count} מוזמנים`); }
    if (phone) { found.guest['טלפון וואטסאפ'] = phone; updates.push('טלפון'); }
    if (side) { found.guest['צד באירוע'] = side; updates.push(`צד ${side}`); }
    if (inviter) { found.guest['גורם מזמין'] = inviter; updates.push(`גורם מזמין ${inviter}`); }
    if (relation) { found.guest['קרבה למזמין'] = relation; updates.push(`קרבה ${relation}`); }
    if (invitationTone) { found.guest['נוסח פנייה'] = invitationTone; updates.push(`נוסח ${invitationTone}`); }
    if (rsvp) { found.guest['סטטוס אישור השתתפות'] = rsvp; updates.push(`סטטוס ${rsvp}`); }
    if (table) { found.guest['שולחן / אזור'] = normalizeTable(table); updates.push(found.guest['שולחן / אזור']); }
    if (note) { appendGuestNote(found.guest, note); updates.push(note); }
    if (!updates.length) return { ok:false, changed:false, intent:'clarify', error:'missing_updates', answer:`מה לעדכן עבור ${found.guest['שם מלא / שם לקוח']}?` };
    return { ok:true, changed:true, intent:'action', action:type, answer:`עדכנתי את ${found.guest['שם מלא / שם לקוח']}: ${updates.join(', ')}.`, guest: found.guest };
  }
  if (type === 'assign_table') {
    if (!name) return { ok:false, changed:false, intent:'clarify', error:'missing_name', answer:'את מי לשבץ?' };
    if (!table) return { ok:false, changed:false, intent:'clarify', error:'missing_table', answer:'לאיזה שולחן לשבץ?' };
    const found = findGuestByName(state, name);
    if (!found.guest) return { ok:false, changed:false, intent:'clarify', error:'guest_not_found', answer:`לא מצאתי את ${name} ברשימת המשתתפים. אם זה משתתף חדש, צריך קודם להוסיף אותו.` };
    found.guest['שולחן / אזור'] = normalizeTable(table);
    return { ok:true, changed:true, intent:'action', action:type, answer:`שיבצתי את ${found.guest['שם מלא / שם לקוח']} ל${found.guest['שולחן / אזור']}.`, guest: found.guest };
  }
  if (type === 'prepare_whatsapp') {
    const found = findGuestByName(state, name);
    const targetName = found.guest?.['שם מלא / שם לקוח'] || name;
    const targetPhone = phone || found.guest?.['טלפון וואטסאפ'] || '';
    const message = String(payload.message || '').trim() || `היי ${targetName || 'אורח/ת יקר/ה'}, רציתי לעדכן אותך לגבי האירוע.`;
    return { ok:true, changed:false, intent:'action', action:type, needsConfirmation:true, draft:{ type:'whatsapp', name:targetName, phone:targetPhone, message }, answer:`הכנתי טיוטת וואטסאפ לאישור לפני שליחה:\nאל: ${targetName || targetPhone || 'לא נבחר'}${targetPhone ? ' ('+targetPhone+')' : ''}\nהודעה: ${message}\n\nלא שלחתי בפועל.` };
  }
  return { ok:false, changed:false, intent:'unsupported', error:'unsupported_action', answer:`הפעולה ${type || 'הזו'} עדיין לא נתמכת במערכת.` };
}

function answerEventAssistantQuery(state, command) {
  const text = String(command || '');
  const snap = eventAssistantStateSnapshot(state);
  const groupLines = obj => Object.entries(obj || {}).sort((a,b)=>b[1].people-a[1].people).map(([k,v])=>`- ${k}: ${v.people} אנשים (${v.records} רשומות), אישרו ${v.confirmed}, טרם ${v.pending}, לא מגיעים ${v.declined}`).join('\n');
  if (/שלום|היי|מי אתה|מי את|תציג/.test(text)) return eventAssistantIntro(state);
  if (/מה אתה יכול|מה אפשר|איך אתה עוזר|יכולות/.test(text)) return 'אפשר לשאול אותי: כמה אישרו הגעה, מי לא ענה, מי מגיע, איפה יושבת משפחה, מה מצב האירוע ומה המשימות. לפעולות שינוי כתבו במפורש: הוסף, עדכן, שבץ או הכן הודעת וואטסאפ.';
  if (/משימות|מה נשאר|צריך לעשות|עד האירוע/.test(text)) return eventAssistantTasks(state);
  if (/צדדים|צד כלה|צד חתן|גורם מזמין|מזמינים|מי הזמין|אחראי/.test(text)) return `פילוח מוזמנים לפי צד:\n${groupLines(snap.bySide) || 'אין עדיין שיוך צדדים.'}\n\nפילוח לפי גורם מזמין:\n${groupLines(snap.byInviter) || 'אין עדיין גורמים מזמינים.'}`;
  if (/סיכום|מצב האירוע|סטטוס|איפה אנחנו עומדים/.test(text)) return `סיכום ${snap.settings.name || 'האירוע'}:\nמשתתפים: ${snap.participants.length} רשומות / ${snap.totalPeople} אנשים\nאישרו הגעה: ${snap.confirmed.length} רשומות / ${snap.confirmedPeople} אנשים\nטרם ענו: ${snap.pending.length} רשומות / ${snap.pendingPeople} אנשים\nלא מגיעים: ${snap.declined.length} רשומות / ${snap.declinedPeople} אנשים\nמשובצים לשולחנות: ${snap.assigned.length} רשומות\nספקים: ${snap.vendors.length}`;
  if (/כמה.*(אישרו|מאשרים|אישור|הגעה|מגיעים)|כמה אישור/.test(text)) return `כרגע אישרו הגעה ${snap.confirmed.length} רשומות / ${snap.confirmedPeople} אנשים מתוך ${snap.totalPeople}.\nטרם ענו: ${snap.pending.length} רשומות / ${snap.pendingPeople} אנשים.\nלא מגיעים: ${snap.declined.length} רשומות / ${snap.declinedPeople} אנשים.`;
  if (/כמה.*(לא אישרו|טרם|לא ענו|לא ענה)/.test(text)) return `כרגע טרם ענו ${snap.pending.length} רשומות / ${snap.pendingPeople} אנשים.`;
  if (/כמה.*(משתתפים|מוזמנים|אורחים|אנשים)/.test(text)) return `כרגע יש ${snap.participants.length} רשומות משתתפים, סה״כ ${snap.totalPeople} אנשים לפי כמויות.`;
  if (/(^|\s)מי\s.*(לא ענה|טרם|לא אישר)|טרם.*(ענו|אישרו)/.test(text)) return snap.pending.length ? `אלו עדיין לא אישרו:\n${snap.pending.map(g=>`- ${g['שם מלא / שם לקוח']} (${snap.qty(g)} מוזמנים)`).join('\n')}` : 'אין כרגע משתתפים שמסומנים כטרם נענו.';
  if (/(^|\s)מי\s.*(מאושר|אישר|מגיע)/.test(text)) return snap.confirmed.length ? `אלו אישרו הגעה:\n${snap.confirmed.map(g=>`- ${g['שם מלא / שם לקוח']} (${snap.qty(g)} מוזמנים)`).join('\n')}` : 'אין כרגע משתתפים שמסומנים כמאושרים.';
  if (/איפה|איזה שולחן|יושב|יושבת/.test(text)) {
    const raw = (text.match(/משפחת\s+([^?.,!]+)/) || text.match(/(?:איפה|שולחן|יושב|יושבת)\s+([^?.,!]+)/) || [])[1];
    const { guest } = findGuestByName(state, raw ? (text.includes('משפחת') ? 'משפחת ' + raw.trim() : raw.trim()) : '');
    if (guest) return `${guest['שם מלא / שם לקוח']} משובץ/ת כרגע: ${guest['שולחן / אזור'] || 'עדיין לא שובץ/ה לשולחן'}.`;
  }
  return '';
}
function handleEventAssistantAction(state, command) {
  const text = String(command || '');
  state.participants = Array.isArray(state.participants) ? state.participants : [];
  const rename = text.match(/(?:תקרא(?:י)?\s+לך|השם שלך|שם העוזר|שמך(?:\s+יהיה)?)\s*[:\-]?\s*([^\.\n,!?]{2,24})/);
  if (rename?.[1]) { state.eventSettings = state.eventSettings || {}; state.eventSettings.assistantName = cleanEventAssistantName(rename[1]); return { changed: true, answer: `מעולה, מעכשיו אפשר לקרוא לי ${state.eventSettings.assistantName}.` }; }
  if (/(שלח|תשלח|לשלוח|הכן|תכין).*?(וואטסאפ|הודעה|תזכורת)/.test(text)) {
    const name = cleanEventAssistantName((text.match(/(?:ל|אל)\s+([^,.\d]+?)(?:\s+\d|\s*,|\s+תשאל|$)/) || [])[1] || '');
    const { guest } = findGuestByName(state, name);
    const phone = extractAssistantPhone(text) || guest?.['טלפון וואטסאפ'] || '';
    const message = /אישור|הגעה|מאשר/.test(text) ? `היי ${guest?.['שם מלא / שם לקוח'] || name || 'אורח/ת יקר/ה'}, נשמח לדעת האם אתם מאשרים הגעה לאירוע. תודה רבה!` : `היי ${guest?.['שם מלא / שם לקוח'] || name || 'אורח/ת יקר/ה'}, רציתי לעדכן אותך לגבי האירוע.`;
    return { changed: false, needsConfirmation: true, draft: { type:'whatsapp', name: guest?.['שם מלא / שם לקוח'] || name, phone, message }, answer: `הכנתי טיוטת וואטסאפ לאישור לפני שליחה:\nאל: ${guest?.['שם מלא / שם לקוח'] || name || phone || 'לא נבחר'}${phone ? ' ('+phone+')' : ''}\nהודעה: ${message}\n\nלא שלחתי בפועל. שליחה מתבצעת רק ממודול הוואטסאפ אחרי אישור.` };
  }
  const updateCount = text.match(/(?:תעדכן|עדכן|תשנה|שנה)\s+(?:את\s+)?(.+?)\s+(?:ל|עם)\s*[־-]?\s*(\d+)\s*(?:משתתפים|מוזמנים|אנשים|מגיעים|אורחים|נפשות)/);
  if (updateCount) {
    const name = cleanEventAssistantName(updateCount[1]);
    const count = Number(updateCount[2]);
    const found = findGuestByName(state, name);
    if (!found.guest) return { changed:false, answer:`לא מצאתי את ${name} ברשימת המשתתפים. בדוק את השם או בקש להוסיף אותו כמשתתף חדש.` };
    found.guest['כמות מוזמנים'] = String(count);
    if (/יגיעו|מגיעים|יאשר|אישר|אישור|הגעה/.test(text)) found.guest['סטטוס אישור השתתפות'] = 'אישר';
    const note = /ילד|ילדה|ילדים/.test(text) ? 'כולל ילד/ים' : '';
    if (note) found.guest['הערות'] = `${found.guest['הערות'] ? found.guest['הערות'] + ' | ' : ''}${note}`;
    return { changed:true, answer:`עדכנתי את ${found.guest['שם מלא / שם לקוח']} ל-${count} מוזמנים${/יגיעו|מגיעים|יאשר|אישר|אישור|הגעה/.test(text) ? ' וסימנתי שאישרו הגעה' : ''}${note ? ' ('+note+')' : ''}.` };
  }
  const updateRsvp = text.match(/(?:תעדכן|עדכן|סמן|תסמן)\s+(?:את\s+)?(.+?)\s+(?:כ|שהם\s+)?(מגיעים|יגיעו|אישרו|לא מגיעים|לא יגיעו|טרם ענו|לא ענו)/);
  if (updateRsvp) {
    const name = cleanEventAssistantName(updateRsvp[1]);
    const found = findGuestByName(state, name);
    if (!found.guest) return { changed:false, answer:`לא מצאתי את ${name} ברשימת המשתתפים.` };
    const raw = updateRsvp[2];
    found.guest['סטטוס אישור השתתפות'] = /לא מגיעים|לא יגיעו/.test(raw) ? 'לא מגיע' : /טרם|לא ענו/.test(raw) ? 'טרם נענה' : 'אישר';
    return { changed:true, answer:`עדכנתי את סטטוס ההגעה של ${found.guest['שם מלא / שם לקוח']} ל־${found.guest['סטטוס אישור השתתפות']}.` };
  }
  const table = (text.match(/(?:שולחן|לשולחן|בשולחן)\s*(\d+)/) || [])[1];
  if (/(שבץ|תשבץ|מקם|תמקם|להושיב|הושב)/.test(text)) {
    const name = cleanEventAssistantName((text.match(/(?:שבץ|תשבץ|מקם|תמקם|להושיב|הושב)\s+(?:את\s+)?([^,.]+?)\s+(?:לשולחן|בשולחן)/) || [])[1] || '');
    if (!name || !table) return { changed:false, answer:'כדי לשבץ לשולחן אני צריך שם משתתף ומספר שולחן.' };
    const found = findGuestByName(state, name);
    if (!found.guest) return { changed:false, answer:`לא מצאתי את ${name} ברשימת המשתתפים.` };
    found.guest['שולחן / אזור'] = `שולחן ${table}`;
    return { changed:true, answer:`שיבצתי את ${found.guest['שם מלא / שם לקוח']} לשולחן ${table}.` };
  }
  if (/(הוסף|תוסיף|תכניס|הכנס|תרשום|רשום)/.test(text)) {
    const family = text.match(/(?:משפחת|משפחה)\s+([^,.]+?)(?:\s+עם|\s+לשולחן|\s+טלפון|\s*,|$)/);
    const generic = text.match(/(?:הוסף|תוסיף|תכניס|הכנס|תרשום|רשום)\s+(?:את\s+)?([^,.]+?)(?:\s+עם|\s+לשולחן|\s+טלפון|\s*,|$)/);
    const name = family ? `משפחת ${family[1].trim()}` : cleanEventAssistantName(generic?.[1] || '');
    const count = extractAssistantCount(text);
    if (!name) return { changed:false, answer:'את מי להוסיף? כתוב שם משתתף/משפחה וכמות מוזמנים.' };
    if (!count) return { changed:false, answer:`כדי להוסיף את ${name}, כמה משתתפים/מוזמנים לרשום?` };
    const existing = findGuestByName(state, name);
    const guest = existing.guest || { 'מספר': state.participants.length + 1, 'שם מלא / שם לקוח': name, 'סטטוס אישור השתתפות':'טרם נענה', 'סטטוס תשלום':'טרם שולם' };
    guest['שם מלא / שם לקוח'] = name; guest['כמות מוזמנים'] = String(count);
    const phone = extractAssistantPhone(text); if (phone) guest['טלפון וואטסאפ'] = phone;
    if (table) guest['שולחן / אזור'] = `שולחן ${table}`;
    if (!existing.guest) state.participants.push(guest);
    state.participants.forEach((g,i)=>g['מספר']=i+1);
    return { changed:true, answer:`${existing.guest ? 'עדכנתי' : 'הוספתי'} את ${name} עם ${count} מוזמנים${table ? ` ושיבוץ לשולחן ${table}` : ''}.` };
  }
  return { changed:false, answer:'אני לא רוצה לנחש פעולה. אפשר לשאול שאלה כמו “כמה אישרו הגעה?” או לתת פעולה ברורה כמו “הוסף את משפחת כהן עם 4 מוזמנים”.' };
}
function eventAssistantAiState(state) {
  const snap = eventAssistantStateSnapshot(state);
  return JSON.stringify({
    eventSettings: snap.settings,
    participants: snap.participants.map(g => ({
      name: g['שם מלא / שם לקוח'] || '', phone: g['טלפון וואטסאפ'] || '', count: g['כמות מוזמנים'] || '1',
      rsvp: g['סטטוס אישור השתתפות'] || '', table: g['שולחן / אזור'] || '', side: g['צד באירוע'] || '', inviter: g['גורם מזמין'] || '', relation: g['קרבה למזמין'] || '', invitationTone: g['נוסח פנייה'] || '', notes: g['הערות'] || ''
    })).slice(0, 300),
    totals: { people: snap.totalPeople, confirmedPeople: snap.confirmedPeople, pendingPeople: snap.pendingPeople, declinedPeople: snap.declinedPeople, bySide:snap.bySide, byInviter:snap.byInviter },
    vendors: snap.vendors.map(v => ({ name:v.name, category:v.category, status:v.status, agreed:v.agreed, paid:v.paid })).slice(0, 80)
  }).slice(0, 60000);
}

async function planEventAssistantWithOpenClaw(env, state, command, eventId, history = []) {
  const token = env.OPAL_EMBEDDED_ASSISTANT_TOKEN || env.AMI_EMBEDDED_ASSISTANT_TOKEN;
  if (!token) return null;
  const endpoint = env.OPAL_EMBEDDED_ASSISTANT_URL || 'https://opal.hai.tech/api/embedded/ami/event-assistant';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventId, command, state, history: sanitizeAssistantHistory(history, 20), agentId: 'agent-mp6tgr93', timeoutSeconds: 90 }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) return null;
    return data.plan || null;
  } catch {
    return null;
  }
}

function applyEventAssistantAiPlan(state, plan) {
  if (!plan || typeof plan !== 'object') return null;
  const intent = String(plan.intent || '').toLowerCase();
  const action = String(plan.action || '').toLowerCase();
  if (intent === 'clarify') return { changed:false, intent:'clarify', answer: plan.answer || 'אפשר לחדד מה תרצה שאעשה?' };
  if (action === 'answer') return { changed:false, intent:'query-ai', answer: plan.answer || 'אין לי מספיק נתונים כדי לענות.' };
  if (action === 'task_board') return { changed:false, intent:'query-ai', answer: eventAssistantTasks(state) };
  if (['get_summary', 'list_pending_rsvp', 'rename_assistant', 'add_guest', 'update_guest', 'assign_table', 'prepare_whatsapp'].includes(action)) {
    const executed = executeEventAction(state, action, plan);
    return { ...executed, intent: executed.intent === 'query' ? 'query-ai' : executed.intent === 'clarify' ? 'clarify' : 'action-ai' };
  }
  if (action === 'rename_assistant') {
    const name = cleanEventAssistantName(plan.assistantName || plan.name || '');
    if (!name) return { changed:false, intent:'clarify', answer:'איזה שם לתת לעוזר?' };
    state.eventSettings = state.eventSettings || {}; state.eventSettings.assistantName = name;
    return { changed:true, intent:'action-ai', answer:`מעולה, מעכשיו אפשר לקרוא לי ${name}.` };
  }
  if (action === 'update_guest') {
    const found = findGuestByName(state, plan.name || '');
    if (!found.guest) return { changed:false, intent:'clarify', answer:`לא מצאתי את ${plan.name || 'המשתתף'} ברשימת המשתתפים. אפשר לכתוב את השם בדיוק כפי שמופיע בטבלה?` };
    const updates = [];
    if (Number(plan.count) > 0) { found.guest['כמות מוזמנים'] = String(Number(plan.count)); updates.push(`${Number(plan.count)} מוזמנים`); }
    if (plan.phone) { found.guest['טלפון וואטסאפ'] = String(plan.phone); updates.push('טלפון'); }
    if (plan.table) { found.guest['שולחן / אזור'] = `שולחן ${String(plan.table).replace(/\D/g,'') || plan.table}`; updates.push(found.guest['שולחן / אזור']); }
    if (plan.rsvp) { found.guest['סטטוס אישור השתתפות'] = /לא/.test(String(plan.rsvp)) ? 'לא מגיע' : /טרם/.test(String(plan.rsvp)) ? 'טרם נענה' : 'אישר'; updates.push(`סטטוס ${found.guest['סטטוס אישור השתתפות']}`); }
    if (plan.note) { found.guest['הערות'] = `${found.guest['הערות'] ? found.guest['הערות'] + ' | ' : ''}${plan.note}`; updates.push(plan.note); }
    return { changed:true, intent:'action-ai', answer:`עדכנתי את ${found.guest['שם מלא / שם לקוח']}${updates.length ? ': ' + updates.join(', ') : ''}.` };
  }
  if (action === 'add_guest') {
    const name = cleanEventAssistantName(plan.name || '');
    const count = Number(plan.count) || 0;
    if (!name) return { changed:false, intent:'clarify', answer:'את מי להוסיף?' };
    if (!count) return { changed:false, intent:'clarify', answer:`כמה מוזמנים לרשום עבור ${name}?` };
    state.participants = Array.isArray(state.participants) ? state.participants : [];
    const existing = findGuestByName(state, name);
    const guest = existing.guest || { 'מספר': state.participants.length + 1, 'שם מלא / שם לקוח': name, 'סטטוס אישור השתתפות':'טרם נענה', 'סטטוס תשלום':'טרם שולם' };
    guest['שם מלא / שם לקוח'] = name; guest['כמות מוזמנים'] = String(count);
    if (plan.phone) guest['טלפון וואטסאפ'] = String(plan.phone);
    if (plan.table) guest['שולחן / אזור'] = `שולחן ${String(plan.table).replace(/\D/g,'') || plan.table}`;
    if (plan.rsvp) guest['סטטוס אישור השתתפות'] = /לא/.test(String(plan.rsvp)) ? 'לא מגיע' : /טרם/.test(String(plan.rsvp)) ? 'טרם נענה' : 'אישר';
    if (plan.note) guest['הערות'] = `${guest['הערות'] ? guest['הערות'] + ' | ' : ''}${plan.note}`;
    if (!existing.guest) state.participants.push(guest);
    state.participants.forEach((g,i)=>g['מספר']=i+1);
    return { changed:true, intent:'action-ai', answer:`${existing.guest ? 'עדכנתי' : 'הוספתי'} את ${name} עם ${count} מוזמנים${plan.table ? ` ושיבוץ לשולחן ${plan.table}` : ''}.` };
  }
  if (action === 'assign_table') {
    const found = findGuestByName(state, plan.name || '');
    if (!found.guest) return { changed:false, intent:'clarify', answer:`לא מצאתי את ${plan.name || 'המשתתף'} ברשימת המשתתפים.` };
    if (!plan.table) return { changed:false, intent:'clarify', answer:'לאיזה שולחן לשבץ?' };
    found.guest['שולחן / אזור'] = `שולחן ${String(plan.table).replace(/\D/g,'') || plan.table}`;
    return { changed:true, intent:'action-ai', answer:`שיבצתי את ${found.guest['שם מלא / שם לקוח']} ל${found.guest['שולחן / אזור']}.` };
  }
  if (action === 'prepare_whatsapp') {
    const found = findGuestByName(state, plan.name || '');
    const phone = plan.phone || found.guest?.['טלפון וואטסאפ'] || '';
    const name = found.guest?.['שם מלא / שם לקוח'] || plan.name || '';
    const message = plan.message || `היי ${name || 'אורח/ת יקר/ה'}, רציתי לעדכן אותך לגבי האירוע.`;
    return { changed:false, intent:'action-ai', needsConfirmation:true, draft:{type:'whatsapp', name, phone, message}, answer:`הכנתי טיוטת וואטסאפ לאישור לפני שליחה:\nאל: ${name || phone || 'לא נבחר'}${phone ? ' ('+phone+')' : ''}\nהודעה: ${message}\n\nלא שלחתי בפועל.` };
  }
  return null;
}


async function buildAssistantRsvpLink(env, request, eventId, guestIndex, guest) {
  const token = await signRsvpToken(env, {
    eventId,
    guestIndex,
    phone: String(guest?.['טלפון וואטסאפ'] || ''),
    name: String(guest?.['שם מלא / שם לקוח'] || ''),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 45,
  });
  return `${new URL(request.url).origin}/rsvp?t=${encodeURIComponent(token)}`;
}

function assistantInviterOpening(guest, state) {
  const tone = String(guest?.['נוסח פנייה'] || '').trim();
  const inviter = String(guest?.['גורם מזמין'] || '').trim();
  const relation = String(guest?.['קרבה למזמין'] || '').trim();
  const side = String(guest?.['צד באירוע'] || guest?.['קבוצה'] || '').trim();
  if (tone === 'בשם הזוג') return `כאן ${state.eventSettings?.owner || 'בעלי השמחה'}`;
  if (tone === 'בשם הכלה') return 'כאן הכלה';
  if (tone === 'בשם החתן') return 'כאן החתן';
  if (tone === 'בשם הורי הכלה') return inviter ? `כאן ${inviter}, מהורי הכלה` : 'כאן הורי הכלה';
  if (tone === 'בשם הורי החתן') return inviter ? `כאן ${inviter}, מהורי החתן` : 'כאן הורי החתן';
  if (tone === 'בשם המשפחה') return inviter ? `כאן ${inviter} מהמשפחה` : 'כאן המשפחה';
  if (tone === 'רשמי') return `כאן צוות ${state.eventSettings?.name || 'האירוע'}`;
  if (inviter) return `כאן ${inviter}${relation ? ', ' + relation : ''}`;
  if (side === 'צד כלה') return 'כאן צד הכלה';
  if (side === 'צד חתן') return 'כאן צד החתן';
  return 'כאן צוות האירוע';
}

async function handleEventAssistantWhatsApp(env, request, state, command, eventId) {
  const text = String(command || '');
  const isWhatsAppRequest = /(וואטסאפ|הודעה|תזכורת|בקשה\s+לאישור\s+הגעה|אישור\s+הגעה)/.test(text);
  const explicitSend = /(?:^|\s)(?:שלח|תשלח|שלחי|שלחו)(?:\s|$)/.test(text);
  const prepareOnly = /(?:הכן|תכין|טיוטה|נוסח|רק\s+תכין)/.test(text) && !explicitSend;
  if (!isWhatsAppRequest || (!explicitSend && !prepareOnly)) return null;

  const name = extractAssistantRecipientName(text);
  const found = findGuestByName(state, name);
  if (!found.guest) return { changed:false, intent:'clarify', answer: name ? `לא מצאתי את ${name} ברשימת המשתתפים. אפשר לכתוב את השם בדיוק כפי שמופיע בטבלה?` : 'למי לשלוח את הודעת הוואטסאפ?' };

  const targetName = found.guest['שם מלא / שם לקוח'] || name;
  const phone = extractAssistantPhone(text) || found.guest['טלפון וואטסאפ'] || '';
  if (!phone) return { changed:false, intent:'clarify', answer:`מצאתי את ${targetName}, אבל אין לו/לה מספר וואטסאפ ברשימת המשתתפים.` };

  const isRsvp = /אישור|הגעה|מאשר|RSVP/i.test(text);
  let message = '';
  if (isRsvp) {
    const link = await buildAssistantRsvpLink(env, request, eventId, found.index, found.guest);
    message = `היי ${targetName}, ${assistantInviterOpening(found.guest, state)} 😊
נשמח לדעת האם אתם מאשרים הגעה ל${state.eventSettings?.name || 'אירוע'}.
אפשר לעדכן כאן: ${link}
תודה רבה!`;
  } else {
    const custom = text.match(/(?:הודעה|וואטסאפ)\s+(?:ל|אל)?\s*[^:：]*[:：]\s*([\s\S]+)/)?.[1];
    message = String(custom || `היי ${targetName}, רציתי לעדכן אותך לגבי ${state.eventSettings?.name || 'האירוע'}. תודה רבה!`).trim();
  }

  return { changed:false, intent:'action', action:prepareOnly?'prepare_whatsapp':'confirm_whatsapp', needsConfirmation:true, draft:{ type:'whatsapp', name:targetName, phone, message }, answer:`הכנתי טיוטת וואטסאפ לאישור לפני שליחה:\nאל: ${targetName} (${phone})\nהודעה: ${message}\n\nלא שלחתי בפועל. כדי לשלוח, יש לעבור למסך וואטסאפ, לסמן אישור הרשאה וללחוץ שליחה.` };
}

async function eventAssistantApi(request, env) {
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
  try { state = raw ? JSON.parse(raw) : (body.state || {}); } catch { state = body.state || {}; }
  if (!state || typeof state !== 'object') state = {};
  state.eventSettings = state.eventSettings || {};
  const storedHistory = await loadEventAssistantHistory(env, eventId, session);
  const requestHistory = sanitizeAssistantHistory(body.history, 20);
  const history = requestHistory.length ? requestHistory : storedHistory;
  const whatsappResult = await handleEventAssistantWhatsApp(env, request, state, command, eventId);
  const queryAnswer = whatsappResult ? '' : answerEventAssistantQuery(state, command);
  let result = whatsappResult || (queryAnswer ? { changed:false, intent:'query', answer:queryAnswer } : { intent:'action', ...handleEventAssistantAction(state, command) });
  const isFallback = String(result.answer || '').includes('אני לא רוצה לנחש פעולה');
  if (isFallback || (env.EVENT_ASSISTANT_BRAIN_MODE === 'always' && !queryAnswer)) {
    const brainPlan = await planEventAssistantWithOpenClaw(env, state, command, eventId, history);
    const brainResult = applyEventAssistantAiPlan(state, brainPlan);
    if (brainResult) result = { ...brainResult, brain: 'openclaw' };
  }
  result.openClawBrainEnabled = !!(env.OPAL_EMBEDDED_ASSISTANT_TOKEN || env.AMI_EMBEDDED_ASSISTANT_TOKEN);
  if (result.changed) await env.EVENTS_KV.put(key, JSON.stringify({ ...state, eventId, updatedAt: new Date().toISOString() }));
  const nextHistory = sanitizeAssistantHistory([
    ...history,
    { role: 'user', content: command, ts: new Date().toISOString() },
    { role: 'assistant', content: result.answer || 'בוצע', ts: new Date().toISOString() },
  ], 60);
  await saveEventAssistantHistory(env, eventId, session, nextHistory);
  return jsonResponse({ ok: true, eventId, ...result, state, history: nextHistory });
}

async function eventActionsApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  if (request.method !== 'POST') return jsonResponse({ ok:false, error:'Method not allowed' }, 405);
  const body = await request.json().catch(() => ({}));
  const eventId = String(body.eventId || '').trim();
  const action = normalizeEventAction(body.action || body.type || body?.payload?.action || '');
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : body;
  if (!eventId || !action) return jsonResponse({ ok:false, error:'Missing eventId or action' }, 400);
  const session = await requireEventAccess(request, env, eventId);
  if (!session) return jsonResponse({ ok:false, error:'Unauthorized' }, 401);
  const key = EVENT_STATE_PREFIX + eventId;
  const raw = await env.EVENTS_KV.get(key);
  let state;
  try { state = raw ? JSON.parse(raw) : (body.state || {}); } catch { state = body.state || {}; }
  if (!state || typeof state !== 'object') state = {};
  const result = executeEventAction(state, action, payload);
  if (result.changed) await env.EVENTS_KV.put(key, JSON.stringify({ ...state, eventId, updatedAt: new Date().toISOString() }));
  return jsonResponse({ ok: !!result.ok, eventId, action, ...result, state });
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

async function eventTeamApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  const body = await request.json().catch(() => ({}));
  const eventId = String(body.eventId || '').trim();
  if (!eventId) return jsonResponse({ ok: false, error: 'Missing eventId' }, 400);
  const session = await requireEventAccess(request, env, eventId);
  if (!session) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  const memberIn = body.member && typeof body.member === 'object' ? body.member : {};
  const username = String(memberIn.username || '').trim();
  const password = String(memberIn.password || '').trim();
  const name = String(memberIn.name || '').trim();
  if (!username || !password || !name) return jsonResponse({ ok: false, error: 'Missing team member name/username/password' }, 400);
  const member = {
    id: String(memberIn.id || `team_${Date.now()}`),
    name,
    username,
    password,
    phone: String(memberIn.phone || '').trim(),
    email: String(memberIn.email || '').trim(),
    role: String(memberIn.role || 'אחר').trim(),
    permission: String(memberIn.permission || 'view').trim(),
    status: 'invited',
    createdAt: String(memberIn.createdAt || new Date().toISOString()),
    invitedBy: String(memberIn.invitedBy || session.name || session.username || ''),
  };
  const events = await loadEvents(env);
  const ev = events?.find(x => x.id === eventId);
  if (!ev) return jsonResponse({ ok: false, error: 'האירוע לא נמצא' }, 404);
  if (eventClientUsers(ev).some(u => u.username.toLowerCase() === username.toLowerCase())) return jsonResponse({ ok: false, error: 'שם המשתמש כבר קיים באירוע' }, 409);
  const updatedEvent = { ...ev, clientUsers: [...(Array.isArray(ev.clientUsers) ? ev.clientUsers : []), member], updatedAt: new Date().toISOString() };
  await saveEvents(env, events.map(x => x.id === eventId ? updatedEvent : x));
  const key = EVENT_STATE_PREFIX + eventId;
  const raw = await env.EVENTS_KV.get(key);
  let state;
  try { state = raw ? JSON.parse(raw) : (body.state || {}); } catch { state = body.state || {}; }
  if (!state || typeof state !== 'object') state = {};
  const existing = Array.isArray(state.teamMembers) ? state.teamMembers : [];
  const teamMembers = [member, ...existing.filter(m => m?.id !== member.id && String(m?.username || '').toLowerCase() !== username.toLowerCase())];
  await env.EVENTS_KV.put(key, JSON.stringify({ ...state, eventId, teamMembers, updatedAt: new Date().toISOString() }));
  return jsonResponse({ ok: true, eventId, member, teamMembers, event: updatedEvent });
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

async function sendGreenApiMessage(env, phoneOrChatId, message) {
  const idInstance = env.GREENAPI_ID_INSTANCE;
  const apiToken = env.GREENAPI_API_TOKEN_INSTANCE;
  if (!idInstance || !apiToken) return { ok: false, status: 500, error: 'Green API is not configured' };
  const chatId = normalizeChatId(phoneOrChatId);
  const text = String(message || '').trim();
  if (!chatId || !text) return { ok: false, status: 400, error: 'Missing phone/chatId or message' };
  if (text.length > 3500) return { ok: false, status: 400, error: 'Message is too long' };
  const url = `https://api.green-api.com/waInstance${idInstance}/sendMessage/${apiToken}`;
  const upstream = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, message: text }) });
  const responseText = await upstream.text();
  let result;
  try { result = responseText ? JSON.parse(responseText) : {}; } catch { result = { raw: responseText }; }
  if (!upstream.ok) return { ok: false, status: upstream.status, chatId, result };
  return { ok: true, chatId, result };
}

async function getWhatsAppHistory(request, env) {
  try {
    const idInstance = env.GREENAPI_ID_INSTANCE;
    const apiToken = env.GREENAPI_API_TOKEN_INSTANCE;
    if (!idInstance || !apiToken) return jsonResponse({ ok: false, error: 'Green API is not configured' }, 500);
    const body = await request.json().catch(() => ({}));
    const eventId = String(body.eventId || '').trim();
    if (!eventId) return jsonResponse({ ok: false, error: 'Missing eventId' }, 400);
    if (!(await requireEventAccess(request, env, eventId))) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
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
    const body = await request.json();
    const eventId = String(body.eventId || '').trim();
    if (!eventId) return jsonResponse({ ok: false, error: 'Missing eventId' }, 400);
    if (!(await requireEventAccess(request, env, eventId))) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
    if (body.userConfirmed !== true) return jsonResponse({ ok: false, error: 'נדרש אישור מפורש של המשתמש לפני שליחת וואטסאפ' }, 400);
    const linkCheck = validateApprovedMessageLinks(request, body.message);
    if (!linkCheck.ok) return jsonResponse({ ok: false, error: 'ההודעה כוללת קישורים לא מאושרים', blockedLinks: linkCheck.blocked }, 400);
    const sent = await sendGreenApiMessage(env, body.chatId || body.phone, body.message);
    if (!sent.ok) return jsonResponse({ ok: false, error: sent.error, status: sent.status, result: sent.result }, sent.status && sent.status < 500 ? sent.status : 502);
    return jsonResponse({ ok: true, chatId: sent.chatId, result: sent.result });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || 'Unknown error' }, 500);
  }
}

function morningBaseUrl(env) {
  const explicit = String(env.MORNING_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return String(env.MORNING_ENV || 'sandbox').toLowerCase() === 'production'
    ? 'https://api.greeninvoice.co.il/api/v1'
    : 'https://sandbox.d.greeninvoice.co.il/api/v1';
}

async function morningToken(env) {
  if (!env.MORNING_API_KEY_ID || !env.MORNING_API_KEY_SECRET) throw new Error('Morning API credentials are not configured');
  const upstream = await fetch(`${morningBaseUrl(env)}/account/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: env.MORNING_API_KEY_ID, secret: env.MORNING_API_KEY_SECRET }),
  });
  const text = await upstream.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!upstream.ok || !data.token) throw new Error(data.errorMessage || data.message || text || `Morning token failed (${upstream.status})`);
  return data.token;
}

function cleanPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('972')) return `+${digits}`;
  if (digits.startsWith('0')) return `+972${digits.slice(1)}`;
  return `+${digits}`;
}

function safePaymentCustom(eventId, paymentId) {
  return JSON.stringify({ source: 'orma-event-system', eventId, paymentId });
}

async function signPaymentChoiceToken(env, claims) {
  const payload = base64url(enc.encode(JSON.stringify({ ...claims, kind: 'payment-choice', exp: Date.now() + 1000 * 60 * 60 * 24 * 60 })));
  const sig = await hmac(sessionSecret(env), payload);
  return `${payload}.${sig}`;
}

async function verifyPaymentChoiceToken(env, token) {
  if (!token || !String(token).includes('.')) return null;
  const [payload, sig] = String(token).split('.');
  const expected = await hmac(sessionSecret(env), payload);
  if (!safeEqual(sig, expected)) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    if (json.kind !== 'payment-choice' || !json.eventId || !json.paymentId || json.exp < Date.now()) return null;
    return json;
  } catch { return null; }
}

async function paymentChoiceLinkApi(request, env) {
  if (!env.EVENTS_KV) return jsonResponse({ ok: false, error: 'Cloudflare KV binding EVENTS_KV is not configured' }, 501);
  const body = await request.json().catch(() => ({}));
  const eventId = String(body.eventId || '').trim();
  const paymentId = String(body.paymentId || '').trim();
  if (!eventId || !paymentId) return jsonResponse({ ok: false, error: 'Missing eventId or paymentId' }, 400);
  if (!(await requireEventAccess(request, env, eventId))) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  const token = await signPaymentChoiceToken(env, { eventId, paymentId });
  const origin = new URL(request.url).origin;
  const shortCode = base64url(crypto.getRandomValues(new Uint8Array(6)));
  await env.EVENTS_KV.put(PAYMENT_SHORT_LINK_PREFIX + shortCode, JSON.stringify({ token, eventId, paymentId, createdAt: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 90 });
  return jsonResponse({ ok: true, url: `${origin}/p/${shortCode}`, longUrl: `${origin}/pay?t=${encodeURIComponent(token)}` });
}

async function paymentShortRedirect(request, env, code) {
  if (!env.EVENTS_KV) return htmlResponse('<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:Arial;padding:24px"><h2>שירות הקישורים אינו זמין כרגע</h2></body>', 501);
  const clean = String(code || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const raw = clean ? await env.EVENTS_KV.get(PAYMENT_SHORT_LINK_PREFIX + clean) : '';
  let data; try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!data?.token) return htmlResponse('<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:Arial;padding:24px"><h2>קישור התשלום לא תקין או שפג תוקפו</h2></body>', 404);
  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/pay?t=${encodeURIComponent(data.token)}`, 302);
}

async function loadPaymentForChoice(env, eventId, paymentId) {
  const raw = await env.EVENTS_KV?.get(EVENT_STATE_PREFIX + eventId);
  let state; try { state = raw ? JSON.parse(raw) : {}; } catch { state = {}; }
  const payment = Array.isArray(state.payments) ? state.payments.find(p => p?.id === paymentId) : null;
  return { state, payment };
}

async function paymentChoicePage(request, env) {
  const token = new URL(request.url).searchParams.get('t') || '';
  const claims = await verifyPaymentChoiceToken(env, token);
  if (!claims) return htmlResponse('<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:Arial;padding:24px"><h2>קישור תשלום לא תקין או שפג תוקפו</h2></body>', 400);
  const { state, payment } = await loadPaymentForChoice(env, claims.eventId, claims.paymentId);
  const eventName = escapeHtmlServer(state?.eventSettings?.name || 'האירוע');
  const payerName = escapeHtmlServer(payment?.payerName || 'אורח/ת יקר/ה');
  return htmlResponse(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>בחירת סכום מתנה</title><style>body{font-family:Assistant,Arial,sans-serif;background:#171411;color:#f7efe6;margin:0}.box{max-width:540px;margin:28px auto;background:#211914;border:1px solid #d8b07a55;border-radius:24px;padding:24px;box-shadow:0 24px 80px #0008}h1{margin-top:0;color:#d8b07a}.chips,.installments{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0}.chips button,.installments button,.main{height:52px;border:0;border-radius:14px;background:#d8b07a;color:#1a0f08;font-weight:900;font-size:18px;cursor:pointer}.chips button,.installments button{background:#30251d;color:#f7efe6;border:1px solid #d8b07a55}.chips button.active,.installments button.active{background:#d8b07a;color:#1a0f08}label{display:block;margin:16px 0 8px;font-weight:900;color:#ead7bd}input,select{width:100%;box-sizing:border-box;height:56px;border-radius:14px;border:1px solid #d8b07a55;background:#110f0d;color:#fff;font-size:22px;padding:0 14px}select{font-size:18px}.note{color:#c9b8a5;font-size:14px;line-height:1.45}.status{white-space:pre-wrap;margin-top:12px;color:#ffc7c2}@media(max-width:520px){.chips,.installments{grid-template-columns:repeat(2,1fr)}.box{margin:14px;padding:20px}}</style></head><body><main class="box"><h1>בחירת סכום מתנה</h1><p>שלום ${payerName}, תודה שאתם חלק מ${eventName} ❤️</p><p class="note">בחרו סכום חופשי שמתאים לכם, ואז בחרו את מספר התשלומים הרצוי. לאחר מכן תועברו לעמוד תשלום מאובטח של Morning.</p><label for="amount">סכום חופשי בש״ח</label><input id="amount" type="number" min="1" step="1" placeholder="הקלידו סכום לבחירתכם"><div class="chips">${[100,180,250,360,500,1000].map(n=>`<button type="button" onclick="setAmount(${n},this)">₪${n}</button>`).join('')}</div><label>פריסה לתשלומים</label><div class="installments">${[1,2,3,6,10,12].map(n=>`<button type="button" data-payments="${n}" onclick="setPayments(${n},this)">${n===1?'תשלום אחד':n+' תשלומים'}</button>`).join('')}</div><select id="payments"><option value="1">תשלום אחד</option><option value="2">2 תשלומים</option><option value="3">3 תשלומים</option><option value="6">6 תשלומים</option><option value="10">10 תשלומים</option><option value="12">12 תשלומים</option></select><p class="note">ייתכן שהתשלום כרוך בעמלת סליקה קטנה. אפשרויות התשלום בפועל כפופות למסוף Morning.</p><button class="main" onclick="go()">המשך לתשלום מאובטח</button><div id="status" class="status"></div></main><script>const token=${JSON.stringify(token)};function setAmount(n,btn){amount.value=n;document.querySelectorAll('.chips button').forEach(b=>b.classList.remove('active'));btn&&btn.classList.add('active')}function setPayments(n,btn){payments.value=n;document.querySelectorAll('.installments button').forEach(b=>b.classList.remove('active'));btn&&btn.classList.add('active')}setPayments(1,document.querySelector('[data-payments="1"]'));async function go(){const s=document.getElementById('status');const amount=Number(document.getElementById('amount').value)||0;const maxPayments=Number(document.getElementById('payments').value)||1;if(amount<=0){s.textContent='נא להזין סכום גדול מאפס';return} s.textContent='מכין קישור תשלום מאובטח...';try{const r=await fetch('/api/morning/create-gift-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,amount,maxPayments})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'יצירת קישור נכשלה');location.href=d.url}catch(e){s.textContent='לא הצלחנו לפתוח תשלום: '+e.message}}</script></body></html>`);
}

async function createMorningPaymentForm(env, request, input) {
  const amount = Number(input.amount) || 0;
  if (amount <= 0) throw new Error('Morning מחייבת סכום תשלום גדול מאפס כדי ליצור לינק.');
  const eventId = String(input.eventId || '').trim();
  const paymentId = String(input.paymentId || '').trim() || `pay_${Date.now().toString(36)}`;
  const origin = new URL(request.url).origin;
  const description = String(input.description || 'תשלום לאירוע').trim().slice(0, 200);
  const payerName = String(input.payerName || 'לקוח').trim().slice(0, 120);
  const payerEmail = String(input.payerEmail || '').trim();
  const payerPhone = cleanPhone(input.payerPhone || input.phone || '');
  const maxPayments = Math.max(1, Math.min(Number(input.maxPayments) || Number(env.MORNING_MAX_PAYMENTS) || 12, 36));
  const documentType = Number(env.MORNING_DOCUMENT_TYPE) || 320;
  const incomeVatType = env.MORNING_INCOME_VAT_TYPE === undefined ? 1 : Number(env.MORNING_INCOME_VAT_TYPE);
  const payload = { description, type: documentType, lang: 'he', currency: 'ILS', vatType: Number(env.MORNING_VAT_TYPE) || 0, amount, maxPayments, group: Number(env.MORNING_PAYMENT_GROUP) || 100, client: { name: payerName, emails: payerEmail ? [payerEmail] : [], country: 'IL', phone: payerPhone, mobile: payerPhone, add: true }, income: [{ description, quantity: 1, price: amount, currency: 'ILS', vatType: incomeVatType }], remarks: String(input.remarks || `בקשת תשלום ${paymentId}`).slice(0, 500), successUrl: `${origin}/?payment=success&eventId=${encodeURIComponent(eventId)}&paymentId=${encodeURIComponent(paymentId)}`, failureUrl: `${origin}/?payment=failure&eventId=${encodeURIComponent(eventId)}&paymentId=${encodeURIComponent(paymentId)}`, notifyUrl: `${origin}/api/morning/webhook`, custom: safePaymentCustom(eventId, paymentId) };
  if (env.MORNING_PLUGIN_ID) payload.pluginId = String(env.MORNING_PLUGIN_ID);
  const token = await morningToken(env);
  const upstream = await fetch(`${morningBaseUrl(env)}/payments/form`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await upstream.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!upstream.ok || !data.url) throw new Error(data.errorMessage || data.message || text || `Morning payment link failed (${upstream.status})`);
  return { ok: true, paymentId, url: data.url, provider: 'morning', providerStatus: 'payment_link_ready', morning: { errorCode: data.errorCode || 0 } };
}

async function createMorningPaymentLink(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const eventId = String(body.eventId || '').trim();
    if (!eventId) return jsonResponse({ ok: false, error: 'Missing eventId' }, 400);
    const session = await requireEventAccess(request, env, eventId);
    if (!session) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
    return jsonResponse(await createMorningPaymentForm(env, request, body));
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || 'Morning payment link failed' }, 500);
  }
}

async function createMorningGiftLink(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const claims = await verifyPaymentChoiceToken(env, body.token || '');
    if (!claims) return jsonResponse({ ok: false, error: 'קישור תשלום לא תקין או שפג תוקפו' }, 400);
    const { state, payment } = await loadPaymentForChoice(env, claims.eventId, claims.paymentId);
    if (!payment) return jsonResponse({ ok: false, error: 'בקשת התשלום לא נמצאה' }, 404);
    const result = await createMorningPaymentForm(env, request, { ...payment, eventId: claims.eventId, paymentId: claims.paymentId, amount: Number(body.amount) || 0, maxPayments: Number(body.maxPayments) || 1, description: payment.description || 'מתנה לאירוע' });
    payment.chosenAmount = Number(body.amount) || 0; payment.chosenPayments = Number(body.maxPayments) || 1; payment.lastGeneratedPaymentUrl = result.url; payment.providerStatus = 'guest_amount_selected'; payment.updatedAt = new Date().toISOString();
    await env.EVENTS_KV?.put(EVENT_STATE_PREFIX + claims.eventId, JSON.stringify({ ...state, eventId: claims.eventId, updatedAt: new Date().toISOString() }));
    return jsonResponse(result);
  } catch (err) { return jsonResponse({ ok: false, error: err.message || 'יצירת לינק תשלום נכשלה' }, 500); }
}

function extractMorningCustom(body) {
  const raw = body?.custom || body?.Custom || body?.data?.custom || body?.transaction?.custom || '';
  if (typeof raw === 'object' && raw) return raw;
  try { return raw ? JSON.parse(String(raw)) : {}; } catch { return {}; }
}

async function morningWebhook(request, env) {
  const text = await request.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  const custom = extractMorningCustom(body);
  const eventId = String(custom.eventId || body.eventId || '').trim();
  const paymentId = String(custom.paymentId || body.paymentId || body.paymentID || '').trim();
  if (env.EVENTS_KV) {
    await env.EVENTS_KV.put(MORNING_WEBHOOK_PREFIX + Date.now().toString(36) + ':' + crypto.randomUUID(), JSON.stringify({ receivedAt: new Date().toISOString(), eventId, paymentId, body }), { expirationTtl: 60 * 60 * 24 * 30 });
    if (eventId && paymentId) {
      const key = EVENT_STATE_PREFIX + eventId;
      const rawState = await env.EVENTS_KV.get(key);
      let state;
      try { state = rawState ? JSON.parse(rawState) : null; } catch { state = null; }
      const paidSignal = /paid|success|approved|complete|completed|שולם|אושר/i.test(JSON.stringify(body));
      if (state && Array.isArray(state.payments) && paidSignal) {
        const p = state.payments.find(x => x?.id === paymentId);
        if (p && p.status !== 'paid') {
          p.status = 'paid';
          p.providerStatus = 'morning_webhook_paid';
          p.paidAt = new Date().toISOString();
          p.updatedAt = p.paidAt;
          const paidAmount = Number(body.amount || body.sum || body.total || p.amount) || Number(p.amount) || 0;
          if (paidAmount) p.amount = paidAmount;
          state.walletTx = Array.isArray(state.walletTx) ? state.walletTx : [];
          if (!state.walletTx.some(t => t.paymentId === paymentId)) state.walletTx.unshift({ date: p.paidAt, amount: paidAmount, type: 'income', note: `תשלום Morning התקבל: ${p.payerName || ''} · ${p.description || ''}`, paymentId });
          await env.EVENTS_KV.put(key, JSON.stringify({ ...state, eventId, updatedAt: new Date().toISOString() }));
        }
      }
    }
  }
  return jsonResponse({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/admin-login' && request.method === 'POST') return adminLogin(request, env);
    if (url.pathname === '/api/admin-password-reset/request' && request.method === 'POST') return requestAdminPasswordReset(request, env);
    if (url.pathname === '/api/admin-password-reset/complete' && request.method === 'POST') return completeAdminPasswordReset(request, env);
    if (url.pathname === '/api/auth/me') return jsonResponse({ ok: !!(await verifySession(request, env)), session: await verifySession(request, env) });
    if (url.pathname === '/api/events') return eventsApi(request, env);
    if (url.pathname === '/api/client-login' && request.method === 'POST') return clientLogin(request, env);
    if (url.pathname === '/api/event-assistant' && request.method === 'POST') return eventAssistantApi(request, env);
    if (url.pathname === '/api/event-assistant-history') return eventAssistantHistoryApi(request, env);
    if (url.pathname === '/api/event-actions') return eventActionsApi(request, env);
    if (url.pathname === '/api/event-state') return eventStateApi(request, env);
    if (url.pathname === '/api/event-team') return eventTeamApi(request, env);
    if (url.pathname === '/api/pending-participants' && request.method === 'GET') return pendingParticipantsApi(request, env);
    if (url.pathname === '/api/rsvp-link' && request.method === 'POST') return rsvpLinkApi(request, env);
    if (url.pathname === '/api/rsvp' && request.method === 'POST') return rsvpSubmitApi(request, env);
    if ((url.pathname === '/rsvp' || url.pathname.startsWith('/r/')) && request.method === 'GET') return rsvpPage(request, env);
    if (url.pathname === '/pay' && request.method === 'GET') return paymentChoicePage(request, env);
    if (url.pathname.startsWith('/p/') && request.method === 'GET') return paymentShortRedirect(request, env, url.pathname.split('/').filter(Boolean)[1]);
    if (url.pathname === '/api/payment-choice-link') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      return paymentChoiceLinkApi(request, env);
    }
    if (url.pathname === '/api/morning/create-gift-link') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      return createMorningGiftLink(request, env);
    }
    if (url.pathname === '/api/send-whatsapp') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      return sendWhatsApp(request, env);
    }
    if (url.pathname === '/api/morning/create-payment-link') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      return createMorningPaymentLink(request, env);
    }
    if (url.pathname === '/api/morning/webhook') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      return morningWebhook(request, env);
    }
    if (url.pathname === '/api/whatsapp-history') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
      return getWhatsAppHistory(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
