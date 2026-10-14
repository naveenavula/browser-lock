import { API_BASE } from './config.js';

// While locked, the ONLY browser window allowed is a small frameless sign-in
// window. Every other window (normal, incognito/InPrivate, app) is closed and
// its tabs are saved, then reopened after a successful email login.

const LOCK_PATH = 'lock.html';
const LOCK_URL = chrome.runtime.getURL(LOCK_PATH);
const LOCK_W = 960;
const LOCK_H = 600;
const ALL_TYPES = ['normal', 'popup', 'panel', 'app', 'devtools'];

let verifiedToken = null; // token confirmed with the server during this run
let restoring = false;    // true while we swap the lock window for real windows

// ---------- session ----------
async function readSession() {
  const { session } = await chrome.storage.session.get('session');
  if (!session?.token || Date.now() > session.expiresAt) return null;
  return session;
}

async function checkWithServer(token) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${API_BASE}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false; // offline or server down: stay locked (strict)
  }
}

// A session only counts if the server has confirmed its token. This stops
// anyone writing a fake session into storage from DevTools.
async function isUnlocked() {
  const s = await readSession();
  if (!s) return false;
  if (s.token === verifiedToken) return true;
  if (await checkWithServer(s.token)) {
    verifiedToken = s.token;
    return true;
  }
  await chrome.storage.session.remove('session');
  return false;
}

// ---------- windows ----------
const isLockTab = (tab) => (tab?.url || tab?.pendingUrl || '').startsWith(LOCK_URL);

function isRestorable(url) {
  if (!url || url.startsWith(LOCK_URL)) return false;
  if (/^(chrome|edge|brave|opera|vivaldi):\/\/(newtab|new-tab-page)/.test(url)) return false;
  if (/^https:\/\/ntp\.msn\.com\/edge\/ntp/.test(url)) return false; // Edge new tab
  if (url === 'about:blank') return false;
  return true;
}

async function saveTabs(win) {
  if (win.incognito || !win.tabs) return;
  const urls = win.tabs.map((t) => t.url || t.pendingUrl).filter(isRestorable);
  if (!urls.length) return;
  const { savedWindows = [] } = await chrome.storage.local.get('savedWindows');
  const known = new Set(savedWindows.flat());
  const fresh = urls.filter((u) => !known.has(u));
  if (fresh.length) {
    savedWindows.push(fresh);
    await chrome.storage.local.set({ savedWindows });
  }
}

async function findLockWindows() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ALL_TYPES });
  return wins.filter((w) => w.tabs?.some(isLockTab));
}

async function ensureLockWindow() {
  const existing = await findLockWindows();
  if (existing.length) {
    // Keep one, close duplicates (e.g. restored by the browser after a restart).
    for (const extra of existing.slice(1)) await chrome.windows.remove(extra.id).catch(() => {});
    const keep = existing[0];
    await chrome.windows.update(keep.id, { focused: true, state: 'normal' }).catch(() => {});
    return keep;
  }
  return chrome.windows.create({
    url: LOCK_URL,
    type: 'popup',
    width: LOCK_W,
    height: LOCK_H,
    focused: true,
  });
}

async function runLock() {
  if (restoring || (await isUnlocked())) return;
  const lockWin = await ensureLockWindow(); // created FIRST so the browser never has zero windows
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ALL_TYPES });
  for (const w of wins) {
    if (w.id === lockWin.id) continue;
    await saveTabs(w);
    await chrome.windows.remove(w.id).catch(() => {});
  }
}

// Serialise lock runs so overlapping events don't create several lock windows.
let queue = Promise.resolve();
function enforceLock() {
  queue = queue.then(runLock).catch((e) => console.warn('lock error', e));
  return queue;
}

async function restoreWindows() {
  restoring = true;
  try {
    const { savedWindows = [] } = await chrome.storage.local.get('savedWindows');
    const lockWins = await findLockWindows();
    let created = 0;
    for (const urls of savedWindows) {
      try {
        await chrome.windows.create({ url: urls, type: 'normal', focused: true, state: 'maximized' });
        created++;
      } catch {
        // A URL the browser refuses to open: open the rest one by one.
        const w = await chrome.windows.create({ type: 'normal', state: 'maximized' });
        created++;
        for (const u of urls) await chrome.tabs.create({ windowId: w.id, url: u }).catch(() => {});
      }
    }
    if (!created) await chrome.windows.create({ type: 'normal', focused: true, state: 'maximized' });
    await chrome.storage.local.remove('savedWindows');
    for (const w of lockWins) await chrome.windows.remove(w.id).catch(() => {});
  } finally {
    restoring = false;
  }
}

async function lockNow() {
  await chrome.storage.session.remove('session');
  verifiedToken = null;
  await enforceLock();
}

// ---------- events ----------
chrome.runtime.onStartup.addListener(enforceLock);
chrome.runtime.onInstalled.addListener(enforceLock);

chrome.windows.onCreated.addListener(() => enforceLock());

chrome.tabs.onCreated.addListener((tab) => {
  if (!isLockTab(tab)) enforceLock();
});

chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url) enforceLock();
});

// When the last window closes, forget the login. Covers browsers that keep
// running in the background (Edge "startup boost", "continue running apps").
chrome.windows.onRemoved.addListener(async () => {
  if (restoring) return;
  const left = await chrome.windows.getAll({ windowTypes: ALL_TYPES });
  if (left.length === 0) {
    await chrome.storage.session.remove('session');
    verifiedToken = null;
  }
});

// Expiry check every minute.
chrome.alarms.create('session-check', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'session-check') return;
  const s = await readSession();
  if (!s) return enforceLock();
  if (s.token === verifiedToken && navigator.onLine) {
    // Recheck with the server occasionally; a 401 means revoked/invalid.
    const r = await fetch(`${API_BASE}/auth/session`, { headers: { Authorization: `Bearer ${s.token}` } }).catch(() => null);
    if (r && r.status === 401) return lockNow();
  }
});

// If anything writes a session we haven't verified, check it straight away.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'session' in changes) {
    if (!changes.session.newValue) enforceLock();
    else if (changes.session.newValue.token !== verifiedToken) enforceLock();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'status') {
      const unlocked = await isUnlocked();
      const s = unlocked ? await readSession() : null;
      sendResponse({ unlocked, email: s?.email, expiresAt: s?.expiresAt });
    } else if (msg.type === 'unlock') {
      const s = msg.session;
      if (!s?.token || !(await checkWithServer(s.token))) {
        sendResponse({ ok: false, error: 'Could not confirm the login. Try again.' });
        return;
      }
      verifiedToken = s.token;
      await chrome.storage.session.set({ session: s });
      sendResponse({ ok: true });
      await restoreWindows();
    } else if (msg.type === 'lock') {
      sendResponse({ ok: true });
      await lockNow();
    }
  })();
  return true;
});
