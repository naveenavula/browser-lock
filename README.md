# Browser Lock

A Chrome / Edge extension that locks the whole browser behind an email login, in the style of Dia's sign-in window.

While locked, the only browser window is a small sign-in window: no tabs, bookmarks, history, settings or menus. Any other window, including Incognito / InPrivate, is closed the moment it opens. You enter your email, get a 6-digit code, and the browser opens with your tabs restored.

The backend is a free Cloudflare Worker that emails codes through Resend. Nothing runs on your PC except the extension.

```
browser-lock/
├── worker/worker.js   Cloudflare Worker: sends codes, verifies them, issues sessions
└── extension/         The browser extension (Manifest V3)
```

## Setup

### 1. Resend (sends the emails)

1. Sign up at [resend.com](https://resend.com) with the email address that should unlock the browser. Without your own domain, Resend only delivers to your sign-up address.
2. **API Keys → Create API Key** with *Sending access*. Copy the key (starts with `re_`); it's shown once.

### 2. Cloudflare Worker (the backend)

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free, no domain needed).
2. **Workers & Pages → Create → Start with Hello World**, name it `browser-lock`, and deploy. Note its address, e.g. `https://browser-lock.yourname.workers.dev`.
3. **Storage & Databases → KV → Create** a namespace called `browser-lock-codes`.
4. Open the Worker → **Settings → Bindings → Add binding → KV namespace**. Variable name `CODES`, namespace `browser-lock-codes`.
5. **Settings → Variables and Secrets → Add**:

   | Key | Type | Value |
   |---|---|---|
   | `RESEND_API_KEY` | Secret | your `re_…` key |
   | `JWT_SECRET` | Secret | a random string, 40+ letters and numbers |
   | `ALLOWED_EMAILS` | Text | your email (comma-separate several) |

6. **Edit code**, replace everything with the contents of `worker/worker.js`, and **Deploy**.
7. Open your Worker's address in a browser. You should see `{"ok":true,"service":"browser-lock"}`.

### 3. Point the extension at your Worker

Replace `YOUR-SUBDOMAIN` with your own Workers subdomain in **both**:

- `extension/config.js`
- `extension/manifest.json` (`host_permissions`)

### 4. Load the extension

1. Go to `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
2. **Load unpacked** → choose the `extension` folder. Keep the folder where it is; the browser runs it from there.
3. **Details → Allow in Incognito** (Edge: **Allow in InPrivate**), otherwise private windows aren't blocked.

The browser locks immediately. Sign in with your email and the code.

## How it works

- Locked whenever the browser starts or all its windows are closed.
- A login lasts 12 hours, then the browser locks again. Tabs are saved and reopened after signing in.
- Toolbar icon → **Lock browser now** locks on demand.
- Codes expire after 10 minutes, are single-use, and allow 5 wrong attempts. A new code can be requested every 30 seconds.
- Emails not in `ALLOWED_EMAILS` are refused and no email is sent.
- Every session token is checked with the Worker, so a session faked from DevTools is rejected.
- Offline means you can't unlock.

Settings such as session length and code lifetime are constants at the top of `worker/worker.js`.

## Limits

An extension can't stop someone who starts the browser with extensions disabled, or who uses a Guest or different profile. For a lock that can't be bypassed, use Chrome/Edge enterprise policy to force-install the extension and disable guest mode, Incognito/InPrivate and adding profiles.

The browser may briefly show the last window at startup before the lock closes it, and the sign-in window keeps the browser's thin title strip.
