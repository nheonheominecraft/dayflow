# DayFlow (backend + web client)

Zero-dependency Node.js server (Node 22.13+; uses built-in `node:sqlite` and `node:crypto`) that also serves the DayFlow web app from `public/index.html`. Windows and Android apps are **not built yet** (see "Native apps").

## Install and run
```
node -v                      # must be 22.13 or newer
cp .env.example .env         # then edit; export the variables (the server does not read .env itself):
export $(grep -v '^#' .env | xargs)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into DAYFLOW_MASTER_KEY
npm start                    # http://localhost:8787
```
No `npm install` is needed. The SQLite database is created at `DAYFLOW_DATA_DIR/dayflow.db` on first start (schema in `server/db.js`). **Back up the data directory and the master key**: without the key, stored AI API keys cannot be decrypted. If `DAYFLOW_MASTER_KEY` is unset the server generates `data/master.key` and warns.

Put the server behind HTTPS (e.g. Caddy or nginx) before using it over a network; set `DAYFLOW_TRUST_PROXY=1` only behind a proxy you control.

## Configure VyceAI
Default provider is VyceAI, `https://vyceai.com/v1`, default model display name "DeepSeek V4.1 Flash" with model ID `deepseek-v4.1`. **That ID is unverified** (it could not be checked from the build environment). In the app: Settings, AI Assistant, paste your key, Save key, Test connection, Refresh models. DayFlow marks the model ID "found in the provider list" only when the provider returns it. If it is not found, pick the correct ID from the list or enter it manually. The server never changes your model on its own.

## Architecture
- `server/auth.js` accounts and sessions (scrypt password hashes, hashed session tokens, 30-day sliding sessions, rate limits, password reset codes, export, deletion).
- `server/sync.js` document sync: per-record versions, server-side sequence for pulls, idempotent operation IDs, conflicts returned instead of overwritten, deletes as tombstones.
- `server/ai.js` provider storage (keys AES-256-GCM encrypted, never returned), OpenAI-compatible proxy with streaming, usage tracking, optional hard monthly limit, URL checks against private addresses.
- `server/files.js` private uploads (10 MB, type allowlist plus content check, 200 MB quota).
- Data model: tasks, events, classes, reminders, notes, chats, settings and whiteboard are stored as JSON documents per user (`records` table) rather than one SQL table each. Homework is a task with a School category and subtasks.

## Tests
```
npm test                                  # 8 API test groups (mock AI provider included)
pip install playwright && playwright install chromium
python3 test/e2e.py                       # two simulated devices, offline, conflicts, AI, uploads, notifications
```
## Testing sync and notifications by hand
1. Open the server URL in two browsers (or a desktop browser and a phone on the same network). Sign in with the same account; on the second device choose "Use my account data".
2. Create or edit a task on one device; press the sync pill in the header on the other (it also polls every 20 s).
3. Go offline (browser dev tools), edit, go online: the pill shows Offline then Synced. Edit one task on both devices while one is offline to see the conflict dialog.
4. Notifications: Settings, General, System notifications, Enable. Create a reminder a minute ahead and keep DayFlow open.

## Costs
Everything above is free to self-host. Costs you may incur: a server or VPS (a small one is enough), a domain and TLS certificate (Let's Encrypt is free), your AI provider usage, and for the future native apps: Android Play Console one-time fee, optional Windows code-signing certificate, Firebase Cloud Messaging (free tier).

## Not done yet (be aware)
- **Windows and Android apps, native notifications while the app is closed, FCM push**: not built or tested. See below.
- **Password reset email**: not implemented. Reset codes exist, but nothing sends them (administrator can use `DAYFLOW_DEV_RESET=1` in development only).
- **AI tool calling, vision, file contents to the model**: not implemented. Uploaded files are stored privately but not sent to any model. "Include my tasks and events" adds a read-only text snapshot of your own data to the prompt.
- **Server-side reminders and snooze**: reminders are evaluated on each device while DayFlow is open; multiple reminders per task, snooze and rescheduling controls are not built.
- **Task file attachments**: only AI-chat attachments are wired.
- **Spending limits** are enforced only for providers where you entered prices, using provider-reported token counts.
- Session tokens live in `localStorage` (standard for this architecture; XSS would expose them). Database backups are your responsibility.

## Native apps (next stage, requires your machines and devices)
- Windows: wrap `public/index.html` pointing at your server with Electron or Tauri; schedule local notifications from synced data in the main process; code-sign for distribution.
- Android: wrap with Capacitor; use its Local Notifications plugin (channels, exact alarms only if justified) and WorkManager for sync; FCM for remote push; set `DAYFLOW_CORS_ORIGINS` for the app's origin.
- These must be tested on real devices before claiming background delivery works.
