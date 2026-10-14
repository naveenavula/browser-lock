// Browser Lock — Cloudflare Worker backend
// Needs: KV binding CODES, secrets RESEND_API_KEY + JWT_SECRET, text var ALLOWED_EMAILS.

const CODE_TTL_SECONDS = 600;   // code valid for 10 minutes
const SESSION_HOURS = 12;       // unlock lasts 12 hours
const MAX_ATTEMPTS = 5;         // wrong tries per code
const RESEND_WAIT_MS = 30_000;  // min gap between code emails
const FROM = 'Browser Lock <onboarding@resend.dev>';

const enc = new TextEncoder();

// ---------- helpers ----------
function cors(request) {
  const origin = request.headers.get('Origin') || '';
  if (!origin.startsWith('chrome-extension://')) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(request) },
  });
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s) => b64url(enc.encode(s));
const fromB64url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function hmacHex(secret, text) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signJwt(payload, secret) {
  const head = b64urlText(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlText(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

async function verifyJwt(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const sigBytes = Uint8Array.from(fromB64url(sig), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, enc.encode(`${head}.${body}`));
  if (!ok) return null;
  const payload = JSON.parse(fromB64url(body));
  if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
  return payload;
}

const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

function allowedList(env) {
  return String(env.ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function newCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

async function sendEmail(env, to, code) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: `Your browser unlock code: ${code}`,
      text: `Your code to unlock your browser is ${code}\n\nIt expires in 10 minutes. If you didn't request this, someone is trying to open your browser.`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px">
        <h2 style="margin:0 0 8px">Unlock your browser</h2>
        <p style="color:#555">Enter this code in the lock screen:</p>
        <div style="font-size:32px;letter-spacing:8px;font-weight:700;padding:16px;background:#f3f3f5;border-radius:12px;text-align:center">${code}</div>
        <p style="color:#888;font-size:13px;margin-top:16px">Expires in 10 minutes. If you didn't request this, someone is trying to open your browser.</p>
      </div>`,
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

// ---------- routes ----------
async function requestCode(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!isEmail(email)) return json(request, { error: 'Enter a valid email address.' }, 400);
  if (!allowedList(env).includes(email)) {
    return json(request, { error: 'This email is not allowed to unlock this browser.' }, 403);
  }

  const key = `code:${email}`;
  const existing = await env.CODES.get(key, 'json');
  if (existing && Date.now() - existing.sentAt < RESEND_WAIT_MS) {
    return json(request, { error: 'Please wait 30 seconds before requesting another code.' }, 429);
  }

  const code = newCode();
  const record = { hash: await hmacHex(env.JWT_SECRET, `${email}:${code}`), attempts: 0, sentAt: Date.now(), expires: Date.now() + CODE_TTL_SECONDS * 1000 };

  try {
    await sendEmail(env, email, code);
  } catch (err) {
    console.log('Email failed:', err.message);
    return json(request, { error: 'Could not send the email. Check RESEND_API_KEY in the Worker settings.' }, 502);
  }
  await env.CODES.put(key, JSON.stringify(record), { expirationTtl: CODE_TTL_SECONDS });
  return json(request, { ok: true, expiresInMinutes: CODE_TTL_SECONDS / 60 });
}

async function verify(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const key = `code:${email}`;
  const record = await env.CODES.get(key, 'json');

  if (!record) return json(request, { error: 'No active code for this email. Request a new one.' }, 400);
  if (Date.now() > record.expires) {
    await env.CODES.delete(key);
    return json(request, { error: 'Code expired. Request a new one.' }, 400);
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    await env.CODES.delete(key);
    return json(request, { error: 'Too many wrong attempts. Request a new code.' }, 429);
  }

  const ok = /^\d{6}$/.test(code) && safeEqual(await hmacHex(env.JWT_SECRET, `${email}:${code}`), record.hash);
  if (!ok) {
    record.attempts += 1;
    const ttl = Math.max(60, Math.ceil((record.expires - Date.now()) / 1000));
    await env.CODES.put(key, JSON.stringify(record), { expirationTtl: ttl });
    return json(request, { error: `Wrong code. ${MAX_ATTEMPTS - record.attempts} attempts left.` }, 401);
  }

  await env.CODES.delete(key);
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const token = await signJwt({ sub: email, exp }, env.JWT_SECRET);
  return json(request, { ok: true, token, email, expiresAt: exp * 1000 });
}

async function session(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const payload = await verifyJwt(auth.replace(/^Bearer /, ''), env.JWT_SECRET).catch(() => null);
  if (!payload || !allowedList(env).includes(payload.sub)) return json(request, { ok: false }, 401);
  return json(request, { ok: true, email: payload.sub, expiresAt: payload.exp * 1000 });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });

    const missing = ['CODES', 'RESEND_API_KEY', 'JWT_SECRET', 'ALLOWED_EMAILS'].filter((k) => !env[k]);
    if (missing.length) return json(request, { error: `Worker is missing settings: ${missing.join(', ')}` }, 500);

    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/' || pathname === '/health') return json(request, { ok: true, service: 'browser-lock' });
      if (pathname === '/auth/request-code' && request.method === 'POST') return await requestCode(request, env);
      if (pathname === '/auth/verify' && request.method === 'POST') return await verify(request, env);
      if (pathname === '/auth/session' && request.method === 'GET') return await session(request, env);
      return json(request, { error: 'Not found' }, 404);
    } catch (err) {
      console.log('Error:', err.stack || err.message);
      return json(request, { error: 'Server error. Try again.' }, 500);
    }
  },
};
