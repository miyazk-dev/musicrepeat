/* MusicRepeat リモコンサーバー(メインプロセス)
 * 内蔵 http でスマホ用UIを配信し、ws でリアルタイム同期する。
 * Express 等は使わず Node 標準のみ(+ws)で構成。 */

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { app } = require('electron');
const forge = require('node-forge');
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
  '.ico': 'image/x-icon',
  '.crt': 'application/x-x509-ca-cert',
  '.pem': 'application/x-x509-ca-cert'
};

let server = null;      // http(常時: 証明書ダウンロード・QRスキャン直後の接続用)
let tlsServer = null;   // https(PWAインストール・オフライン起動用)
let wss = null;
let port = 0;
let tlsPort = 0;
let caPem = '';
let tlsRequested = false;
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
  // スマホにCA証明書をダウンロードさせる特別パス
  if ((p === '/ca.crt' || p === '/ca.pem') && caPem) {
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="MusicRepeat-Local-CA.crt"',
      'Cache-Control': 'no-cache'
    });
    res.end(caPem);
    return;
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

function info(qrStaff, qrGuest, qrCert) {
  return {
    running: true,
    port,
    tlsPort,
    tls: !!(tlsServer && tlsPort),
    tlsRequested: tlsRequested,
    urls: localIPs().map((ip) => `http://${ip}:${port}`),
    tlsUrls: (tlsServer && tlsPort) ? localIPs().map((ip) => `https://${ip}:${tlsPort}`) : [],
    qr: qrStaff || null,
    qrStaff: qrStaff || null,
    qrGuest: qrGuest || null,
    qrCert: qrCert || null,
    staffCode
  };
}

/* ---------- PWA用 証明書(CA+サーバー証明書を1度だけ生成して使い回す) ---------- *
 * スマホのChromeがPWAとしてインストールするには https(セキュアコンテキスト)が必須。
 * 自己署名CAを /ca.crt で配布し、スマホに1回インストールしてもらう運用。 */
function certDir() {
  return app.getPath('userData');
}

function certPaths() {
  return {
    ca: path.join(certDir(), 'remote-ca.pem'),
    cert: path.join(certDir(), 'remote-cert.pem'),
    key: path.join(certDir(), 'remote-key.pem')
  };
}

async function ensureTlsCert() {
  const p = certPaths();
  try {
    const cert = await fsp.readFile(p.cert, 'utf8');
    const key = await fsp.readFile(p.key, 'utf8');
    caPem = await fsp.readFile(p.ca, 'utf8');
    return { cert, key };
  } catch {}

  // 未生成なら作る(RSA鍵2本なので数秒かかる。以後はキャッシュ)
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = '01';
  ca.validity.notBefore = new Date();
  ca.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const caName = [{ name: 'commonName', value: 'MusicRepeat Local CA' }];
  ca.setSubject(caName);
  ca.setIssuer(caName);
  ca.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyCertSign: true, cRLSign: true, critical: true }
  ]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());

  const srvKeys = forge.pki.rsa.generateKeyPair(2048);
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = srvKeys.publicKey;
  leaf.serialNumber = '02';
  leaf.validity.notBefore = new Date();
  leaf.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const host = (os.hostname() || 'musicrepeat-pc').toLowerCase();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: host },
    { type: 7, ip: '127.0.0.1' }
  ];
  for (const ip of localIPs()) altNames.push({ type: 7, ip });
  leaf.setSubject([{ name: 'commonName', value: host }]);
  leaf.setIssuer(caName);
  leaf.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames }
  ]);
  leaf.sign(ca.privateKey, forge.md.sha256.create());

  const cert = forge.pki.certificateToPem(leaf);
  const key = forge.pki.privateKeyToPem(srvKeys.privateKey);
  caPem = forge.pki.certificateToPem(ca);
  await fsp.writeFile(p.cert, cert);
  await fsp.writeFile(p.key, key);
  await fsp.writeFile(p.ca, caPem);
  return { cert, key };
}

/* 起動。希望ポートから順に20ポートまで空きを探す。
 * opts.tls = true のときは https も port+1 側で起動(PWAインストール用)。
 * QRには https 側のURLを入れ、証明書ダウンロード用QR(ca.crt)も返す。 */
function start(portWanted, onCommand, opts = {}) {
  if (server) return Promise.resolve(info());
  staffToken = crypto.randomBytes(16).toString('hex');
  staffCode = String(100000 + Math.floor(Math.random() * 900000));
  tlsRequested = !!opts.tls;
  return new Promise(async (resolve) => {
    let tlsInfo = null;
    if (opts.tls) {
      try {
        tlsInfo = await ensureTlsCert();
      } catch {
        tlsInfo = null;   // 証明書生成に失敗したら http のみで続行
      }
    }
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

        // https(PWA用)も同じUI・WSを提供する
        tlsPort = 0;
        tlsServer = null;
        if (tlsInfo) {
          tlsServer = await new Promise((res2) => {
            const t = https.createServer({ key: tlsInfo.key, cert: tlsInfo.cert }, serveFile);
            const tw = new WebSocketServer({ server: t, path: '/ws' });
            t.once('error', () => res2(null));
            t.listen(p + 1, '0.0.0.0', () => {
              wss = tw;   // https側を優先(スマホからのWSはhttps側が多い)
              res2(t);
            });
          }).catch(() => null);
          if (tlsServer) tlsPort = p + 1;
        }

        // QRは「PWAとして使える https」を優先、なければ http
        const base = tlsPort
          ? `https://${localIPs()[0]}:${tlsPort}`
          : `http://${localIPs()[0]}:${port}`;
        let qrStaff = null, qrGuest = null, qrCert = null;
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
        if (tlsPort) {
          try {
            qrCert = await QRCode.toDataURL(`http://${localIPs()[0]}:${port}/ca.crt`, {
              width: 340, margin: 1,
              color: { dark: '#14100e', light: '#f3e9dc' }
            });
          } catch {}
        }
        resolve(info(qrStaff, qrGuest, qrCert));
      });
    };
    tryPort(portWanted || 8080);
  });
}

function stop() {
  return new Promise((resolve) => {
    lastState = null;
    lastTracks = null;
    const jobs = [];
    if (server) { const s = server; server = null; jobs.push(() => s.close(() => {})); }
    if (tlsServer) { const t = tlsServer; tlsServer = null; tlsPort = 0; jobs.push(() => t.close(() => {})); }
    if (wss) {
      try { for (const c of wss.clients) c.close(); } catch {}
      wss = null;
    }
    port = 0;
    if (jobs.length === 0) { resolve(false); return; }
    for (const j of jobs) {
      try { j(); } catch {}
    }
    // 念のため少し待ってから完了とする(srv.closeのコールバックは必ずしも発火しない)
    setTimeout(() => resolve(true), 150);
  });
}

function sendState(s) { broadcast(Object.assign({ type: 'state' }, s)); }
function sendTracks(t) { broadcast(Object.assign({ type: 'tracks' }, t)); }

module.exports = { start, stop, sendState, sendTracks };
