const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, net } = require('electron');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const remote = require('./remote/remote-server');

// 自動再生を許可(起動後すぐにBGMを流せるように)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// addon:// スキーマ(rendererからアドオンのCSS/JS/音源を安全に読めるように)
protocol.registerSchemesAsPrivileged([
  { scheme: 'addon', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus', '.webm'];

let win = null;

/* ---------- ウィンドウ状態の保存・復元 ---------- */
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}
function saveState() {
  try {
    if (!win) return;
    const b = win.getBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({
      x: b.x, y: b.y, width: b.width, height: b.height,
      maximized: win.isMaximized()
    }));
  } catch {}
}

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: (st && st.width) || 1120,
    height: (st && st.height) || 720,
    x: st && st.x !== undefined ? st.x : undefined,
    y: st && st.y !== undefined ? st.y : undefined,
    minWidth: 880,
    minHeight: 560,
    frame: false,
    backgroundColor: '#0e1014',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (st && st.maximized) win.maximize();
    win.show();
  });
  win.on('enter-full-screen', () => win.webContents.send('fs-changed', true));
  win.on('leave-full-screen', () => win.webContents.send('fs-changed', false));
  win.on('close', saveState);
}

app.whenReady().then(() => {
  // 出力デバイス一覧のラベル表示のため media 権限のみ許可
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  // addon:// スキーマ → userData/addons/<id>/... のファイルを配信
  protocol.handle('addon', (request) => {
    try {
      const u = new URL(request.url);
      const id = u.hostname;
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!id || !rel || !/^[a-zA-Z0-9._-]+$/.test(id)) {
        return new Response('bad request', { status: 400 });
      }
      const p = path.resolve(addonsDir(), id, rel);
      if (!p.startsWith(path.resolve(addonsDir()))) {
        return new Response('forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(p).toString());
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
// 終了を速く: 状態を保存したらすぐ破棄(リモコンサーバーも閉じる)
app.on('before-quit', () => {
  saveState();
  remote.stop();
  try { if (win) win.destroy(); } catch {}
  try { if (signageWin) signageWin.destroy(); } catch {}
});

/* ---------- サインageージウィンドウ ---------- */

let signageWin = null;

async function openSignage(data) {
  if (signageWin && !signageWin.isDestroyed()) {
    signageWin.webContents.send('signage:data', data);
    signageWin.focus();
    return true;
  }
  signageWin = new BrowserWindow({
    fullscreen: true,
    frame: false,
    backgroundColor: '#14100e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  signageWin.setAlwaysOnTop(true, 'screen-saver');
  await signageWin.loadFile(path.join(__dirname, 'signage', 'index.html'));
  signageWin.webContents.send('signage:data', data);
  signageWin.on('closed', () => { signageWin = null; });
  return true;
}

function sendToSignage(msg) {
  try {
    if (signageWin && !signageWin.isDestroyed()) signageWin.webContents.send('signage:data', msg);
  } catch {}
}

/* ---------- IPC ---------- */

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '音楽フォルダーを選択',
    properties: ['openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// 音楽ファイルを探す。sort='mtime' のときだけ更新日時も取得する(ネットワークフォルダー高速化のため)
async function walk(dir, out, depth = 0, wantStat = false) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out, depth + 1, wantStat);
    } else if (AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())) {
      const f = { name: e.name, path: p, size: 0, mtimeMs: 0 };
      if (wantStat) {
        try {
          const st = await fsp.stat(p);
          f.mtimeMs = st.mtimeMs;
          f.size = st.size;
        } catch {}
      }
      out.push(f);
    }
  }
}

ipcMain.handle('folder:scan', async (_e, dir, sort = 'name') => {
  try {
    const st = await fsp.stat(dir);
    if (st.isFile()) dir = path.dirname(dir);
  } catch {}
  const files = [];
  await walk(dir, files, 0, sort === 'mtime');
  if (sort === 'mtime') {
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } else {
    files.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }
  return { dir, files };
});

ipcMain.handle('file:read', async (_e, p) => {
  const buf = await fsp.readFile(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('app:version', () => app.getVersion());

/* ---------- 拡張機能(アドオン) ---------- *
 * userData/addons/<id>/ に展開されたアドオンを管理。
 * type: 'theme'(CSSを差し込む) / 'plugin'(JSを差し込む) / 'ambient'(環境音を追加) */

function addonsDir() {
  return path.join(app.getPath('userData'), 'addons');
}

const ADDON_TYPES = ['theme', 'plugin', 'ambient'];

function validAddonId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id);
}

async function listAddons() {
  const base = addonsDir();
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !validAddonId(e.name)) continue;
    try {
      const mf = JSON.parse(await fsp.readFile(path.join(base, e.name, 'addon.json'), 'utf8'));
      if (!ADDON_TYPES.includes(mf.type)) continue;
      out.push({
        id: e.name,
        name: mf.name || e.name,
        version: mf.version || '',
        type: mf.type,
        description: mf.description || '',
        author: mf.author || '',
        entry: mf.entry || '',
        ambient: Array.isArray(mf.ambient) ? mf.ambient : []
      });
    } catch {}
  }
  return out;
}

/* zipを一時フォルダーに展開し、addon.json を含むルートを探す */
async function extractAddonZip(zipPath) {
  const dest = path.join(os.tmpdir(), `mr-addon-x-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fsp.mkdir(dest, { recursive: true });
  const code = await new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`
    ], { windowsHide: true });
    ps.on('error', () => resolve(1));
    ps.on('close', (c) => resolve(c));
  });
  if (code !== 0) {
    await fsp.rm(dest, { recursive: true, force: true });
    throw new Error('zipの展開に失敗しました(PowerShell)');
  }
  // addon.json を探す(zipのルート直下 or 1階層のフォルダー内)
  let base = dest;
  const walkJson = async (dir, depth) => {
    if (depth > 2) return null;
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const it of items) {
      if (it.isFile() && it.name === 'addon.json') return dir;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        const r = await walkJson(path.join(dir, it.name), depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  const found = await walkJson(dest, 0);
  if (!found) {
    await fsp.rm(dest, { recursive: true, force: true });
    throw new Error('addon.json が見つかりません(アドオンの形式が違います)');
  }
  return { dest, base: found };
}

async function installAddonFromZip(zipPath) {
  const { dest, base } = await extractAddonZip(zipPath);
  try {
    const mf = JSON.parse(await fsp.readFile(path.join(base, 'addon.json'), 'utf8'));
    if (!validAddonId(mf.id)) throw new Error('アドオンのidが不正です');
    if (!ADDON_TYPES.includes(mf.type)) throw new Error(`未対応の種類です: ${mf.type}`);

    // 参照先のファイルが本当に存在し、フォルダー外へ逃げないか検証
    const refs = [];
    if (mf.entry) refs.push(mf.entry);
    for (const a of mf.ambient || []) refs.push(a.file);
    for (const r of refs.filter(Boolean)) {
      const p = path.resolve(base, r);
      if (!p.startsWith(path.resolve(base))) throw new Error(`不正なパス: ${r}`);
      try { await fsp.access(p); } catch { throw new Error(`ファイルがありません: ${r}`); }
    }

    const target = path.join(addonsDir(), mf.id);
    await fsp.mkdir(addonsDir(), { recursive: true });
    await fsp.rm(target, { recursive: true, force: true });   // 同じidは上書き
    await fsp.cp(base, target, { recursive: true });
    return { id: mf.id, name: mf.name || mf.id, version: mf.version || '', type: mf.type, description: mf.description || '', author: mf.author || '' };
  } finally {
    await fsp.rm(dest, { recursive: true, force: true });
  }
}

ipcMain.handle('addons:list', () => listAddons());

ipcMain.handle('addons:installFromUrl', async (_e, url) => {
  if (!/^https:\/\/[^\s]+$/.test(String(url || ''))) throw new Error('httpsのURLのみ受け付けます');
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`ダウンロード失敗 (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `mr-addon-d-${Date.now()}.zip`);
  await fsp.writeFile(tmp, buf);
  try {
    return await installAddonFromZip(tmp);
  } finally {
    try { await fsp.unlink(tmp); } catch {}
  }
});

ipcMain.handle('addons:installFromZip', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'アドオン(zip)を選択',
    properties: ['openFile'],
    filters: [{ name: 'アドオン', extensions: ['zip'] }]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return await installAddonFromZip(res.filePaths[0]);
});

ipcMain.handle('addons:remove', async (_e, id) => {
  if (!validAddonId(id)) throw new Error('不正なidです');
  await fsp.rm(path.join(addonsDir(), id), { recursive: true, force: true });
  return true;
});

ipcMain.handle('addons:openFolder', async () => {
  await fsp.mkdir(addonsDir(), { recursive: true });
  shell.openPath(addonsDir());
  return true;
});

/* ---------- FFmpeg による変換(直接再生できないファイルの救済) ---------- */

function ffmpegPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  }
  return path.join(__dirname, 'bin', 'ffmpeg.exe');
}

// 音声を mp3(192kbps) に変換して返す(動画コンテナや未対応形式もこれで再生できるように)
// ネットワーク共有上のファイルは ffmpeg が直接開けないことがあるため、
// 一度ローカルの一時ファイルに置いてから変換する。失敗理由は stderr で返す。
ipcMain.handle('audio:transcode', async (_e, p) => {
  const tmpIn = path.join(os.tmpdir(), `mr-in-${Date.now()}-${Math.floor(Math.random() * 1e6)}${path.extname(p) || ''}`);
  const tmpOut = path.join(os.tmpdir(), `mr-out-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp3`);
  const cleanup = () => {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  };
  // 元ファイルをローカルにコピー(ここで失敗したらネットワーク問題)
  let data;
  try {
    data = await fsp.readFile(p);
  } catch (e) {
    cleanup();
    return { data: null, error: 'ファイル読み込み失敗: ' + String(e && e.message || e) };
  }
  try { await fsp.writeFile(tmpIn, data); } catch { cleanup(); return { data: null, error: '一時ファイル作成失敗' }; }

  return await new Promise((resolve) => {
    let ff;
    try {
      ff = spawn(ffmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', tmpIn, '-vn', '-ac', '2',
        '-codec:a', 'libmp3lame', '-b:a', '192k',
        '-y', tmpOut
      ], { windowsHide: true });
    } catch (e) {
      cleanup();
      resolve({ data: null, error: '変換エンジン起動失敗: ' + String(e && e.message || e) });
      return;
    }
    let done = false;
    let stderrTail = '';
    const finish = (val, err) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      try { ff.kill(); } catch {}
      cleanup();
      resolve({ data: val, error: err || null });
    };
    const killer = setTimeout(() => finish(null, '変換がタイムアウトしました(5分)'), 5 * 60 * 1000);
    ff.stderr.on('data', (c) => {
      stderrTail = (stderrTail + String(c)).slice(-400);
    });
    ff.on('error', (e) => finish(null, '変換エンジン起動失敗: ' + String(e && e.message || e)));
    ff.on('close', async (code) => {
      if (code === 0) {
        try {
          const out = await fsp.readFile(tmpOut);
          finish(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
        } catch (e) {
          finish(null, '変換結果の読み取り失敗: ' + String(e && e.message || e));
        }
      } else {
        finish(null, stderrTail.trim() || `ffmpeg exit ${code}`);
      }
    });
  });
});

/* ---------- ウィンドウ / システム操作 ---------- */

ipcMain.on('win:minimize', () => win.minimize());
ipcMain.on('win:close', () => app.quit()); // 即終了
ipcMain.on('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:fullscreen', () => win.setFullScreen(!win.isFullScreen()));
ipcMain.handle('win:alwaysOnTop', () => {
  const v = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(v, 'screen-saver');
  return v;
});
ipcMain.on('file:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('sys:bluetooth', () => shell.openExternal('ms-settings:bluetooth'));

ipcMain.on('sys:shutdown', () => {
  try { spawn('shutdown', ['/s', '/t', '60']); } catch {}
});

ipcMain.on('sys:shutdownAbort', () => {
  try { spawn('shutdown', ['/a']); } catch {}
});

ipcMain.handle('signage:open', async (_e, data) => {
  const d = Object.assign({}, data);
  try {
    if (d.snsUrl) d.snsQr = await require('qrcode').toDataURL(d.snsUrl, { width: 300, margin: 1, color: { dark: '#f3e9dc', light: '#14100e' } });
  } catch {}
  try {
    if (d.wifiSsid && d.wifiPass) {
      const wifi = `WIFI:T:WPA;S:${d.wifiSsid};P:${d.wifiPass};;`;
      d.wifiQr = await require('qrcode').toDataURL(wifi, { width: 300, margin: 1, color: { dark: '#f3e9dc', light: '#14100e' } });
    }
  } catch {}
  return await openSignage(d);
});

ipcMain.on('signage:close', () => { try { if (signageWin) signageWin.close(); } catch {} });
ipcMain.on('signage:update', (_e, msg) => sendToSignage(msg));

ipcMain.handle('dialog:pickAudioFile', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '環境音ファイルを選択',
    properties: ['openFile'],
    filters: [{ name: '音声ファイル', extensions: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'webm'] }]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

/* ---------- スマホリモコン(ローカルサーバー) ---------- */

ipcMain.handle('remote:start', async (_e, port, tls) => {
  return await remote.start(port || 8080, (msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('remote:cmd', msg);
  }, { tls: !!tls });
});

ipcMain.handle('remote:stop', () => remote.stop());

ipcMain.on('remote:state', (_e, s) => remote.sendState(s));
ipcMain.on('remote:tracks', (_e, t) => remote.sendTracks(t));
