/* MusicRepeat サイネージ ロジック: スライドショー+時計+IPCデータ */
const $ = (id) => document.getElementById(id);

let slides = [];
let cur = 0;
let timer = null;
let data = {};
let lastSig = '';

/* 店名・メッセージ・QRなど表示に関わる部分の指紋(変わった時だけ再適用) */
function dataSig(d) {
  return JSON.stringify([d.storeName, d.storeMsg, d.wifiSsid, d.wifiPass, d.wifiQr, d.snsQr, d.snsUrl]);
}

function applyData(d) {
  if (!d) return;
  data = d;
  $('store-name').textContent = d.storeName || 'MUSIC CAFE';
  $('today-msg').textContent = d.storeMsg || 'ようこそお越しくださいました';
  if (d.wifiSsid) $('wifi-ssid').textContent = 'SSID: ' + d.wifiSsid;
  if (d.wifiPass) $('wifi-pass').textContent = 'password: ' + d.wifiPass;
  if (d.wifiQr) $('wifi-qr').src = d.wifiQr;
  if (d.snsQr) $('sns-qr').src = d.snsQr;
  if (d.snsUrl) $('sns-url').textContent = d.snsUrl;

  // 表示項目の有無でスライドを取捨選択
  const prevCount = slides.length;
  slides = [
    document.querySelector('.s-brand'),
    document.querySelector('.s-msg'),
    d.wifiSsid || d.wifiQr ? document.querySelector('.s-wifi') : null,
    d.snsQr || d.snsUrl ? document.querySelector('.s-sns') : null
  ].filter(Boolean);

  // 表示中のスライドはできるだけ維持(最初に戻さない)
  const keep = prevCount ? Math.min(cur, slides.length - 1) : 0;
  const dots = $('dots');
  dots.innerHTML = '';
  slides.forEach(() => dots.appendChild(document.createElement('i')));
  show(keep);
  clearInterval(timer);
  timer = setInterval(() => show((cur + 1) % slides.length), 8000);
}

function show(i) {
  cur = i;
  slides.forEach((s, k) => s.classList.toggle('on', k === i));
  [...$('dots').children].forEach((d, k) => d.classList.toggle('on', k === i));
}

/* 時計更新(1秒) */
setInterval(() => {
  const d = new Date();
  $('clock').textContent =
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}, 1000);

/* IPC: PC側からのデータ更新(店名・メッセージ・QR・再生中の曲) */
window.api.onSignageData((msg) => {
  if (!msg) return;
  if (msg.nowTitle !== undefined) $('now-title').textContent = msg.nowTitle || '—';
  const sig = dataSig(msg);
  if (sig === lastSig) return;      // 表示内容が変わっていない再送は無視(チラつき防止)
  lastSig = sig;
  applyData(msg);
});

$('exit').addEventListener('click', () => window.api.signageClose());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.signageClose();
});
