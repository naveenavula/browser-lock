import { API_BASE } from './config.js';

const $ = (id) => document.getElementById(id);
const msg = $('msg');
const bar = $('bar');
const boxes = [...document.querySelectorAll('#code input')];
const emailInput = $('email');
let email = '';

const W = 960, H = 600;

// Keep the sign-in window centred and at its intended size.
chrome.windows.getCurrent((win) => {
  if (!win || win.type !== 'popup') return;
  const left = Math.round((screen.availLeft || 0) + (screen.availWidth - W) / 2);
  const top = Math.round((screen.availTop || 0) + (screen.availHeight - H) / 2);
  chrome.windows.update(win.id, { left, top, width: W, height: H, focused: true });
});

// If this page is somehow open while already unlocked, just close it.
chrome.runtime.sendMessage({ type: 'status' }, (s) => {
  if (s?.unlocked) window.close();
});

function say(text, ok = false) {
  msg.textContent = text;
  msg.className = ok ? 'msg ok' : 'msg';
}

function step(name) {
  $('email-form').hidden = name !== 'email';
  $('code-form').hidden = name !== 'code';
  $('done').hidden = name !== 'done';
  bar.style.width = { email: '12%', code: '55%', done: '100%' }[name];
  if (name === 'email') emailInput.focus();
  if (name === 'code') { boxes.forEach((b) => (b.value = '')); boxes[0].focus(); updateCodeBtn(); }
}

async function api(path, body) {
  let r;
  try {
    r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('No connection to the sign-in server. Check your internet.');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Something went wrong (${r.status}).`);
  return data;
}

function busy(btn, on) {
  btn.classList.toggle('busy', on);
  btn.disabled = on;
}

// ---------- step 1: email ----------
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
emailInput.addEventListener('input', () => {
  $('email-btn').disabled = !validEmail(emailInput.value.trim());
  say('');
});

async function sendCode() {
  await api('/auth/request-code', { email });
  $('sent-to').textContent = email;
}

$('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  email = emailInput.value.trim().toLowerCase();
  if (!validEmail(email)) return;
  const btn = $('email-btn');
  busy(btn, true); say('');
  try {
    await sendCode();
    step('code');
    say('Code sent — check your inbox (and spam).', true);
  } catch (err) {
    say(err.message);
  } finally {
    busy(btn, false);
    $('email-btn').disabled = !validEmail(emailInput.value.trim());
  }
});

// ---------- step 2: code ----------
const codeValue = () => boxes.map((b) => b.value).join('');
function updateCodeBtn() { $('code-btn').disabled = codeValue().length !== 6; }

boxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(-1);
    if (box.value && i < 5) boxes[i + 1].focus();
    updateCodeBtn();
    if (codeValue().length === 6) $('code-form').requestSubmit();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ''; updateCodeBtn(); }
    if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
    if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus();
  });
  box.addEventListener('paste', (e) => {
    const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!digits) return;
    e.preventDefault();
    digits.split('').forEach((d, j) => { if (boxes[j]) boxes[j].value = d; });
    boxes[Math.min(digits.length, 5)].focus();
    updateCodeBtn();
    if (digits.length === 6) $('code-form').requestSubmit();
  });
});

let verifying = false;
$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (verifying || codeValue().length !== 6) return;
  verifying = true;
  const btn = $('code-btn');
  busy(btn, true); say('');
  try {
    const data = await api('/auth/verify', { email, code: codeValue() });
    step('done'); say('');
    const res = await chrome.runtime.sendMessage({
      type: 'unlock',
      session: { token: data.token, email: data.email, expiresAt: data.expiresAt },
    });
    if (res && res.ok === false) throw new Error(res.error);
    // The background closes this window and reopens your tabs.
  } catch (err) {
    step('code');
    say(err.message);
    $('code').classList.add('shake');
    setTimeout(() => $('code').classList.remove('shake'), 350);
  } finally {
    verifying = false;
    busy(btn, false);
    updateCodeBtn();
  }
});

$('resend').addEventListener('click', async () => {
  try { await sendCode(); say('New code sent.', true); boxes[0].focus(); }
  catch (err) { say(err.message); }
});
$('change').addEventListener('click', () => { say(''); step('email'); });
$('back').addEventListener('click', () => { say(''); step('email'); });

// Block the usual escape hatches inside this window.
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && ['i', 'j', 'c'].includes(k)) || (e.ctrlKey && k === 'u')) {
    e.preventDefault();
  }
});

step('email');
