/* MusicRepeat スマホリモコン ロジック */
const $ = (id) => document.getElementById(id);

let ws = null;
let state = null;
let tracks = [];
let selectedTrack = -1;
let volDragging = false;
let volTimer = null;

/* ---------- 役割(店員 / お客さん)とページ分け ----------
 * 「/」= お客さん用ページ、「/staff」= 店員用ページ。
 * 店員になるには 店員QRに埋め込まれたトークン か
 * PC画面に表示される6桁の店員コード による認証が必要。 */
const isStaffPage = location.pathname.replace(/\/+$/, '').endsWith('/staff');
let role = 'guest';
let staffToken = new URLSearchParams(location.search).get('t') || localStorage.getItem('mr-staff-token') || '';

function applyRole() {
  document.body.classList.toggle('guest', role !== 'staff');
  document.body.classList.toggle('staff', role === 'staff');
  const h = document.querySelector('header span:nth-child(2)');
  if (h) h.textContent = role === 'staff' ? 'MusicRepeat リモコン(店員)' : 'MusicRepeat リクエスト';
}

/* 店員ページでトークンが無い/古い → 6桁コード認証を促す */
function showAuth() { document.body.classList.add('authing'); }
function hideAuth() { document.body.classList.remove('authing'); }

let toastTimer = null;
function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2200);
}

function send(o) {
  try { ws.send(JSON.stringify(Object.assign({ type: 'cmd' }, o))); } catch {}
}

/* ---------- PWA: Service Worker + インストールボタン ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

let deferredPrompt = null;
const instBtn = $('install');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  instBtn.classList.remove('hidden');
});

instBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  try { await deferredPrompt.userChoice; } catch {}
  deferredPrompt = null;
  instBtn.classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
  instBtn.classList.add('hidden');
  deferredPrompt = null;
});

function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const authQ = (isStaffPage && staffToken) ? `?auth=${encodeURIComponent(staffToken)}` : '';
  ws = new WebSocket(proto + location.host + '/ws' + authQ);
  ws.onopen = () => { $('conn').textContent = '接続中'; $('conn').className = 'conn ok'; };
  ws.onclose = () => {
    $('conn').textContent = '切断 — 再接続中…';
    $('conn').className = 'conn ng';
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'state') { state = m; renderState(); }
    else if (m.type === 'tracks') { tracks = m.tracks || []; renderTracks(); }
    else if (m.type === 'authOk') {
      staffToken = m.token;
      try { localStorage.setItem('mr-staff-token', staffToken); } catch {}
      role = 'staff';
      applyRole();
      hideAuth();
      renderState();
      renderTracks();
      toast('🏪 店員として接続しました');
    }
    else if (m.type === 'authFail') {
      staffToken = '';
      try { localStorage.removeItem('mr-staff-token'); } catch {}
      role = 'guest';
      applyRole();
      if (isStaffPage) {
        showAuth();
        toast('店員コードが違うか、有効期限が切れています');
      }
    }
  };
}

/* ---------- 状態の反映 ---------- */
function renderState() {
  if (!state) return;
  $('title').textContent = state.title || '—';
  $('sub').textContent = state.total > 0
    ? `${(state.index >= 0 ? state.index + 1 : 1)}曲目 / ${state.total}曲`
    : 'フォルダーが未選択です';
  $('play').textContent = state.playing ? '⏸' : '▶';
  document.body.classList.toggle('playing', !!state.playing);

  if (!volDragging) $('vol').value = Math.round((state.volume ?? 0.7) * 100);

  for (const b of $('presets').children) {
    b.classList.toggle('on', b.dataset.mode === state.mode);
  }

  if (state.sleepRemainMs) {
    const mm = Math.floor(state.sleepRemainMs / 60000);
    const ss = Math.floor((state.sleepRemainMs % 60000) / 1000);
    $('sleepinfo').textContent = `残り ${mm}:${String(ss).padStart(2, '0')}`;
  } else {
    $('sleepinfo').textContent = '';
  }

  // 現在再生中の行をハイライト
  const items = $('tracks').children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', i === state.index);
  }
}

function renderTracks() {
  const ul = $('tracks');
  ul.innerHTML = '';
  $('count').textContent = `${tracks.length}曲`;
  tracks.forEach((name, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="no">${i + 1}</span>`;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = name;
    li.appendChild(n);
    // 店側で承認待ちのリクエストに印を付ける
    if (state && (state.requests || []).some((r) => r.index === i)) {
      li.classList.add('req');
      const rq = document.createElement('span');
      rq.className = 'req-mark';
      rq.textContent = '🙋';
      li.appendChild(rq);
    }
    li.addEventListener('click', () => {
      if (role === 'guest') {
        // お客さんモード: タップだけでリクエスト確認シートを出す(長押し不要)
        selectedTrack = i;
        openSheet(name);
      } else {
        send({ action: 'track', index: i });
      }
    });
    // 長押し(500ms)→ アクションシート
    let timer = null;
    li.addEventListener('touchstart', () => {
      timer = setTimeout(() => { selectedTrack = i; openSheet(name); }, 500);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach((ev) =>
      li.addEventListener(ev, () => clearTimeout(timer), { passive: true }));
    ul.appendChild(li);
  });
  renderState();
}

/* ---------- 操作 ---------- */
$('play').addEventListener('click', () => send({ action: 'toggle' }));
$('prev').addEventListener('click', () => send({ action: 'prev' }));
$('next').addEventListener('click', () => send({ action: 'next' }));

$('vol').addEventListener('pointerdown', () => { volDragging = true; });
window.addEventListener('pointerup', () => { volDragging = false; });
$('vol').addEventListener('input', () => {
  clearTimeout(volTimer);
  volTimer = setTimeout(() => send({ action: 'volume', value: +$('vol').value / 100 }), 90);
});

$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) send({ action: 'preset', value: b.dataset.mode });
});

document.querySelector('.sleep').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-min]');
  if (b) send({ action: 'sleep', minutes: +b.dataset.min });
});

/* アクションシート */
function openSheet(name) {
  $('sheet-name').textContent = name;
  $('sheet').classList.remove('hidden');
  $('sheet-bg').classList.remove('hidden');
}
function closeSheet() {
  $('sheet').classList.add('hidden');
  $('sheet-bg').classList.add('hidden');
}
$('q-next').addEventListener('click', () => { send({ action: 'queueNext', index: selectedTrack }); closeSheet(); });
$('q-now').addEventListener('click', () => { send({ action: 'track', index: selectedTrack }); closeSheet(); });
$('q-req').addEventListener('click', () => {
  send({ action: 'request', index: selectedTrack });
  closeSheet();
  toast('🙋 リクエストを送りました。店側の確認をお待ちください');
});
$('q-cancel').addEventListener('click', closeSheet);
$('sheet-bg').addEventListener('click', closeSheet);

/* 店員認証(6桁コード) */
function tryAuth() {
  const code = ($('auth-code').value || '').trim();
  if (!code) return;
  try { ws.send(JSON.stringify({ type: 'auth', code })); } catch {}
}
$('auth-go').addEventListener('click', tryAuth);
$('auth-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryAuth(); });

connect();
applyRole();
if (isStaffPage && !staffToken) showAuth();
