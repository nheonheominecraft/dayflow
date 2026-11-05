const { app, BrowserWindow, Notification, shell } = require('electron');
const path = require('path'), fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const url = process.env.DAYFLOW_URL || cfg.serverUrl;
app.setAppUserModelId('com.dayflow.desktop'); // needed for Windows notifications
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1280, height: 820, autoHideMenuBar: true, backgroundColor: '#080711' });
  w.loadURL(url);
  w.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  w.webContents.on('did-fail-load', (_e, _c, desc) => w.loadURL('data:text/html,<body style="background:#080711;color:#F5F1FF;font:16px sans-serif;padding:40px"><h2>Cannot reach your DayFlow server</h2><p>' + url + '</p><p>' + desc + '</p><p>Check the server is running, then restart DayFlow.</p>'));
});
app.on('window-all-closed', () => app.quit());
