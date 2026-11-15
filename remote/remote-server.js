/* MusicRepeat リモコンサーバー(メインプロセス)
 * 内蔵 http でスマホ用UIを配信し、ws でリアルタイム同期する。
 * Express 等は使わず Node 標準のみ(+ws)で構成。 */

const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ico': 'image/x-icon'
};

let server = null;
let wss = null;
let port = 0;
let lastState = null;   // 新規接続したスマホに即座に現状を届けるためのキャッシュ
let lastTracks = null;
let staffToken = '';    // 店員認証トークン(サーバー起動ごとに再生成)
let staffCode = '';     // PC画面に表示する6桁の店員コード(手動認証用)

/* LAN上の自分のIPv4アドレス一覧 */
function localIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out.length ? out : ['127.0.0.1'];
}

async function serveFile(req, res) {
  let p;
  try {
    p = new URL(req.url, 'http://x').pathname;
  } catch {
    res.writeHead(400); res.end(); return;
  }
  // 「/」= お客さん用、「/staff」= 店員用 → どちらも同じ index.html(役割は app.js が判断)
  if (p === '/' || p === '/staff' || p === '/index.html') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403); res.end(); return;
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}

function sendTo(sock, obj) {
  try { if (sock.readyState === 1) sock.send(JSON.stringify(obj)); } catch {}
}

function broadcast(obj) {
  if (obj.type === 'state') lastState = obj;
  if (obj.type === 'tracks') lastTracks = obj;
  if (!wss) return;
  const data = JSON.stringify(obj);
  for (const c of wss.clients) {
    try { if (c.readyState === 1) c.send(data); } catch {}
  }
}

function info(qrStaff, qrGuest) {
  return {
    running: true,
    port,
    urls: localIPs().map((ip) => `http://${ip}:${port}`),
    qr: qrStaff || null,
    qrStaff: qrStaff || null,
    qrGuest: qrGuest || null,
    staffCode
  };
}

/* 起動。希望ポートから順に20ポートまで空きを探す */
function start(portWanted, onCommand) {
  if (server) return Promise.resolve(info());
  staffToken = crypto.randomBytes(16).toString('hex');
  staffCode = String(100000 + Math.floor(Math.random() * 900000));
  return new Promise((resolve) => {
    const tryPort = (p) => {
      if (p > portWanted + 20) { resolve(null); return; }
      let listening = false;
      const srv = http.createServer(serveFile);
      const w = new WebSocketServer({ server: srv, path: '/ws' });
      srv.once('error', () => {
        // 起動済みのサーバーでエラーが起きても勝手に作り直さない(停止の原因になるため)
        if (listening) return;
        try { srv.close(); } catch {}
        tryPort(p + 1);
      });
      w.on('connection', (sock, req) => {
        // 接続時の ?auth= トークン(店員QRに埋め込み)で役割を決める
        let role = 'guest';
        try {
          const a = new URL(req.url, 'http://x').searchParams.get('auth');
          if (a && a === staffToken) role = 'staff';
          else if (a) sendTo(sock, { type: 'authFail' });  // トークンが古い場合
        } catch {}
        sock.role = role;
        if (lastState) sendTo(sock, lastState);
        if (lastTracks) sendTo(sock, lastTracks);
        sock.on('message', (data) => {
          try {
            const msg = JSON.parse(String(data));
            if (!msg) return;
            if (msg.type === 'auth') {
              // PC画面に表示した6桁の店員コードでの手動認証
              const ok = String(msg.code || '').trim() === staffCode;
              if (ok) sock.role = 'staff';
              sendTo(sock, { type: ok ? 'authOk' : 'authFail', token: ok ? staffToken : null });
              return;
            }
            if (msg.type === 'cmd' && onCommand) onCommand(Object.assign({ role: sock.role || 'guest' }, msg));
          } catch {}
        });
      });
      srv.listen(p, '0.0.0.0', async () => {
        server = srv;
        wss = w;
        port = p;
        const base = `http://${localIPs()[0]}:${p}`;
        let qrStaff = null, qrGuest = null;
        try {
          qrStaff = await QRCode.toDataURL(`${base}/staff?t=${staffToken}`, {
            width: 340, margin: 1,
            color: { dark: '#14100e', light: '#f3e9dc' }
          });
        } catch {}
        try {
          qrGuest = await QRCode.toDataURL(`${base}/?role=guest`, {
            width: 340, margin: 1,
            color: { dark: '#5a3d28', light: '#e8d5b5' }
          });
        } catch {}
        resolve(info(qrStaff, qrGuest));
      });
    };
    tryPort(portWanted || 8080);
  });
}

function stop() {
  return new Promise((resolve) => {
    lastState = null;
    lastTracks = null;
    if (!server) { resolve(false); return; }
    const srv = server;
    const ws = wss;
    server = null; wss = null; port = 0;
    try { for (const c of ws.clients) c.close(); } catch {}
    srv.close(() => resolve(true));
  });
}

function sendState(s) { broadcast(Object.assign({ type: 'state' }, s)); }
function sendTracks(t) { broadcast(Object.assign({ type: 'tracks' }, t)); }

module.exports = { start, stop, sendState, sendTracks };
