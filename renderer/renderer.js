/* ================= MusicRepeat — 再生・音質調整ロジック ================= */

const $ = (id) => document.getElementById(id);

const els = {
  fs: $('btn-fs'), max: $('btn-max'), min: $('btn-min'), close: $('btn-close'),
  folder: $('btn-folder'), list: $('track-list'),
  count: $('track-count'), sideFoot: $('side-foot'),
  nowLabel: $('now-label'),
  title: $('now-title'), sub: $('now-sub'),
  viz: $('viz'),
  progWrap: $('progress-wrap'), progBar: $('progress-bar'),
  tCur: $('time-cur'), tTotal: $('time-total'),
  play: $('btn-play'), icPlay: $('ic-play'), icPause: $('ic-pause'),
  prev: $('btn-prev'), next: $('btn-next'), stop: $('btn-stop'),
  shuffle: $('btn-shuffle'), repeat: $('btn-repeat'), repeatLabel: $('repeat-label'),
  speedChip: $('btn-speed'), speedLabel: $('speed-label'),
  sleepChip: $('btn-sleep'), sleepLabel: $('sleep-label'),
  vol: $('vol'),
  modeRow: $('mode-row'), calm: $('calm'), calmVal: $('calm-val'), calmRow: $('calm-row'),
  agc: $('agc'), modeDesc: $('mode-desc'),
  tabSound: $('tab-sound'), tabAdv: $('tab-adv'),
  panelSound: $('panel-sound'), panelAdv: $('panel-adv'),
  speed: $('speed'), speedVal: $('speed-val'), pitchkeep: $('pitchkeep'),
  eql: $('eql'), eqm: $('eqm'), eqh: $('eqh'),
  eqlVal: $('eql-val'), eqmVal: $('eqm-val'), eqhVal: $('eqh-val'),
  reverb: $('reverb'), reverbVal: $('reverb-val'),
  pan: $('pan'), panVal: $('pan-val'),
  mono: $('mono'), fade: $('fade'),
  agct: $('agct'), agctVal: $('agct-val'),
  help: $('btn-help'), notes: $('btn-notes'),
  addons: $('btn-addons'),
  remote: $('btn-remote'), sortBtn: $('btn-sort'),
  output: $('btn-output'),
  ambSel: $('amb-sel'), amb: $('amb'), ambVal: $('amb-val'),
  ambFileRow: $('amb-file-row'), ambFileBtn: $('amb-file-btn'), ambFileName: $('amb-file-name'),
  schedSw: $('sched-sw'), schedEdit: $('sched-edit'),
  store: $('btn-store'), pomo: $('btn-pomo')
};

/* ---------- 設定の保存 ---------- */
const S = {
  get: (k, d) => { try { const v = localStorage.getItem('mr_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('mr_' + k, JSON.stringify(v)); } catch {} }
};

/* ---------- 状態 ---------- */
let folder = null;
let files = [];
let index = -1;
let playing = false;
let objectUrl = null;
let playToken = 0;          // 停止・曲替えで無効化する(読み込み競合バグの修正)
let loadingToken = 0;       // 現在読み込み中のトークン(0=なし)
let loadingIndex = -1;      // 読み込み中の曲(リストに表示)
let switchingUntil = 0;     // 曲入替直後はエラーを無視する(誤スキップ防止)
let failCount = 0;
let queuedIndex = null;     // 「次に再生」
let currentName = '';       // 現在の曲名(リモコン同期用)
let remoteActive = false;   // リモコンサーバー起動中
let lastRemoteInfo = null;
let fading = false;
let sleepFading = false;
let animFrozen = false;     // 一時停止中はビジュアライザー静止

/* ---------- スマホリモコン同期 ---------- */
function pushRemoteState() {
  if (!remoteActive) return;
  try {
    window.api.sendRemoteState({
      playing,
      index,
      total: files.length,
      title: currentName || els.title.textContent,
      volume: vol / 100,
      mode,
      repeatMode,
      shuffleOn,
      speed,
      sleepRemainMs: typeof sleepRemainMs === 'number' ? sleepRemainMs : null,
      requests: pendingRequests.map((r) => ({ index: r.index, name: r.name }))
    });
  } catch {}
}

function pushRemoteTracks() {
  if (!remoteActive) return;
  try {
    window.api.sendRemoteTracks({
      folder,
      tracks: files.map((f) => f.name)
    });
  } catch {}
}

/* ---------- オーディオ ---------- */
const audio = new Audio();

let ctx = null;
let eqLow, eqMid, eqHigh, hp, lp, comp, preOut, dry, wet, convolver, agc, monoNode, panner, fadeGain, master;
let ambGain = null, ambFilter = null, ambNode = null, ambElSrc = null;
const ambAudio = new Audio();
ambAudio.loop = true;
let analyserPre = null, analyserOut = null;

/* パラメータ(保存値) */
let mode = S.get('mode', 'cafe');
let calm = S.get('calm', 40);
let custom = S.get('custom', { hp: 90, lp: 12000, amt: 40 });
let eq = S.get('eq', { l: 0, m: 0, h: 0 });
let reverbAmt = S.get('reverb', 0);
let panAmt = S.get('pan', 0);
let monoOn = S.get('mono', false);
let fadeOn = S.get('fade', false);
let agcTarget = S.get('agct', 100);
let ambientKind = S.get('ambient', 'none');   // none | rain | fire | murmur | file
let ambientBlend = S.get('amb', 30);
let ambFile = S.get('ambFile', null);
let scheduleOn = S.get('scheduleOn', false);
let speed = S.get('speed', 1);
let pitchKeep = S.get('pitchkeep', true);
let shuffleOn = S.get('shuffle', false);
let repeatMode = S.get('repeat', 'all');   // all | one | none
let sortBy = S.get('sort', 'name');        // name | mtime
let vol = S.get('vol', 70);

function ensureGraph() {
  if (ctx) return;
  ctx = new AudioContext();

  const src = ctx.createMediaElementSource(audio);
  eqLow = ctx.createBiquadFilter();  eqLow.type = 'lowshelf';  eqLow.frequency.value = 200;
  eqMid = ctx.createBiquadFilter();  eqMid.type = 'peaking';   eqMid.frequency.value = 1000; eqMid.Q.value = 1;
  eqHigh = ctx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4000;
  hp = ctx.createBiquadFilter();  hp.type = 'highpass'; hp.Q.value = 0.7;
  lp = ctx.createBiquadFilter();  lp.type = 'lowpass';  lp.Q.value = 0.7;
  comp = ctx.createDynamicsCompressor();
  preOut = ctx.createGain();

  dry = ctx.createGain();
  convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(2.4, 2.8);
  wet = ctx.createGain();

  agc = ctx.createGain();
  monoNode = ctx.createGain();
  panner = ctx.createStereoPanner();
  fadeGain = ctx.createGain();
  master = ctx.createGain();

  analyserPre = ctx.createAnalyser(); analyserPre.fftSize = 2048;
  analyserOut = ctx.createAnalyser(); analyserOut.fftSize = 512;

  src.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
  eqHigh.connect(hp); hp.connect(lp); lp.connect(comp);
  comp.connect(analyserPre);       // AGC 測定用タップ
  comp.connect(preOut);
  preOut.connect(dry); dry.connect(agc);
  preOut.connect(convolver); convolver.connect(wet); wet.connect(agc);
  agc.connect(monoNode); monoNode.connect(panner);
  panner.connect(fadeGain); fadeGain.connect(master);
  master.connect(analyserOut); analyserOut.connect(ctx.destination);

  // 環境音ミキサー(BGMのAGCを通さず、マスターボリュームにだけ合流)
  ambGain = ctx.createGain();
  ambFilter = ctx.createBiquadFilter();
  ambFilter.connect(ambGain);
  ambGain.connect(master);
  ambGain.gain.value = (ambientBlend / 100) * 0.5;

  applyAllAudio();
  applyAmbient();
  applySink();
}

function makeImpulse(seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/* ---------- サウンドパラメータ適用 ---------- */
function compParams(amt) {
  // amt 0..100 → 圧縮の強さ
  if (amt <= 0) return { threshold: 0, ratio: 1, knee: 0, attack: 0.01, release: 0.25 };
  return {
    threshold: -6 - (amt / 100) * 36,
    ratio: 1 + (amt / 100) * 5,
    knee: 22, attack: 0.01, release: 0.25
  };
}

function currentParams() {
  if (mode === 'custom') {
    return { hp: custom.hp, lp: custom.lp, ...compParams(custom.amt) };
  }
  const p = PRESETS[mode] || PRESETS.cafe;
  const c = calm / 100;
  return {
    hp: Math.min(p.hp * (1 + c * 1.4), 400),
    lp: Math.min(p.lp / (1 + c * 0.9), 22050),
    threshold: p.comp ? p.comp.threshold - c * 4 : 0,
    ratio: p.comp ? p.comp.ratio : 1,
    knee: p.comp ? p.comp.knee : 0,
    attack: p.comp ? p.comp.attack : 0.01,
    release: p.comp ? p.comp.release : 0.25
  };
}

const PRESETS = {
  off:   { hp: 20, lp: 20000, comp: null, desc: 'フィルターなし・原音のまま再生します' },
  cafe:  { hp: 90, lp: 12000, comp: { threshold: -24, knee: 22, ratio: 4, attack: 0.01, release: 0.25 },
           desc: '低音と高音をやわらかく丸め、音量のばらつきを抑えた店内BGM風の音です' },
  relax: { hp: 70, lp: 8000,  comp: { threshold: -28, knee: 24, ratio: 3, attack: 0.02, release: 0.35 },
           desc: 'こもった優しい音質。夜や読書時に最適です' },
  clear: { hp: 20, lp: 20000, comp: { threshold: -14, knee: 20, ratio: 2, attack: 0.005, release: 0.2 },
           desc: '音質は変えず、聴き取りやすく音量だけ整えます' }
};

function applyAudioParams() {
  if (!ctx) return;
  const t = ctx.currentTime, tc = 0.25;
  const p = currentParams();
  hp.frequency.setTargetAtTime(p.hp, t, tc);
  lp.frequency.setTargetAtTime(p.lp, t, tc);
  comp.threshold.setTargetAtTime(p.threshold, t, tc);
  comp.ratio.setTargetAtTime(p.ratio, t, tc);
  comp.knee.setTargetAtTime(p.knee, t, tc);
  comp.attack.setTargetAtTime(p.attack, t, tc);
  comp.release.setTargetAtTime(p.release, t, tc);

  eqLow.gain.setTargetAtTime(eq.l, t, tc);
  eqMid.gain.setTargetAtTime(eq.m, t, tc);
  eqHigh.gain.setTargetAtTime(eq.h, t, tc);
  wet.gain.setTargetAtTime((reverbAmt / 100) * 0.35, t, tc);
  panner.pan.setTargetAtTime(panAmt / 100, t, tc);
  monoNode.channelCountMode = monoOn ? 'explicit' : 'max';
  monoNode.channelCount = 1;

  const desc = mode === 'custom'
    ? `カスタム: 低音 ${Math.round(custom.hp)}Hz 以下をカット / 高音 ${(custom.lp / 1000).toFixed(1)}kHz 以上を丸め圧縮 ${Math.round(custom.amt)}%`
    : (PRESETS[mode] || PRESETS.cafe).desc;
  els.modeDesc.textContent = desc;
  els.calmRow.classList.toggle('dimmed', mode === 'custom');
  S.set('mode', mode); S.set('calm', calm); S.set('custom', custom);
  pushRemoteState();
}

/* 起動時・初期化後にまとめて適用 */
function applyAllAudio() {
  applyAudioParams();
  master.gain.value = vol / 100;
  fadeGain.gain.value = 1;
  wet.gain.value = (reverbAmt / 100) * 0.35;
  panner.pan.value = panAmt / 100;
  agc.gain.value = 1;
  setSpeed(speed);
}

/* ---------- 環境音ミキサー ---------- */
function makeNoise(kind, seconds = 4) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let brown = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      let v;
      if (kind === 'rain') {
        // Paul Kellet のピンクノイズ近似(しっとりした雨音の素)
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        // ブラウンノイズ(低く包む響き: 焚き火・ざわめきの素)
        brown = (brown + 0.02 * w) / 1.02;
        v = brown * 3.5;
      }
      if (kind === 'fire' && Math.random() < 0.0003) {
        v += (Math.random() * 2 - 1) * 8;   // パチパチという小さな爆ぜ音
      }
      d[i] = Math.max(-1, Math.min(1, v));
    }
  }
  return buf;
}

function stopAmbient() {
  if (ambNode) { try { ambNode.stop(); } catch {} ambNode = null; }
  if (ambAudio.src) { try { ambAudio.pause(); } catch {} }
}

function applyAmbient() {
  stopAmbient();
  els.ambFileRow.classList.toggle('hidden', ambientKind !== 'file');
  if (!ctx) return;

  if (ambientKind === 'none') return;

  if (ambientKind === 'file') {
    ambFilter.type = 'allpass';
    ambFilter.frequency.value = 8000;
    ambFilter.Q.value = 1;
    if (!ambElSrc) {
      ambElSrc = ctx.createMediaElementSource(ambAudio);
      ambElSrc.connect(ambFilter);
    }
    if (ambFile && !ambAudio.src) {
      window.api.readAudio(ambFile).then((buf) => {
        if (ambientKind !== 'file') return;
        ambAudio.src = URL.createObjectURL(new Blob([buf]));
        ambAudio.play().catch(() => {});
      }).catch(() => {});
    } else if (ambAudio.src) {
      ambAudio.play().catch(() => {});
    }
    return;
  }

  // アドオン提供の環境音(addon://<id>/<ファイル> をそのまま鳴らす)
  if (ambientKind.startsWith('addon://')) {
    ambFilter.type = 'allpass';
    ambFilter.frequency.value = 8000;
    ambFilter.Q.value = 1;
    if (!ambElSrc) {
      ambElSrc = ctx.createMediaElementSource(ambAudio);
      ambElSrc.connect(ambFilter);
    }
    if (ambAudio.getAttribute('src') !== ambientKind) ambAudio.src = ambientKind;
    ambAudio.play().catch(() => {});
    return;
  }

  ambAudio.pause();
  const buf = makeNoise(ambientKind === 'rain' ? 'rain' : ambientKind === 'fire' ? 'fire' : 'brown');
  ambNode = ctx.createBufferSource();
  ambNode.buffer = buf;
  ambNode.loop = true;
  if (ambientKind === 'rain') {
    ambFilter.type = 'lowpass'; ambFilter.frequency.value = 1400; ambFilter.Q.value = 0.7;
  } else if (ambientKind === 'fire') {
    ambFilter.type = 'lowpass'; ambFilter.frequency.value = 480; ambFilter.Q.value = 0.7;
  } else {
    // カフェのざわめき風: 中域を強調したブラウンノイズ
    ambFilter.type = 'bandpass'; ambFilter.frequency.value = 500; ambFilter.Q.value = 0.4;
  }
  ambNode.connect(ambFilter);
  ambNode.start();
}

function setAmbientBlend(v) {
  ambientBlend = v;
  els.ambVal.textContent = v;
  S.set('amb', v);
  if (ctx) ambGain.gain.setTargetAtTime((v / 100) * 0.5, ctx.currentTime, 0.3);
}

/* ---------- 出力デバイス / Bluetooth連携 ---------- */
let outDevices = [];
let currentSinkId = S.get('sinkId', 'default');
let autoPauseOnDisconnect = S.get('autoPause', true);
let autoPlayOnRegister = S.get('autoPlayBT', false);
let registeredLabel = S.get('btRegisterLabel', '');
let remoteOverlayOutput = null;

async function ensureMediaLabels() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {}
}

async function refreshOutputs() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    outDevices = all.filter((d) => d.kind === 'audiooutput');
  } catch {}
}

async function applySink() {
  const id = currentSinkId === 'default' ? '' : currentSinkId;
  try { await audio.setSinkId(id); } catch {}
  try { if (ctx && ctx.setSinkId) await ctx.setSinkId(id); } catch {}
}

function fadeOutAndPause(reason) {
  if (playing && ctx && !sleepFading) {
    sleepFading = true;
    const t = ctx.currentTime;
    fadeGain.gain.cancelScheduledValues(t);
    fadeGain.gain.setValueAtTime(fadeGain.gain.value, t);
    fadeGain.gain.linearRampToValueAtTime(0.0001, t + 1.5);
    setTimeout(() => {
      sleepFading = false;
      stopAll();
      if (reason) toast(reason);
    }, 1600);
  }
}

async function onDeviceChange() {
  const prev = outDevices;
  await refreshOutputs();
  if (remoteOverlayOutput && remoteOverlayOutput.classList.contains('open')) renderOutputList();

  // 現在の出力先が消えた → フェードして一時停止(PCスピーカーへの勝手な切替を防ぐ)
  if (currentSinkId !== 'default' && !outDevices.find((d) => d.deviceId === currentSinkId)) {
    currentSinkId = 'default';
    S.set('sinkId', 'default');
    applySink();
    if (autoPauseOnDisconnect) {
      fadeOutAndPause('出力デバイスが切断されたため、フェードアウトして一時停止しました');
    }
    return;
  }

  // 登録デバイスが接続された → 自動再生
  if (registeredLabel && autoPlayOnRegister) {
    const wasThere = prev.find((d) => d.label === registeredLabel);
    const nowThere = outDevices.find((d) => d.label === registeredLabel);
    if (!wasThere && nowThere) {
      await switchOutput(nowThere.deviceId);
      if (!playing) {
        if (audio.src || useBufferMode) togglePlay();
        else playIndex(index < 0 ? 0 : index);
      }
      toast(`「${registeredLabel}」が接続されたので再生します`);
    }
  }
}

async function switchOutput(deviceId) {
  currentSinkId = deviceId || 'default';
  S.set('sinkId', currentSinkId);
  await applySink();
}

/* ---------- 自動音量(AGC) ---------- */
const timeData = new Float32Array(2048);
setInterval(() => {
  if (!ctx || !analyserPre || !playing || !els.agc.checked) return;
  analyserPre.getFloatTimeDomainData(timeData);
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
  const rms = Math.sqrt(sum / timeData.length);
  if (rms < 0.0008) return;
  const target = (0.11 * agcTarget / 100) / rms;
  agc.gain.setTargetAtTime(Math.min(Math.max(target, 0.55), 3.2), ctx.currentTime, 0.6);
}, 250);

/* ---------- UI更新ヘルパ ---------- */
function refreshPlayUI() {
  els.icPlay.classList.toggle('hidden', playing);
  els.icPause.classList.toggle('hidden', !playing);
  pushRemoteState();
}

function refreshChips() {
  els.shuffle.classList.toggle('on', shuffleOn);
  els.repeat.classList.toggle('on', repeatMode !== 'none');
  els.repeatLabel.textContent = repeatMode === 'one' ? '1曲' : repeatMode === 'all' ? '全曲' : 'オフ';
  els.sleepChip.classList.toggle('on', !!sleepRemainMs);
  pushRemoteState();
}

function resetTimeUI() {
  els.progBar.style.width = '0%';
  els.tCur.textContent = '0:00';
  els.tTotal.textContent = '0:00';
}

function toast(msg) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = msg;
  $('toast-wrap').appendChild(d);
  setTimeout(() => d.classList.add('out'), 2200);
  setTimeout(() => d.remove(), 2600);
}

/* ---------- プレイリスト ---------- */
function renderList() {
  els.list.innerHTML = '';
  if (!files.length) {
    els.list.innerHTML = '<div class="empty-hint"><p>フォルダーを選ぶと、</p><p>中の音楽がずっと流れ続けます ☕</p><p class="hint2">フォルダーを窓にドラッグしてもOK</p></div>';
    els.sideFoot.classList.add('hidden');
    return;
  }
  files.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'track-item' + (i === index ? ' active' : '') + (i === loadingIndex ? ' loading' : '');
    div.innerHTML = '<span class="eq-ic"><i></i><i></i><i></i></span>';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'track-name';
    nameSpan.textContent = f.name;
    nameSpan.title = f.path;
    div.appendChild(nameSpan);
    div.addEventListener('click', () => playIndex(i));
    // 右クリック / 長押し → コンテキストメニュー
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(i, e.clientX, e.clientY); });
    longPress(div, (e) => trackMenu(i, e.clientX, e.clientY));
    els.list.appendChild(div);
  });
  els.sideFoot.classList.remove('hidden');
  els.count.textContent = `${files.length}曲`;
  const active = els.list.children[index];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

/* ---------- フォルダー読み込み ---------- */
async function loadFolder(dir, autoplay) {
  const res = await window.api.scanFolder(dir, sortBy);
  folder = res.dir;
  files = res.files;
  bufCache.clear();
  transCache.clear();
  S.set('folder', dir);
  pushRemoteTracks();
  pushRemoteState();
  if (!files.length) {
    stopAll();
    els.title.textContent = '音楽ファイルが見つかりません';
    els.sub.textContent = 'mp3 / wav / ogg / flac / m4a などが対象です';
    renderList();
    return;
  }
  renderList();
  if (autoplay) playIndex(0);
}

els.folder.addEventListener('click', async () => {
  const dir = await window.api.pickFolder();
  if (!dir) return;
  stopAll();
  await loadFolder(dir, true);
});

/* ドラッグ&ドロップ */
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  const p = window.api.pathForFile(f);
  if (!p) return;
  stopAll();
  await loadFolder(p, true);
});

/* ---------- 音声バッファキャッシュ(曲替えを速く) ---------- */
const bufCache = new Map();
const transCache = new Map();   // 変換済み(ffmpeg)バッファのキャッシュ
async function getBuffer(path) {
  if (bufCache.has(path)) {
    const b = bufCache.get(path);
    bufCache.delete(path); bufCache.set(path, b); // LRU
    return b;
  }
  const buf = await window.api.readAudio(path);
  bufCache.set(path, buf);
  if (bufCache.size > 4) bufCache.delete(bufCache.keys().next().value);
  return buf;
}

/* ---------- 再生制御 ---------- */
const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.opus': 'audio/ogg', '.webm': 'audio/webm'
};

/* エラーを詳しく表示(原因の切り分け用) */
function describeErr(err, withAudio = true) {
  const codeNames = { 1: '読み込み中断', 2: 'ネットワークエラー', 3: 'デコードエラー', 4: '未対応の形式' };
  let s = err && err.message ? `${err.name || 'Error'}: ${err.message}` : String(err);
  try {
    if (withAudio && audio.error) s += ` [${codeNames[audio.error.code] || 'code ' + audio.error.code}${audio.error.message ? ' ' + audio.error.message : ''}]`;
  } catch {}
  return s;
}

/* ファイルの中身(ヘッダー)から実際の形式を判定 */
function sniffFormat(ab) {
  try {
    const b = new Uint8Array(ab, 0, Math.min(16, ab.byteLength));
    const s = (o, n) => String.fromCharCode(...b.slice(o, o + n));
    if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75) return 'WMA(ASF)';
    if (s(0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) return 'MP3';
    if (s(4, 4) === 'ftyp') return 'MP4/M4A(' + s(8, 4).trim() + ')';
    if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'WAV';
    if (s(0, 4) === 'fLaC') return 'FLAC';
    if (s(0, 4) === 'OggS') return 'Ogg';
    if (s(0, 4) === 'FORM') return 'AIFF';
    if (s(0, 4) === 'wvpk') return 'WavPack';
    if (s(0, 3) === 'MAC') return "Monkey's Audio";
    if (s(0, 4) === 'FSF9') return '不明';
    return '不明な形式';
  } catch { return '不明な形式'; }
}

/* ---------- 代替再生(デコードして直接鳴らすフォールバック) ---------- */
let bufSrc = null;
let lastAudioBuf = null;
let bufStartAt = 0, bufOffset = 0, bufDuration = 0, useBufferMode = false;

function stopBufSrc() {
  if (bufSrc) {
    try { bufSrc.onended = null; bufSrc.stop(); } catch {}
    bufSrc = null;
  }
}

function makeBufSource(offset) {
  const s = ctx.createBufferSource();
  s.buffer = lastAudioBuf;
  s.playbackRate.value = speed;
  s.connect(eqLow);
  s.onended = () => { bufSrc = null; if (playing && tokenForBuf === playToken) handleEnded(); };
  bufStartAt = ctx.currentTime;
  bufOffset = offset;
  s.start(0, offset);
  return s;
}
let tokenForBuf = 0;

async function playViaBuffer(ab, token, offset = 0) {
  lastAudioBuf = await ctx.decodeAudioData(ab.slice(0));  // 未対応でなければ必ずデコードできる
  if (token !== playToken) return;
  bufDuration = lastAudioBuf.duration;
  stopBufSrc();
  tokenForBuf = token;
  bufSrc = makeBufSource(offset);
  useBufferMode = true;
}

function resumeBuffer() {
  if (!lastAudioBuf) return;
  tokenForBuf = playToken;
  bufSrc = makeBufSource(bufOffset);
}

function bufElapsed() {
  if (!ctx) return 0;
  return Math.min(bufDuration, bufOffset + (ctx.currentTime - bufStartAt) * speed);
}

function showPlayError(f, detail) {
  loadingToken = 0;
  loadingIndex = -1;
  renderList();
  const ext = (f.name.match(/\.[^.]+$/) || [''])[0];
  els.sub.textContent = `再生できませんでした: ${f.name} — ${detail}`;
  toast(`⚠ ${f.name} を再生できません (${ext}) — ${detail}`);
  console.error('MusicRepeat play error:', f.name, detail);
}

function scheduleSkip(token) {
  failCount++;
  if (failCount >= files.length) {
    stopAll();
    els.title.textContent = '再生できるファイルがありません';
    els.sub.textContent = 'mp3 / wav / flac / m4a に変換するか、別のフォルダーをお試しください';
    return;
  }
  setTimeout(() => { if (token === playToken) playIndex(index + 1); }, 800);
}

async function playIndex(i, isQueue = false) {
  if (!files.length) return;
  if (isQueue && queuedIndex !== null) { i = queuedIndex; queuedIndex = null; }
  index = ((i % files.length) + files.length) % files.length;
  const token = ++playToken;
  loadingToken = token;        // 読み込み中フラグ(終了処理が割り込むのを防ぐ)
  loadingIndex = index;
  renderList();
  const f = files[index];
  const baseName = f.name.replace(/\.[^.]+$/, '');

  useBufferMode = false;
  stopBufSrc();

  ensureGraph();
  try { await ctx.resume(); } catch {}
  if (ctx && ctx.state !== 'running') toast('オーディオ出力を開始できませんでした');
  if (token !== playToken) return;

  els.title.textContent = '読み込み中… ' + baseName;
  animFrozen = false;

  /* 読み込み(失敗したら1回だけ再試行) */
  let buf = null;
  try {
    buf = await getBuffer(f.path);
  } catch {
    try {
      await new Promise(r => setTimeout(r, 1500));
      if (token !== playToken) return;
      buf = await getBuffer(f.path);
    } catch {}
  }
  if (token !== playToken) return;

  if (buf && buf.byteLength === 0) buf = null;   // 空ファイル(読み込み失敗)扱い
  if (!buf) {
    showPlayError(f, 'ファイルを読み込めませんでした(ネットワーク・アクセス権を確認)');
    scheduleSkip(token);
    return;
  }

  const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();

  /* <audio> 要素で鳴らす共通ルーチン(変換後のmp3の再生にも使う) */
  const startViaElement = async (ab, ext2) => {
    // 前の曲のURLはすぐ解放せず少し待つ(解放競合でエラー→誤スキップするのを防止)
    if (objectUrl) {
      const old = objectUrl;
      setTimeout(() => URL.revokeObjectURL(old), 15000);
    }
    switchingUntil = Date.now() + 2000;
    objectUrl = URL.createObjectURL(new Blob([ab], { type: MIME[ext2] || 'audio/mpeg' }));
    audio.src = objectUrl;
    setSpeed(speed);
    // 曲頭は音量補正をリセットして AGC に任せる
    agc.gain.cancelScheduledValues(ctx.currentTime);
    agc.gain.setValueAtTime(1, ctx.currentTime);
    fading = false;
    if (!sleepFading) {
      fadeGain.gain.cancelScheduledValues(ctx.currentTime);
      fadeGain.gain.setValueAtTime(1, ctx.currentTime);
    }
    await audio.play();
    if (token !== playToken) { audio.pause(); return false; }
    onTrackStarted(f);
    return true;
  };

  try {
    await startViaElement(buf, ext);
  } catch (err) {
    if (token !== playToken) return;
    // ★ 通常再生が失敗したら、デコードして直接鳴らす代替再生を試す
    //    ただし長時間トラック(概ね60MB超)はデコードにGB級のメモリが必要なので
    //    最初から変換(<audio>再生)へ進む
    if (buf.byteLength <= 60 * 1024 * 1024) {
      try {
        await playViaBuffer(buf, token, 0);
        if (token !== playToken) return;
        onTrackStarted(f);
        toast('通常再生できなかったため、代替エンジンで再生しています');
        return;
      } catch (fbErr) {
        if (token !== playToken) return;
      }
    }
    // ★★ それでもダメなら FFmpeg で mp3 に変換して <audio> で再生
    //    (変換後は decodeAudioData を使わない — 長時間曲のメモリ不足を防ぐ)
    els.title.textContent = '変換中… ' + baseName;
    toast('このファイルは直接再生できないため、変換して再生します(長い曲ほど時間がかかります)');
    try {
      let tb = transCache.get(f.path);
      if (!tb) {
        const res = await window.api.transcode(f.path);
        if (token !== playToken) return;
        if (!res || !res.data) {
          throw new Error('変換に失敗しました' + (res && res.error ? ` — ${res.error}` : ''));
        }
        tb = res.data;
        transCache.set(f.path, tb);
        if (transCache.size > 2) transCache.delete(transCache.keys().next().value);
      }
      els.title.textContent = '変換完了 — 再生します';
      try {
        await startViaElement(tb, '.mp3');
        if (token !== playToken) return;
        toast('変換して再生しました ✓');
        return;
      } catch {
        if (token !== playToken) return;
        // 最終手段だけデコード再生(短い曲しか来ない)
        await playViaBuffer(tb, token, 0);
        if (token !== playToken) return;
        onTrackStarted(f);
        toast('変換して再生しました ✓');
        return;
      }
    } catch (tErr) {
      if (token !== playToken) return;
      showPlayError(f, describeErr(tErr, false) + ' / 中身の形式: ' + sniffFormat(buf));
      scheduleSkip(token);
    }
  }
}

function onTrackStarted(f) {
  playing = true;
  failCount = 0;               // 成功したら連続失敗カウントをリセット
  loadingToken = 0;
  loadingIndex = -1;
  currentName = f.name.replace(/\.[^.]+$/, '');
  refreshPlayUI();
  pushSignageNow();
  els.title.textContent = f.name.replace(/\.[^.]+$/, '');
  els.sub.textContent = `${index + 1}曲目 / ${files.length}曲 ・ ${folder}`;
  renderList();
  applyAudioParams();

  // 次の曲を先読み(曲替えを瞬時に)
  const nextPath = files[(index + 1) % files.length].path;
  getBuffer(nextPath).catch(() => {});
}

function nextTrack() {
  if (!files.length) return;
  if (queuedIndex !== null) { playIndex(0, true); return; }
  if (shuffleOn && files.length > 1) {
    let n;
    do { n = Math.floor(Math.random() * files.length); } while (n === index);
    playIndex(n);
  } else {
    playIndex(index + 1); // 末尾でループ → 止めるまで流れ続ける
  }
}

function handleEnded() {
  // 手動で選んだ曲を読み込み中なら、終了処理(次の曲へ)を割り込ませない
  if (loadingToken !== 0 && loadingToken === playToken) return;
  if (repeatMode === 'one') { playIndex(index); return; }
  if (!playing) return;
  if (repeatMode === 'none' && !shuffleOn && index === files.length - 1) {
    stopAll();
    return;
  }
  nextTrack();
}

audio.addEventListener('ended', handleEnded);

audio.addEventListener('loadedmetadata', () => { switchingUntil = 0; });

audio.addEventListener('error', () => {
  if (!audio.src || !audio.src.startsWith('blob:')) return;
  if (Date.now() < switchingUntil) return;   // 曲入替直後のエラーは誤検知なので無視
  if (playing && files.length) { failCount++; if (failCount < files.length) playIndex(index + 1); }
});

function togglePlay() {
  if (!files.length) { els.folder.click(); return; }
  ensureGraph();
  if (playing) {
    if (useBufferMode) { bufOffset = bufElapsed(); stopBufSrc(); }
    else audio.pause();
    playing = false;
    animFrozen = true;
    refreshPlayUI();
  } else if (useBufferMode && lastAudioBuf) {
    resumeBuffer();
    playing = true;
    animFrozen = false;
    refreshPlayUI();
  } else if (audio.src) {
    try { ctx.resume(); } catch {}
    audio.play();
    playing = true;
    animFrozen = false;
    refreshPlayUI();
  } else {
    playIndex(index < 0 ? 0 : index);
  }
}

function stopAll() {
  playToken++;               // ★ 読み込み中の再生を必ず無効化
  loadingToken = 0;
  loadingIndex = -1;
  currentName = '';
  useBufferMode = false;
  bufOffset = 0;
  stopBufSrc();
  audio.pause();
  playing = false;
  animFrozen = true;
  fading = false;
  sleepFading = false;
  try {
    audio.currentTime = 0;
  } catch {}
  refreshPlayUI();
  resetTimeUI();
  renderList();
  if (ctx && fadeGain) {
    fadeGain.gain.cancelScheduledValues(ctx.currentTime);
    fadeGain.gain.setValueAtTime(1, ctx.currentTime);
  }
}

els.play.addEventListener('click', togglePlay);
els.next.addEventListener('click', () => { playToken++; nextTrack(); });
els.prev.addEventListener('click', () => {
  const cur = useBufferMode ? bufElapsed() : audio.currentTime;
  if (cur > 3) {
    if (useBufferMode) {
      if (playing) { stopBufSrc(); bufOffset = 0; resumeBuffer(); } else { bufOffset = 0; }
    } else {
      audio.currentTime = 0;
    }
    return;
  }
  playIndex(index - 1);
});
els.stop.addEventListener('click', () => {
  stopAll();
  els.title.textContent = '停止中';
  els.sub.textContent = 'フォルダー内の曲を、止めるまで自動で再生します';
  els.nowLabel.textContent = 'STOPPED';
});
els.stop.addEventListener('mouseenter', () => els.stop.classList.add('active'));
els.stop.addEventListener('mouseleave', () => els.stop.classList.remove('active'));

/* ---------- シーク ---------- */
function fmt(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}
audio.addEventListener('timeupdate', () => {
  if (!isFinite(audio.duration) || audio.duration === 0) return;
  els.progBar.style.width = (audio.currentTime / audio.duration * 100) + '%';
  els.tCur.textContent = fmt(audio.currentTime);
  els.tTotal.textContent = fmt(audio.duration);
  checkFade();
});
els.progWrap.addEventListener('click', (e) => {
  const r = els.progWrap.getBoundingClientRect();
  const ratio = (e.clientX - r.left) / r.width;
  if (useBufferMode && bufDuration > 0) {
    const target = ratio * bufDuration;
    if (playing) {
      stopBufSrc();
      bufOffset = target;
      resumeBuffer();
    } else {
      bufOffset = target;
      els.progBar.style.width = (ratio * 100) + '%';
      els.tCur.textContent = fmt(target);
    }
  } else if (isFinite(audio.duration)) {
    audio.currentTime = ratio * audio.duration;
  }
});

/* ---------- 曲間フェード ---------- */
const FADE_SEC = 4;
function checkFade() {
  if (!ctx || !fadeOn || !playing || fading || sleepFading) return;
  const dur = useBufferMode ? bufDuration : audio.duration;
  const cur = useBufferMode ? bufElapsed() : audio.currentTime;
  const remain = dur - cur;
  if (isFinite(remain) && remain <= FADE_SEC && remain > 0.05) {
    fading = true;
    const t = ctx.currentTime;
    fadeGain.gain.cancelScheduledValues(t);
    fadeGain.gain.setValueAtTime(fadeGain.gain.value, t);
    fadeGain.gain.linearRampToValueAtTime(0.0001, t + remain);
  }
}

/* 代替再生モードの進行状況表示 */
setInterval(() => {
  if (!useBufferMode || !playing || !ctx) return;
  const cur = bufElapsed();
  els.progBar.style.width = (bufDuration ? (cur / bufDuration) * 100 : 0) + '%';
  els.tCur.textContent = fmt(cur);
  els.tTotal.textContent = fmt(bufDuration);
  checkFade();
}, 200);

/* ---------- 速度 ---------- */
function setSpeed(v) {
  // 代替再生中は経過時刻を維持したまま速度を更新
  if (useBufferMode && ctx && bufSrc) {
    const e = bufElapsed();
    bufOffset = e;
    bufStartAt = ctx.currentTime;
    bufSrc.playbackRate.value = v;
  }
  speed = v;
  audio.playbackRate = v;
  audio.preservesPitch = pitchKeep;
  audio.webkitPreservesPitch = pitchKeep;
  els.speedLabel.textContent = v.toFixed(2) + 'x';
  els.speedVal.textContent = v.toFixed(2) + 'x';
  S.set('speed', v);
  pushRemoteState();
}
els.speed.addEventListener('input', () => { setSpeed(+els.speed.value / 100); });
els.pitchkeep.addEventListener('change', () => {
  pitchKeep = els.pitchkeep.checked;
  setSpeed(speed);
  S.set('pitchkeep', pitchKeep);
});

/* ---------- 上級者向けパラメータ ---------- */
els.eql.addEventListener('input', () => { eq.l = +els.eql.value; els.eqlVal.textContent = eq.l; S.set('eq', eq); applyAudioParams(); });
els.eqm.addEventListener('input', () => { eq.m = +els.eqm.value; els.eqmVal.textContent = eq.m; S.set('eq', eq); applyAudioParams(); });
els.eqh.addEventListener('input', () => { eq.h = +els.eqh.value; els.eqhVal.textContent = eq.h; S.set('eq', eq); applyAudioParams(); });
els.reverb.addEventListener('input', () => {
  reverbAmt = +els.reverb.value; els.reverbVal.textContent = reverbAmt;
  S.set('reverb', reverbAmt);
  if (ctx) wet.gain.setTargetAtTime((reverbAmt / 100) * 0.35, ctx.currentTime, 0.1);
});
els.pan.addEventListener('input', () => {
  panAmt = +els.pan.value;
  els.panVal.textContent = panAmt === 0 ? '中央' : (panAmt < 0 ? '左' : '右') + Math.abs(panAmt);
  S.set('pan', panAmt);
  if (ctx) panner.pan.setTargetAtTime(panAmt / 100, ctx.currentTime, 0.1);
});
els.mono.addEventListener('change', () => {
  monoOn = els.mono.checked; S.set('mono', monoOn);
  applyAudioParams();
  toast(monoOn ? 'モノラル再生に切り替えました' : 'ステレオ再生に戻しました');
});
els.fade.addEventListener('change', () => { fadeOn = els.fade.checked; S.set('fade', fadeOn); });
els.agct.addEventListener('input', () => {
  agcTarget = +els.agct.value;
  els.agctVal.textContent = agcTarget + '%';
  S.set('agct', agcTarget);
});

/* ---------- タブ切替 ---------- */
function switchTab(adv) {
  els.tabSound.classList.toggle('on', !adv);
  els.tabAdv.classList.toggle('on', adv);
  els.panelSound.classList.toggle('hidden', adv);
  els.panelAdv.classList.toggle('hidden', !adv);
}
els.tabSound.addEventListener('click', () => switchTab(false));
els.tabAdv.addEventListener('click', () => switchTab(true));

/* ---------- モードピル ---------- */
function refreshModeUI() {
  for (const btn of els.modeRow.children) {
    btn.classList.toggle('on', btn.dataset.mode === mode);
  }
  els.calmVal.textContent = calm;
}
els.modeRow.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-pill');
  if (!btn) return;
  mode = btn.dataset.mode;
  refreshModeUI();
  applyAudioParams();
});
els.calm.addEventListener('input', () => {
  calm = +els.calm.value;
  els.calmVal.textContent = calm;
  applyAudioParams();
});
els.agc.addEventListener('change', () => {
  if (ctx) agc.gain.setTargetAtTime(els.agc.checked ? agc.gain.value : 1, ctx.currentTime, 0.3);
  S.set('agc', els.agc.checked);
});

/* ---------- 長押しメニューシステム ---------- */
const menuLayer = document.createElement('div');
menuLayer.id = 'menu-layer';
document.body.appendChild(menuLayer);

const toastWrap = document.createElement('div');
toastWrap.id = 'toast-wrap';
document.body.appendChild(toastWrap);

const helpOverlay = document.createElement('div');
helpOverlay.id = 'help-overlay';
helpOverlay.innerHTML = `
  <div class="help-card">
    <h2>⌨ キーボードショートカット</h2>
    <div class="help-row"><span>再生 / 一時停止</span><span><kbd>Space</kbd></span></div>
    <div class="help-row"><span>5秒戻る / 進む</span><span><kbd>←</kbd><kbd>→</kbd></span></div>
    <div class="help-row"><span>前の曲 / 次の曲</span><span><kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd></span></div>
    <div class="help-row"><span>音量</span><span><kbd>↑</kbd><kbd>↓</kbd></span></div>
    <div class="help-row"><span>全画面 表示 / 解除</span><span><kbd>F</kbd> / <kbd>Esc</kbd></span></div>
    <div class="help-row"><span>シャッフル</span><span><kbd>S</kbd></span></div>
    <div class="help-row"><span>リピート切替</span><span><kbd>R</kbd></span></div>
    <div class="help-row"><span>モノラル切替</span><span><kbd>M</kbd></span></div>
    <div class="help-row"><span>このヘルプ</span><span><kbd>?</kbd></span></div>
    <div class="help-row" style="border:none"><span>閉じる / 解除</span><span><kbd>Esc</kbd></span></div>
    <p style="margin-top:12px;font-size:11.5px;color:var(--text-dim)">ヒント: ボタンや曲を<b>長押し(0.5秒)</b>でもメニューが出ます</p>
  </div>`;
document.body.appendChild(helpOverlay);
helpOverlay.addEventListener('click', () => helpOverlay.classList.remove('open'));

function closeMenus() { menuLayer.innerHTML = ''; menuLayer.classList.remove('open'); }
menuLayer.addEventListener('pointerdown', (e) => { if (e.target === menuLayer) closeMenus(); });
window.addEventListener('blur', closeMenus);

function showMenu(x, y, items, title) {
  closeMenus();
  const m = document.createElement('div');
  m.className = 'menu';
  if (title) {
    const t = document.createElement('div');
    t.className = 'menu-title';
    t.textContent = title;
    m.appendChild(t);
  }
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; m.appendChild(s); continue; }
    if (it.slider) {
      const row = document.createElement('div');
      row.className = 'menu-slider';
      row.innerHTML = `<div class="ms-label"><span>${it.label}</span><b>${it.fmt(it.value)}</b></div>`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = it.min; input.max = it.max; input.step = it.step || 1; input.value = it.value;
      input.addEventListener('input', () => {
        it.value = +input.value;
        row.querySelector('b').textContent = it.fmt(it.value);
        it.onInput(it.value);
      });
      row.appendChild(input);
      m.appendChild(row);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'menu-item';
    b.innerHTML = `<span>${it.label}${it.sub ? ` <span class="mi-sub">${it.sub}</span>` : ''}</span>${it.checked ? '<span class="mi-check">✓</span>' : ''}`;
    b.addEventListener('click', () => { closeMenus(); it.action && it.action(); });
    m.appendChild(b);
  }
  menuLayer.appendChild(m);
  menuLayer.classList.add('open');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}

/* 長押し検出 */
function longPress(el, fn, ms = 500) {
  let timer = null, fired = false, sx = 0, sy = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    fired = false;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { fired = true; fn(e); }, ms);
  });
  // 少し動いたら長押しキャンセル(手の震え程度は許容)
  el.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clearTimeout(timer);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => {
    el.addEventListener(ev, () => clearTimeout(timer));
  });
  el.addEventListener('click', (e) => {
    if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; }
  }, true);
}

/* 再生ボタン長押し: 速度+スリープ */
longPress(els.play, (e) => {
  const items = [
    { label: '再生速度', slider: true, min: 50, max: 200, step: 5, value: speed * 100,
      fmt: (v) => (v / 100).toFixed(2) + 'x', onInput: (v) => setSpeed(v / 100) },
    { sep: true },
    ...[15, 30, 45, 60, 90].map((min) => ({
      label: `${min}分後にフェードして停止`,
      checked: sleepRemainMs !== null && Math.ceil(sleepRemainMs / 60000) === min,
      action: () => { setSleep(min); toast(`${min}分後にスリープします`); }
    })),
    { label: 'スリープ解除', checked: sleepRemainMs === null, action: () => setSleep(0) }
  ];
  showMenu(e.clientX, e.clientY, items, '長押しメニュー');
});

/* 停止ボタン長押し: スリープ */
longPress(els.stop, (e) => {
  const items = [
    ...[15, 30, 45, 60, 90].map((min) => ({
      label: `${min}分後にフェードして停止`,
      checked: sleepRemainMs !== null && Math.ceil(sleepRemainMs / 60000) === min,
      action: () => { setSleep(min); toast(`${min}分後にスリープします`); }
    })),
    { label: 'スリープ解除', checked: sleepRemainMs === null, action: () => setSleep(0) }
  ];
  showMenu(e.clientX, e.clientY, items, 'スリープタイマー');
});

/* モードピル長押し: 細かい調整 */
for (const pill of els.modeRow.children) {
  longPress(pill, (e) => {
    const items = [
      { label: '低音カット', slider: true, min: 20, max: 400, step: 5, value: custom.hp,
        fmt: (v) => v + 'Hz以下をカット', onInput: (v) => setCustom('hp', v) },
      { label: '高音を丸める', slider: true, min: 4000, max: 20000, step: 500, value: custom.lp,
        fmt: (v) => (v / 1000).toFixed(1) + 'kHz以上を丸める', onInput: (v) => setCustom('lp', v) },
      { label: '圧縮の強さ', slider: true, min: 0, max: 100, step: 5, value: custom.amt,
        fmt: (v) => v + '%', onInput: (v) => setCustom('amt', v) },
      { sep: true },
      { label: 'プリセットに戻す', action: () => {
          custom = { hp: 90, lp: 12000, amt: 40 };
          mode = 'cafe';
          refreshModeUI(); applyAudioParams();
          toast('カフェプリセットに戻しました');
        } }
    ];
    showMenu(e.clientX, e.clientY, items, 'サウンドを細かく調整');
  });
}

function setCustom(key, v) {
  custom[key] = v;
  mode = 'custom';
  refreshModeUI();
  applyAudioParams();
}

/* シャッフル: クリック + 長押しメニュー不要(トグル) */
els.shuffle.addEventListener('click', () => {
  shuffleOn = !shuffleOn;
  S.set('shuffle', shuffleOn);
  refreshChips();
  toast(shuffleOn ? 'シャッフル再生: オン' : 'シャッフル再生: オフ');
});

/* リピート */
function cycleRepeat() {
  repeatMode = repeatMode === 'all' ? 'one' : repeatMode === 'one' ? 'none' : 'all';
  S.set('repeat', repeatMode);
  refreshChips();
  toast(repeatMode === 'all' ? '全曲ループ(止まるまで再生)' : repeatMode === 'one' ? '1曲をリピート' : 'リピートなし(最後の曲で停止)');
}
els.repeat.addEventListener('click', cycleRepeat);
longPress(els.repeat, (e) => {
  const items = [
    { label: '全曲ループ', sub: '止まるまで再生', checked: repeatMode === 'all', action: () => { repeatMode = 'all'; S.set('repeat', 'all'); refreshChips(); } },
    { label: '1曲リピート', checked: repeatMode === 'one', action: () => { repeatMode = 'one'; S.set('repeat', 'one'); refreshChips(); } },
    { label: 'リピートなし', sub: '最後の曲で停止', checked: repeatMode === 'none', action: () => { repeatMode = 'none'; S.set('repeat', 'none'); refreshChips(); } }
  ];
  showMenu(e.clientX, e.clientY, items, 'リピートモード');
});

/* 速度チップ */
els.speedChip.addEventListener('click', (e) => {
  const items = [0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0].map((v) => ({
    label: v.toFixed(2) + 'x',
    checked: Math.abs(speed - v) < 0.001,
    action: () => setSpeed(v)
  }));
  showMenu(e.clientX, e.clientY, items, '再生速度');
});
longPress(els.speedChip, (e) => els.speedChip.click());

/* スリープ */
let sleepRemainMs = null, sleepTimer = null;
function setSleep(min) {
  clearInterval(sleepTimer);
  if (!min) {
    sleepRemainMs = null;
    els.sleepLabel.textContent = 'スリープ';
    refreshChips();
    return;
  }
  sleepRemainMs = min * 60000;
  refreshChips();
  sleepTimer = setInterval(() => {
    sleepRemainMs -= 1000;
    if (sleepRemainMs <= 0) {
      clearInterval(sleepTimer);
      sleepRemainMs = null;
      els.sleepLabel.textContent = 'スリープ';
      refreshChips();
      // フェードしてから停止
      if (playing && ctx) {
        sleepFading = true;
        const t = ctx.currentTime;
        fadeGain.gain.cancelScheduledValues(t);
        fadeGain.gain.setValueAtTime(fadeGain.gain.value, t);
        fadeGain.gain.linearRampToValueAtTime(0.0001, t + 4);
        setTimeout(() => {
          stopAll();
          els.title.textContent = 'スリープタイマーで停止しました';
          els.sub.textContent = 'おやすみなさい 🌙';
          els.nowLabel.textContent = 'SLEEP';
          toast('スリープタイマーで停止しました 🌙');
        }, 4200);
      } else {
        stopAll();
      }
      return;
    }
    const mm = Math.floor(sleepRemainMs / 60000);
    const ss = Math.floor((sleepRemainMs % 60000) / 1000);
    els.sleepLabel.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
  }, 1000);
}
els.sleepChip.addEventListener('click', (e) => {
  const items = [
    ...[15, 30, 45, 60, 90].map((min) => ({
      label: `${min}分後`,
      checked: sleepRemainMs !== null && Math.ceil(sleepRemainMs / 60000) === min,
      action: () => { setSleep(min); toast(`${min}分後にスリープします`); }
    })),
    { label: '解除', checked: sleepRemainMs === null, action: () => setSleep(0) }
  ];
  showMenu(e.clientX, e.clientY, items, 'スリープタイマー');
});

/* 曲のコンテキストメニュー */
function trackMenu(i, x, y) {
  const f = files[i];
  showMenu(x, y, [
    { label: '▶ この曲を再生', action: () => playIndex(i) },
    { label: '次に再生に追加', action: () => { queuedIndex = i; toast(`「${f.name}」を次に再生します`); } },
    { label: 'この曲をリピート', action: () => { repeatMode = 'one'; S.set('repeat', 'one'); refreshChips(); playIndex(i); } },
    { sep: true },
    { label: 'ファイルの場所を開く', action: () => window.api.reveal(f.path) }
  ], f.name.length > 30 ? f.name.slice(0, 30) + '…' : f.name);
}

/* ---------- 全画面 ---------- */
els.fs.addEventListener('click', () => window.api.toggleFullscreen());
els.max.addEventListener('click', () => window.api.maximize());
els.min.addEventListener('click', () => window.api.minimize());
els.close.addEventListener('click', () => window.api.close());
window.api.onFullscreen((on) => document.body.classList.toggle('fs', on));

let idleTimer = null;
window.addEventListener('mousemove', () => {
  if (!document.body.classList.contains('fs')) return;
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
});

/* ---------- ヘルプ ---------- */
els.help.addEventListener('click', () => helpOverlay.classList.add('open'));
els.notes.addEventListener('click', openNotes);

/* ---------- リリースノート ---------- */
const RELEASES = [
  {
    v: '1.5.4', date: '2026-11-15',
    items: [
      ['🔧', '店員ページ(/staff)が Not Found になる問題を修正'],
      ['📱', 'リモコンサーバーを自動再開: 一度開始したら、アプリを再起動しても自動で立ち上がります(停止はスマホ操作画面の「サーバーを停止」から)'],
      ['🔧', 'サーバー稼働中のエラーで勝手にポートを作り直す(=スマホから切断される)動きを修正']
    ]
  },
  {
    v: '1.5.3', date: '2026-11-15',
    items: [
      ['🔧', '店舗パネルで店名などを入力すると全画面サイネージ(時計待機画面)が勝手に出る問題を修正。サイネージは「🖥 全画面表示」ボタンを押した時だけ開くように']
    ]
  },
  {
    v: '1.5.2', date: '2026-11-15',
    items: [
      ['🔧', '長時間曲(24分〜53分)で再生できない問題を修正: 変換後の再生に全曲メモリ展開(decodeAudioData)を使わず <audio> 直接再生に変更。長い曲のデコードフォールバックも自動スキップ'],
      ['ℹ️', '変換中表示の改善(「変換完了 — 再生します」を表示)']
    ]
  },
  {
    v: '1.5.1', date: '2026-11-15',
    items: [
      ['🔧', 'ネットワーク共有上のファイルで変換が失敗する問題を修正: ffmpegに渡す前に一度ローカルへコピーしてから変換する方式に変更。失敗時の理由も詳細表示'],
      ['🔐', 'リモコンをページ分け&認証導入: 「/」=お客さん用、「/staff」=店員用。店員は店員QR(トークン埋め込み)か、PC画面に表示される6桁の店員コードで認証。お客さんはリクエスト以外の操作がサーバー側で拒否される'],
      ['🙋', 'リクエストは長押しから「タップ」方式に変更(お客さんモードで曲をタップ→確認シート)'],
      ['🖥', 'サイネージの文字入力中にスライドショーが最初に戻る/途中文字が表示される問題を修正(0.7秒デバウンス+変更時のみ再適用)'],
      ['⏱', '店舗パネルの開店/閉店時刻をテキスト入力に変更。「26:00」(翌朝2時)のような指定も可能に']
    ]
  },
  {
    v: '1.5.0', date: '2026-11-15',
    items: [
      ['⏱', '営業時間オートタイマー: 閉店時刻になると指定した分数かけてフェードアウトして自動停止。閉店後のPCシャットダウン(60秒猶予・中止ボタン付き)も選択可'],
      ['🙋', 'お客様リクエスト機能: スマホの「お客さんモード」から曲リクエスト → 店舗パネルで承認(次に再生)/拒否。店員モードとお客さんモードをワンタップで切替'],
      ['🖥', 'サイネージ連動: 全画面スライドショー(店名+時計/本日の一言/Wi-Fi情報+SNS QR/今流れている曲)。QRコード自動生成'],
      ['⏳', 'ポモドーロタイマー連動: 25分作業/5分休憩で音量を自動調整+チャイム']
    ]
  },
  {
    v: '1.4.1', date: '2026-11-15',
    items: [
      ['📲', 'スマホリモコンがPWA対応: スマホの「ホーム画面に追加」でアイコンからフルスクリーンアプリとして起動可能(アイコン/manifest/オフラインキャッシュ同梱)'],
      ['📖', 'READMEを店舗向け/個人向けの2軸で整理し直し']
    ]
  },
  {
    v: '1.4.0', date: '2026-11-15',
    items: [
      ['☕', '本格カフェモード: 環境音ミキサー(雨/焚き火/カフェのざわめき/お好みのファイル)をBGMの裏でミックス、「環境音の量」スライダーで調整'],
      ['⏰', '時間帯オートプリセット: モーニング/カフェタイム/ナイトなど時間帯ごとに音質プリセットと再生速度を自動切替(店舗運用向け・スケジュール編集可)'],
      ['🔊', '出力先管理: アプリ内から出力デバイスの確認・切替、Windows Bluetooth設定をワンクリックで起動'],
      ['🅱', 'Bluetooth自動連携: スピーカー切断時にフェードアウトして一時停止(大音量事故防止)、登録デバイス接続時に自動再生(各ON/OFF可)']
    ]
  },
  {
    v: '1.3.0', date: '2026-11-15',
    items: [
      ['✨', 'スマホリモコン: 同じWi-FiのスマホからQRコードで接続し、再生/音量/プリセット/曲選択/スリープを遠隔操作(WebSocketでリアルタイム同期)'],
      ['✨', '並び替え: 名前順 / 更新日順 / その場でシャッフル'],
      ['🔧', '閉じるボタンで即終了するよう改善、ウィンドウサイズ・位置を記憶']
    ]
  },
  {
    v: '1.2.0', date: '2026-11-15',
    items: [
      ['✨', 'FFmpeg内蔵: 直接再生できないファイル(拡張子と中身が違うファイルや動画コンテナなど)を自動でmp3に変換して再生'],
      ['✨', 'エラー表示にファイルの中身の実際の形式を表示(例: .mp3なのに中身はWMA)'],
      ['🔧', '変換済みの曲は2回目以降すぐ再生できるようキャッシュ']
    ]
  },
  {
    v: '1.1.1', date: '2026-11-15',
    items: [
      ['🔧', '「アプリを通すと曲が使用できません」問題に対応: 通常再生が失敗した曲を、内部でデコードして直接鳴らす代替エンジンで自動再生'],
      ['✨', 'エラーの詳しい原因(未対応形式/ネットワーク/デコードエラーなど)を画面と通知に表示するように'],
      ['🔧', 'ネットワークフォルダーからの読み込み失敗時に自動で再試行'],
      ['🔧', '音声出力が開始できない場合の警告表示を追加']
    ]
  },
  {
    v: '1.1.0', date: '2026-11-15',
    items: [
      ['🔧', '「選んだ曲なのに次の曲へ飛ぶ」問題を修正(読み込み中の競合とURL解放の競合の両方に対応)'],
      ['🔧', '停止ボタンを押した後も読み込みが走って再生が始まることがある問題を修正'],
      ['✨', '全画面モード(Fキー・3秒でUI自動非表示)、最大化ボタン'],
      ['✨', '再生速度 0.50x〜2.00x(ピッチ保持付き・上級者タブで切替)'],
      ['✨', '上級者向けサウンド調整: 3バンドEQ / リバーブ / パン / モノラル / 曲末フェード'],
      ['✨', 'Adobe風の長押しメニュー(再生・停止・モード・リピート・チップ・曲リスト)'],
      ['✨', 'スリープタイマー(15〜90分・フェード付き)、リピートモード、次に再生'],
      ['✨', 'キーボードショートカット一覧(?キー)、ドラッグ&ドロップ対応'],
      ['⚡', '起動と曲替えを高速化(ポータブル版の解凍キャッシュ・次曲の先読み・スキャン軽量化)']
    ]
  },
  {
    v: '1.0.0', date: '2026-11-14',
    items: [
      ['✨', '初版。フォルダー内の音楽を止まるまで自動再生'],
      ['✨', 'カフェ / リラックス / クリアのサウンドプリセット'],
      ['✨', '自動音量(曲ごとの音量差をならす)']
    ]
  }
];

const notesOverlay = document.createElement('div');
notesOverlay.id = 'help-overlay';
notesOverlay.innerHTML = `
  <div class="help-card notes-card">
    <h2>📜 リリースノート</h2>
    <div class="notes-body"></div>
    <button class="chip" id="notes-close" style="margin-top:14px">閉じる</button>
  </div>`;
document.body.appendChild(notesOverlay);
notesOverlay.querySelector('#notes-close').addEventListener('click', () => notesOverlay.classList.remove('open'));
notesOverlay.addEventListener('click', (e) => { if (e.target === notesOverlay) notesOverlay.classList.remove('open'); });

function openNotes() {
  const body = notesOverlay.querySelector('.notes-body');
  body.innerHTML = '';
  for (const rel of RELEASES) {
    const h = document.createElement('div');
    h.className = 'notes-ver';
    h.innerHTML = `<b>v${rel.v}</b><span>${rel.date}</span>`;
    body.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'notes-list';
    for (const [icon, text] of rel.items) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="n-ic">${icon}</span>${''}`;
      li.appendChild(document.createTextNode(text));
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  helpOverlay.classList.remove('open');
  notesOverlay.classList.add('open');
}

/* 更新されたら起動時に1回だけ表示 */
(async () => {
  try {
    const ver = await window.api.version();
    if (S.get('seenVersion', '') !== ver) {
      S.set('seenVersion', ver);
      openNotes();
    }
  } catch {}
})();

/* ---------- キーボードショートカット ---------- */
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' && e.target.type !== 'range') return;
  if (tag === 'INPUT' && e.target.type === 'range' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;

  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) els.prev.click(); else audio.currentTime = Math.max(0, audio.currentTime - 5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) els.next.click(); else if (isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
      break;
    case 'ArrowUp': e.preventDefault(); els.vol.value = Math.min(100, +els.vol.value + 5); els.vol.dispatchEvent(new Event('input')); break;
    case 'ArrowDown': e.preventDefault(); els.vol.value = Math.max(0, +els.vol.value - 5); els.vol.dispatchEvent(new Event('input')); break;
    case 'f': case 'F': window.api.toggleFullscreen(); break;
    case 's': case 'S': els.shuffle.click(); break;
    case 'r': case 'R': cycleRepeat(); break;
    case 'm': case 'M': els.mono.click(); break;
    case 'n': case 'N': els.next.click(); break;
    case 'p': case 'P': els.prev.click(); break;
    case '?': helpOverlay.classList.toggle('open'); break;
    case 'Escape':
      closeMenus();
      helpOverlay.classList.remove('open');
      notesOverlay.classList.remove('open');
      if (remoteOverlay) remoteOverlay.classList.remove('open');
      if (schedOverlay) schedOverlay.classList.remove('open');
      if (remoteOverlayOutput) remoteOverlayOutput.classList.remove('open');
      if (storeOverlay) storeOverlay.classList.remove('open');
      if (pomoOverlay) pomoOverlay.classList.remove('open');
      break;
  }
});

/* ---------- 音量 ---------- */
els.vol.addEventListener('input', () => {
  vol = +els.vol.value;
  if (master) master.gain.setTargetAtTime(vol / 100, ctx.currentTime, 0.05);
  S.set('vol', vol);
  pushRemoteState();
});

/* ---------- ビジュアライザー ---------- */
const cv = els.viz;
const g2 = cv.getContext('2d');
const freqData = new Uint8Array(256);
let phase = 0;

function draw() {
  requestAnimationFrame(draw);
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr;
  }
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2.clearRect(0, 0, w, h);

  const bars = 56;
  const gap = 3;
  const bw = (w - gap * (bars - 1)) / bars;

  let levels;
  if (playing && analyserOut) {
    analyserOut.getByteFrequencyData(freqData);
    levels = [];
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor(Math.pow(i / bars, 1.6) * 200) + 2;
      levels[i] = freqData[idx] / 255;
    }
  } else if (animFrozen) {
    // 一時停止・停止中: 静かなFlat表示(動かない)
    levels = new Array(bars).fill(0.03);
  } else {
    // 未再生: ごくわずかに息づいている程度
    phase += 0.02;
    levels = [];
    for (let i = 0; i < bars; i++) {
      levels[i] = 0.025 + 0.02 * (1 + Math.sin(phase + i * 0.35)) / 2;
    }
  }

  for (let i = 0; i < bars; i++) {
    const v = levels[i];
    const bh = Math.max(2, v * (h - 8));
    const x = i * (bw + gap);
    const y = h - bh;
    const grad = g2.createLinearGradient(0, y, 0, h);
    grad.addColorStop(0, `rgba(217,160,107,${0.2 + v * 0.6})`);
    grad.addColorStop(1, `rgba(143,184,165,${0.08 + v * 0.25})`);
    g2.fillStyle = grad;
    const r = Math.min(bw / 2, 3);
    g2.beginPath();
    g2.roundRect(x, y, bw, bh, r);
    g2.fill();
  }
}
draw();

/* ---------- 並び替え ---------- */
function refreshSortLabel() {
  els.sortBtn.textContent = (sortBy === 'name' ? '名前順' : '更新日順') + ' ▾';
}
function reloadWithSort(s) {
  sortBy = s;
  S.set('sort', s);
  refreshSortLabel();
  if (!folder) { toast('まずフォルダーを開いてください'); return; }
  const curPath = files[index] ? files[index].path : null;
  window.api.scanFolder(folder, sortBy).then((res) => {
    files = res.files;
    bufCache.clear();
    transCache.clear();
    if (curPath) {
      const i = files.findIndex((f) => f.path === curPath);
      if (i >= 0) index = i;
    }
    renderList();
    pushRemoteTracks();
    pushRemoteState();
    toast('並び順を変更しました');
  });
}
function shuffleOrder() {
  if (!files.length) return;
  for (let i = files.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [files[i], files[j]] = [files[j], files[i]];
  }
  renderList();
  pushRemoteTracks();
  toast('並び順をシャッフルしました');
}
els.sortBtn.addEventListener('click', () => {
  const r = els.sortBtn.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    { label: '名前順', checked: sortBy === 'name', action: () => reloadWithSort('name') },
    { label: '更新日順(新しい)', checked: sortBy === 'mtime', action: () => reloadWithSort('mtime') },
    { sep: true },
    { label: '並びをシャッフル', action: shuffleOrder }
  ], '並び順');
});

/* ---------- スマホリモコン(PC側UI・コマンド処理) ---------- */
let remoteOverlay = null;

function buildRemoteOverlay() {
  remoteOverlay = document.createElement('div');
  remoteOverlay.id = 'help-overlay';
  remoteOverlay.innerHTML = `
    <div class="help-card">
      <h2>📱 スマホリモコン</h2>
      <p class="remote-hint">同じWi-Fiに接続したスマホでQRコードを読み取ると、ブラウザから遠隔操作できます。</p>
      <p class="remote-hint">📲 便利な使い方: ページを開いたらブラウザのメニューから「<b>ホーム画面に追加</b>」を選ぶと、アイコンからアプリのように起動できます(iPhoneは Safari の共有ボタン → ホーム画面に追加)。</p>
      <div class="remote-start">
        <span class="rs-label">ポート</span>
        <input id="remote-port" type="number" value="8080" min="1024" max="65535">
        <label class="rs-label" title="オンにするとhttpsで配信し、スマホに正規のPWAとしてインストールできます(初回のみスマホにCA証明書のインストールが必要)">
          <input id="remote-tls" type="checkbox" style="vertical-align:middle"> 🔒 PWAモード(HTTPS)
        </label>
        <button id="remote-begin" class="chip">サーバーを開始</button>
      </div>
      <div id="remote-body" class="remote-body"></div>
      <button class="chip" id="remote-close" style="margin-top:14px">閉じる</button>
    </div>`;
  document.body.appendChild(remoteOverlay);
  remoteOverlay.addEventListener('click', (e) => {
    if (e.target === remoteOverlay) remoteOverlay.classList.remove('open');
  });
  remoteOverlay.querySelector('#remote-close').addEventListener('click', () =>
    remoteOverlay.classList.remove('open'));

  remoteOverlay.querySelector('#remote-begin').addEventListener('click', async () => {
    const port = +remoteOverlay.querySelector('#remote-port').value || 8080;
    const tls = remoteOverlay.querySelector('#remote-tls').checked;
    const btn = remoteOverlay.querySelector('#remote-begin');
    btn.disabled = true; btn.textContent = '起動中…';
    const info = await window.api.remoteStart(port, tls);
    btn.disabled = false; btn.textContent = 'サーバーを開始';
    if (!info) { toast('空きポートが見つかりませんでした'); return; }
    remoteActive = true;
    lastRemoteInfo = info;
    S.set('remoteOn', true);
    S.set('remotePort', info.port);
    S.set('remoteTls', tls);
    pushRemoteState();
    pushRemoteTracks();
    renderRemoteBody();
    toast(tls && info.tlsPort ? 'リモコンサーバーを起動しました(HTTPS/PWAモード)' : 'リモコンサーバーを起動しました(次回起動時から自動で開きます)');
  });
  // 既定値の復元
  remoteOverlay.querySelector('#remote-tls').checked = S.get('remoteTls', false);
}

function renderRemoteBody() {
  const body = remoteOverlay.querySelector('#remote-body');
  if (remoteActive && lastRemoteInfo) {
    const urls = lastRemoteInfo.urls
      .map((u) => `<div class="remote-url"><code>${u}</code><button data-url="${u}" class="chip rcopy">コピー</button></div>`)
      .join('');
    body.innerHTML = `
      <div class="remote-running">● 起動中(ポート ${lastRemoteInfo.port})</div>
      <div class="remote-qr2col">
        <figure class="remote-qrbox">
          <figcaption>🏪 店員用(全操作)</figcaption>
          ${lastRemoteInfo.qrStaff ? `<img class="remote-qr" src="${lastRemoteInfo.qrStaff}" alt="店員用QR">` : ''}
          <div class="remote-code">QRが読めない時は /staff + 店員コード<br><b class="code-num">${lastRemoteInfo.staffCode || '------'}</b></div>
        </figure>
        <figure class="remote-qrbox">
          <figcaption>🙋 お客さん用(リクエストのみ)</figcaption>
          ${lastRemoteInfo.qrGuest ? `<img class="remote-qr" src="${lastRemoteInfo.qrGuest}" alt="お客さん用QR">` : ''}
          <div class="remote-code">店員モードにはなれません</div>
        </figure>
      </div>
      <div class="remote-urls">${urls}</div>
      ${lastRemoteInfo.tlsPort ? `
      <div class="pwa-guide">
        <div class="st-sec-title">📲 PWAとしてインストール(初回のみスマホに証明書が必要)</div>
        <ol class="pwa-steps">
          <li>スマホで<b>CA証明書QR</b>を読み取り、証明書をダウンロード</li>
          <li><b>Android</b>: 設定 → セキュリティ → 「証明書のインストール」→ CA証明書 → ダウンロードしたファイル<br><b>iPhone</b>: Safariで開いて「プロファイルをインストール」→ 設定で信頼</li>
          <li>上のQRをもう一度読み取り → Chromeメニューの「<b>インストール</b>」(「このアプリは現在使えません」が出なくなり、オフラインでもアイコンから起動できます)</li>
        </ol>
        <div class="remote-qr2col">
          ${lastRemoteInfo.qrCert ? `
          <figure class="remote-qrbox">
            <figcaption>🔐 CA証明書のダウンロード</figcaption>
            <img class="remote-qr" src="${lastRemoteInfo.qrCert}" alt="CA証明書QR">
          </figure>` : ''}
        </div>
      </div>` : (lastRemoteInfo.tlsRequested ? '<p class="remote-idle">⚠ HTTPS証明書を用意できませんでした(HTTPのみで起動しています)</p>' : '')}
      <button id="remote-stop" class="chip" style="margin-top:10px">サーバーを停止</button>`;
    body.querySelector('#remote-stop').addEventListener('click', async () => {
      await window.api.remoteStop();
      remoteActive = false;
      S.set('remoteOn', false);
      renderRemoteBody();
      toast('リモコンサーバーを停止しました');
    });
    for (const b of body.querySelectorAll('.rcopy')) {
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.dataset.url); toast('コピーしました'); } catch {}
      });
    }
  } else {
    body.innerHTML = '<p class="remote-idle">サーバーは停止中です。</p>';
  }
}

els.remote.addEventListener('click', () => {
  if (!remoteOverlay) buildRemoteOverlay();
  renderRemoteBody();
  helpOverlay.classList.remove('open');
  remoteOverlay.classList.add('open');
});

/* スマホからのコマンド → 既存の再生機能をそのまま呼ぶ */
window.api.onRemoteCommand((msg) => {
  if (!msg || msg.type !== 'cmd') return;
  const a = msg.action;
  // お客さんモードの接続は「リクエスト」以外の操作をサーバー側と二重に拒否
  if (msg.role !== 'staff' && a !== 'request') return;
  try {
    switch (a) {
      case 'toggle': togglePlay(); break;
      case 'play': if (!playing) togglePlay(); break;
      case 'pause': if (playing) togglePlay(); break;
      case 'next': els.next.click(); break;
      case 'prev': els.prev.click(); break;
      case 'stop': els.stop.click(); break;
      case 'volume': {
        const v = Math.round(Math.min(Math.max(msg.value ?? 0.7, 0), 1) * 100);
        els.vol.value = v;
        els.vol.dispatchEvent(new Event('input'));
        break;
      }
      case 'preset':
        if (PRESETS[msg.value]) {
          mode = msg.value;
          refreshModeUI();
          applyAudioParams();
        }
        break;
      case 'track': if (files.length) playIndex(msg.index | 0); break;
      case 'queueNext': {
        const i = msg.index | 0;
        if (files[i]) { queuedIndex = i; toast(`次に再生: ${files[i].name}`); }
        break;
      }
      case 'sleep': setSleep(msg.minutes | 0); break;
      case 'request': {
        const i = msg.index | 0;
        const f = files[i];
        if (!f) break;
        if (pendingRequests.some((r) => r.index === i)) break; // 重複は無視
        pendingRequests.push({ index: i, name: f.name.replace(/\.[^.]+$/, ''), at: Date.now() });
        if (pendingRequests.length > 20) pendingRequests.shift();
        toast(`🙋 リクエスト届きました: ${f.name.replace(/\.[^.]+$/, '')}`);
        renderRequests();
        pushRemoteState();
        break;
      }
    }
  } catch {}
});

/* ---------- 環境音UI ---------- */
els.ambSel.addEventListener('change', async () => {
  ambientKind = els.ambSel.value;
  S.set('ambient', ambientKind);
  if (ambientKind === 'file' && !ambFile) {
    const f = await window.api.pickAudioFile();
    if (f) { ambFile = f; S.set('ambFile', f); els.ambFileName.textContent = f.split(/[\\/]/).pop(); }
    else { ambientKind = 'none'; els.ambSel.value = 'none'; S.set('ambient', 'none'); return; }
  }
  applyAmbient();
  toast(ambientKind === 'none' ? '環境音を止めました' : `環境音: ${els.ambSel.selectedOptions[0].textContent}`);
});

els.amb.addEventListener('input', () => setAmbientBlend(+els.amb.value));

els.ambFileBtn.addEventListener('click', async () => {
  const f = await window.api.pickAudioFile();
  if (!f) return;
  ambFile = f;
  S.set('ambFile', f);
  els.ambFileName.textContent = f.split(/[\\/]/).pop();
  if (ambientKind === 'file') applyAmbient();
});

/* ---------- 時間帯オートプリセット(スケジュール) ---------- */
let schedule = S.get('schedule', [
  { start: '07:00', end: '11:00', mode: 'clear', speed: 1 },    // モーニング
  { start: '11:00', end: '18:00', mode: 'cafe', speed: 1 },    // カフェタイム
  { start: '18:00', end: '07:00', mode: 'relax', speed: 0.95 } // ナイト
]);

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return -1;
  const h = +m[1], mm = +m[2];
  if (mm > 59 || h > 29) return -1;   // 翌朝を示す 26:00 なども許可
  return h * 60 + mm;
}

function slotActive(slot, nowMin) {
  const s = toMin(slot.start), e = toMin(slot.end);
  if (s < 0 || e < 0) return false;
  if (s === e) return false;
  return s < e ? (nowMin >= s && nowMin < e) : (nowMin >= s || nowMin < e); // 日をまたぐ対応
}

let schedTimer = null;

function checkSchedule() {
  if (!scheduleOn) return;
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  for (const slot of schedule) {
    if (slotActive(slot, nowMin)) {
      if (PRESETS[slot.mode] && slot.mode !== mode) {
        mode = slot.mode;
        refreshModeUI();
        applyAudioParams();
        toast(`⏰ 時間帯に合わせてプリセット「${slot.mode}」に自動切替しました`);
      }
      if (slot.speed && Math.abs(slot.speed - speed) > 0.001) {
        setSpeed(+slot.speed);
        toast(`⏰ 時間帯に合わせて再生速度を ${slot.speed.toFixed(2)}x に変更しました`);
      }
      break;
    }
  }
}

function startScheduleTimer() {
  clearInterval(schedTimer);
  if (scheduleOn) {
    checkSchedule();
    schedTimer = setInterval(checkSchedule, 60000);
  }
}

els.schedSw.addEventListener('change', () => {
  scheduleOn = els.schedSw.checked;
  S.set('scheduleOn', scheduleOn);
  startScheduleTimer();
  toast(scheduleOn ? '⏰ 時間帯オートプリセットを有効にしました' : '時間帯オートプリセットを無効にしました');
});

/* スケジュール編集overlay */
let schedOverlay = null;

function buildSchedOverlay() {
  schedOverlay = document.createElement('div');
  schedOverlay.id = 'help-overlay';
  schedOverlay.innerHTML = `
    <div class="help-card">
      <h2>⏰ 時間帯オートプリセット</h2>
      <p class="sched-hint">時間帯ごとに音質プリセットと再生速度を自動で切り替えます(店舗の営業時間運用向け)。</p>
      <div id="sched-rows" class="sched-rows"></div>
      <div class="sched-actions">
        <button id="sched-add" class="chip">＋ 行を追加</button>
        <button id="sched-save" class="chip">保存して適用</button>
      </div>
      <button class="chip" id="sched-close" style="margin-top:14px">閉じる</button>
    </div>`;
  document.body.appendChild(schedOverlay);
  schedOverlay.addEventListener('click', (e) => {
    if (e.target === schedOverlay) schedOverlay.classList.remove('open');
  });
  schedOverlay.querySelector('#sched-close').addEventListener('click', () =>
    schedOverlay.classList.remove('open'));
  schedOverlay.querySelector('#sched-add').addEventListener('click', () => {
    schedule.push({ start: '09:00', end: '12:00', mode: 'cafe', speed: 1 });
    renderSchedRows();
  });
  schedOverlay.querySelector('#sched-save').addEventListener('click', () => {
    const rows = schedOverlay.querySelectorAll('.sched-row');
    schedule = [];
    for (const row of rows) {
      const start = row.querySelector('.sc-start').value;
      const end = row.querySelector('.sc-end').value;
      const m = row.querySelector('.sc-mode').value;
      const sp = Math.min(Math.max(+row.querySelector('.sc-speed').value || 1, 0.5), 2);
      if (toMin(start) >= 0 && toMin(end) >= 0) schedule.push({ start, end, mode: m, speed: sp });
    }
    S.set('schedule', schedule);
    schedOverlay.classList.remove('open');
    checkSchedule();
    toast('スケジュールを保存しました');
  });
}

function renderSchedRows() {
  const box = schedOverlay.querySelector('#sched-rows');
  box.innerHTML = '';
  schedule.forEach((slot, i) => {
    const row = document.createElement('div');
    row.className = 'sched-row';
    row.innerHTML = `
      <input class="sc-start mini-input" style="width:80px;flex:none" value="${slot.start}" placeholder="07:00">
      <span class="sc-arrow">→</span>
      <input class="sc-end mini-input" style="width:80px;flex:none" value="${slot.end}" placeholder="26:00可">
      <select class="sc-mode">
        ${['off', 'cafe', 'relax', 'clear', 'custom'].map((m) =>
          `<option value="${m}" ${m === slot.mode ? 'selected' : ''}>${m === 'off' ? 'オフ' : m === 'cafe' ? '☕ カフェ' : m === 'relax' ? '🌿 リラックス' : m === 'clear' ? '✨ クリア' : 'カスタム'}</option>`).join('')}
      </select>
      <input class="sc-speed" type="number" value="${slot.speed ?? 1}" min="0.5" max="2" step="0.01" title="再生速度">
      <button class="sc-del" title="削除">✕</button>`;
    row.querySelector('.sc-del').addEventListener('click', () => {
      schedule.splice(i, 1);
      renderSchedRows();
    });
    box.appendChild(row);
  });
}

els.schedEdit.addEventListener('click', () => {
  if (!schedOverlay) buildSchedOverlay();
  renderSchedRows();
  helpOverlay.classList.remove('open');
  schedOverlay.classList.add('open');
});

/* ---------- 出力デバイス / Bluetooth overlay ---------- */
function buildOutputOverlay() {
  remoteOverlayOutput = document.createElement('div');
  remoteOverlayOutput.id = 'help-overlay';
  remoteOverlayOutput.innerHTML = `
    <div class="help-card">
      <h2>🔊 出力先とBluetooth連携</h2>
      <div id="out-list" class="out-list"></div>
      <div class="out-toggles">
        <label class="slider-row toggle-row">
          <span class="s-label">切断時にフェードして一時停止</span>
          <span class="switch"><input id="ot-auto-pause" type="checkbox" /><i></i></span>
        </label>
        <label class="slider-row toggle-row">
          <span class="s-label">登録デバイス接続時に自動再生</span>
          <span class="switch"><input id="ot-auto-play" type="checkbox" /><i></i></span>
        </label>
      </div>
      <div class="out-actions">
        <button id="out-register" class="chip">📌 現在の出力先を登録</button>
        <button id="out-clear" class="chip">登録を解除</button>
        <button id="out-bt" class="chip">🅱 Windows Bluetooth設定を開く</button>
      </div>
      <div id="out-reg-info" class="out-reg-info"></div>
      <button class="chip" id="out-close" style="margin-top:14px">閉じる</button>
    </div>`;
  document.body.appendChild(remoteOverlayOutput);
  remoteOverlayOutput.addEventListener('click', (e) => {
    if (e.target === remoteOverlayOutput) remoteOverlayOutput.classList.remove('open');
  });
  remoteOverlayOutput.querySelector('#out-close').addEventListener('click', () =>
    remoteOverlayOutput.classList.remove('open'));
  remoteOverlayOutput.querySelector('#ot-auto-pause').checked = autoPauseOnDisconnect;
  remoteOverlayOutput.querySelector('#ot-auto-pause').addEventListener('change', (e) => {
    autoPauseOnDisconnect = e.target.checked;
    S.set('autoPause', autoPauseOnDisconnect);
  });
  remoteOverlayOutput.querySelector('#ot-auto-play').checked = autoPlayOnRegister;
  remoteOverlayOutput.querySelector('#ot-auto-play').addEventListener('change', (e) => {
    autoPlayOnRegister = e.target.checked;
    S.set('autoPlayBT', autoPlayOnRegister);
  });
  remoteOverlayOutput.querySelector('#out-register').addEventListener('click', () => {
    const cur = outDevices.find((d) => d.deviceId === currentSinkId);
    registeredLabel = cur ? cur.label : registeredLabel;
    S.set('btRegisterLabel', registeredLabel);
    renderOutputList();
    toast(registeredLabel ? `「${registeredLabel}」を登録しました` : '出力先が見つかりません');
  });
  remoteOverlayOutput.querySelector('#out-clear').addEventListener('click', () => {
    registeredLabel = '';
    S.set('btRegisterLabel', '');
    renderOutputList();
    toast('登録を解除しました');
  });
  remoteOverlayOutput.querySelector('#out-bt').addEventListener('click', () => {
    window.api.openBluetooth();
  });
}

function renderOutputList() {
  const box = remoteOverlayOutput.querySelector('#out-list');
  box.innerHTML = outDevices.length
    ? outDevices.map((d) => `
      <button class="out-item ${d.deviceId === currentSinkId ? 'on' : ''}" data-id="${d.deviceId}">
        <span class="out-name">${d.label || '不明なデバイス'}</span>
        ${d.deviceId === currentSinkId ? '<span class="out-cur">使用中</span>' : ''}
        ${d.label && d.label === registeredLabel ? '<span class="out-reg">📌登録済</span>' : ''}
      </button>`).join('')
    : '<p class="remote-idle">デバイスが見つかりません</p>';
  for (const b of box.querySelectorAll('.out-item')) {
    b.addEventListener('click', async () => {
      await switchOutput(b.dataset.id);
      renderOutputList();
      toast('出力先を切り替えました');
    });
  }
  const regInfo = remoteOverlayOutput.querySelector('#out-reg-info');
  regInfo.textContent = registeredLabel
    ? `登録中: 「${registeredLabel}」が接続されたら自動で出力切替&再生します`
    : '';
}

els.output.addEventListener('click', async () => {
  if (!remoteOverlayOutput) buildOutputOverlay();
  await ensureMediaLabels();
  await refreshOutputs();
  renderOutputList();
  helpOverlay.classList.remove('open');
  remoteOverlayOutput.classList.add('open');
});

/* デバイスの抜き差しを監視 */
navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);

/* ---------- 店舗運用: 営業タイマー / リクエスト / サイネージ ---------- */
let bizOn = S.get('bizOn', false);
let bizOpen = S.get('bizOpen', '09:00');
let bizClose = S.get('bizClose', '21:00');
let bizFadeMin = S.get('bizFadeMin', 3);
let bizShutdown = S.get('bizShutdown', false);
let bizDoneToday = false;          // 閉店処理済みフラグ
let pendingRequests = [];          // お客様リクエスト待ち
let signageData = {
  storeName: S.get('storeName', ''),
  storeMsg: S.get('storeMsg', ''),
  wifiSsid: S.get('wifiSsid', ''),
  wifiPass: S.get('wifiPass', ''),
  snsUrl: S.get('snsUrl', '')
};

/* 営業中かどうか(日をまたぐ閉店時刻にも対応) */
function bizIsOpen(nowMin) {
  const o = toMin(bizOpen), c = toMin(bizClose);
  if (o < 0 || c < 0 || o === c) return true; // 未設定なら常に営業扱い
  return o < c ? (nowMin >= o && nowMin < c) : (nowMin >= o || nowMin < c);
}

let bizBizClosing = false;

function checkBusinessHours() {
  if (!bizOn) return;
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const open = bizIsOpen(nowMin);

  if (open) { bizDoneToday = false; return; }

  if (bizDoneToday || bizBizClosing) return;
  bizDoneToday = true;

  // 閉店: ゆっくりフェードアウトして停止
  if (playing && ctx) {
    bizBizClosing = true;
    toast(`🏪 閉店時刻です。${bizFadeMin}分かけてフェードアウトします`);
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0.0001, t + bizFadeMin * 60);
    setTimeout(() => {
      bizBizClosing = false;
      stopAll();
      master.gain.value = vol / 100;   // 次回開店時に音量を戻しておく
      els.title.textContent = '営業終了 — お疲れさまでした ☕';
    }, bizFadeMin * 60 * 1000 + 500);
  } else {
    toast('🏪 閉店時刻です');
  }

  // (任意)PCのシャットダウン — 60秒猶予あり
  if (bizShutdown) {
    window.api.shutdown();
    toast('⚠ 60秒後にPCをシャットダウンします。取り消す場合は店舗パネルの「中止」を押してください');
  }
}

setInterval(checkBusinessHours, 60000);

/* サイネージへ再生中の曲名を送る */
function pushSignageNow() {
  try { window.api.signageUpdate({ nowTitle: currentName || els.title.textContent }); } catch {}
}

/* ---------- 店舗パネルoverlay ---------- */
let storeOverlay = null;

function buildStoreOverlay() {
  storeOverlay = document.createElement('div');
  storeOverlay.id = 'help-overlay';
  storeOverlay.innerHTML = `
    <div class="help-card">
      <h2>🏪 店舗運用パネル</h2>

      <div class="st-sec-title">⏱ 営業時間オートタイマー</div>
      <label class="slider-row toggle-row">
        <span class="s-label">閉店時刻にフェードアウトして自動停止</span>
        <span class="switch"><input id="bz-sw" type="checkbox" /><i></i></span>
      </label>
      <div class="bz-row">
        <span class="s-label">開店</span><input id="bz-open" class="mini-input" style="width:88px;flex:none" placeholder="09:00">
        <span class="s-label">閉店</span><input id="bz-close" class="mini-input" style="width:88px;flex:none" placeholder="21:00 / 26:00可">
        <span class="s-label">フェード</span><input id="bz-fade" type="number" min="1" max="30"> 分
      </div>
      <label class="slider-row toggle-row">
        <span class="s-label">閉店後にPCをシャットダウン(60秒猶予)</span>
        <span class="switch"><input id="bz-shut" type="checkbox" /><i></i></span>
      </label>
      <button id="bz-abort" class="chip mini-btn">⚠ シャットダウンを中止</button>

      <div class="adv-sep"></div>

      <div class="st-sec-title">🙋 お客様リクエスト <span class="st-note">(スマホの「お客さんモード」から受信)</span></div>
      <div id="req-list" class="req-list"><p class="remote-idle">リクエストはまだ届いていません</p></div>

      <div class="adv-sep"></div>

      <div class="st-sec-title">🖥 サイネージ表示</div>
      <div class="bz-row2">
        <span class="s-label">店名</span><input id="sg-name" class="mini-input" placeholder="MUSIC CAFE">
      </div>
      <div class="bz-row2">
        <span class="s-label">本日の一言</span><input id="sg-msg" class="mini-input" placeholder="ようこそ!">
      </div>
      <div class="bz-row">
        <span class="s-label">Wi-Fi</span><input id="sg-ssid" class="mini-input" placeholder="SSID" style="flex:1">
        <input id="sg-pass" class="mini-input" placeholder="パスワード" style="flex:1">
      </div>
      <div class="bz-row2">
        <span class="s-label">SNS</span><input id="sg-sns" class="mini-input" placeholder="https://...">
      </div>
      <div class="sched-actions" style="margin-top:8px">
        <button id="sg-open" class="chip">🖥 サイネージを全画面表示</button>
        <button id="sg-close" class="chip">閉じる(Escでも可)</button>
      </div>
    </div>`;
  document.body.appendChild(storeOverlay);
  storeOverlay.addEventListener('click', (e) => {
    if (e.target === storeOverlay) storeOverlay.classList.remove('open');
  });

  const sw = storeOverlay.querySelector('#bz-sw');
  sw.checked = bizOn;
  sw.addEventListener('change', () => {
    bizOn = sw.checked;
    S.set('bizOn', bizOn);
    if (bizOn) checkBusinessHours();
    toast(bizOn ? '🏪 営業時間オートタイマーを有効にしました' : '営業時間オートタイマーを無効にしました');
  });
  storeOverlay.querySelector('#bz-open').value = bizOpen;
  storeOverlay.querySelector('#bz-close').value = bizClose;
  storeOverlay.querySelector('#bz-fade').value = bizFadeMin;
  const shut = storeOverlay.querySelector('#bz-shut');
  shut.checked = bizShutdown;
  shut.addEventListener('change', () => {
    bizShutdown = shut.checked;
    S.set('bizShutdown', bizShutdown);
  });
  // 時刻はテキスト入力(26:00=翌朝2時 のような指定も可)
  const bindTime = (el, save) => {
    el.addEventListener('change', () => {
      const v = toMin(el.value);
      if (v < 0) {
        toast('時刻は HH:MM 形式で入力してください(例: 09:00 / 26:00)');
        el.focus();
        return;
      }
      save(el.value.trim());
    });
  };
  bindTime(storeOverlay.querySelector('#bz-open'), (v) => {
    bizOpen = v; S.set('bizOpen', bizOpen);
    toast(`開店時刻を ${bizOpen} に設定しました`);
  });
  bindTime(storeOverlay.querySelector('#bz-close'), (v) => {
    bizClose = v; S.set('bizClose', bizClose);
    toast(`閉店時刻を ${bizClose} に設定しました`);
  });
  storeOverlay.querySelector('#bz-fade').addEventListener('change', (e) => { bizFadeMin = Math.min(Math.max(+e.target.value || 3, 1), 30); S.set('bizFadeMin', bizFadeMin); });
  storeOverlay.querySelector('#bz-abort').addEventListener('click', () => {
    window.api.shutdownAbort();
    toast('シャットダウンを中止しました');
  });

  // サイネージ設定(入力後0.7秒でまとめて送信)
  // 注意: signageOpen は「閉じていれば全画面を開く」なので入力中は使わない。
  // signageUpdate は「開いている時だけ内容を反映」→ 全画面はボタンを押した時だけ出る。
  let sgTimer = null;
  const pushSignageSettings = () => {
    clearTimeout(sgTimer);
    sgTimer = setTimeout(() => {
      window.api.signageUpdate(Object.assign({}, signageData));
    }, 700);
  };
  const bindSignage = (key, el) => {
    el.value = signageData[key] || '';
    el.addEventListener('input', () => {
      signageData[key] = el.value;
      S.set(key, el.value);
      pushSignageSettings();
    });
  };
  bindSignage('storeName', storeOverlay.querySelector('#sg-name'));
  bindSignage('storeMsg', storeOverlay.querySelector('#sg-msg'));
  bindSignage('wifiSsid', storeOverlay.querySelector('#sg-ssid'));
  bindSignage('wifiPass', storeOverlay.querySelector('#sg-pass'));
  bindSignage('snsUrl', storeOverlay.querySelector('#sg-sns'));

  storeOverlay.querySelector('#sg-open').addEventListener('click', () => {
    window.api.signageOpen(Object.assign({}, signageData)).then(() => {
      pushSignageNow();
      storeOverlay.classList.remove('open');
      toast('🖥 サイネージを表示しました(Escで閉じる)');
    });
  });
  storeOverlay.querySelector('#sg-close').addEventListener('click', () =>
    storeOverlay.classList.remove('open'));
}

function renderRequests() {
  if (!storeOverlay) return;
  const box = storeOverlay.querySelector('#req-list');
  if (!pendingRequests.length) {
    box.innerHTML = '<p class="remote-idle">リクエストはまだ届いていません</p>';
    return;
  }
  box.innerHTML = '';
  pendingRequests.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'req-row';
    row.innerHTML = `<span class="req-name">🙋 ${r.name}</span>`;
    const ok = document.createElement('button');
    ok.className = 'chip mini-btn ok'; ok.textContent = '✅ 承認';
    const ng = document.createElement('button');
    ng.className = 'chip mini-btn ng'; ng.textContent = '❌ 拒否';
    ok.addEventListener('click', () => approveRequest(r));
    ng.addEventListener('click', () => denyRequest(r));
    row.appendChild(ok); row.appendChild(ng);
    box.appendChild(row);
  });
}

function approveRequest(r) {
  pendingRequests = pendingRequests.filter((x) => x !== r);
  queuedIndex = r.index;
  if (!playing && files.length) playIndex(r.index);
  toast(`✅ リクエスト承認: 「${r.name}」を次に再生します`);
  renderRequests();
  pushRemoteState();
}

function denyRequest(r) {
  pendingRequests = pendingRequests.filter((x) => x !== r);
  toast('リクエストを拒否しました');
  renderRequests();
  pushRemoteState();
}

els.store.addEventListener('click', () => {
  if (!storeOverlay) buildStoreOverlay();
  renderRequests();
  helpOverlay.classList.remove('open');
  storeOverlay.classList.add('open');
});

/* ---------- ポモドーロタイマー ---------- */
let pomoOn = S.get('pomoOn', false);
let pomoWork = S.get('pomoWork', 25);
let pomoBreak = S.get('pomoBreak', 5);
let pomoPhase = 'work';
let pomoRemain = pomoWork * 60;
let pomoTimer = null;
let pomoCycles = 0;

function chime() {
  try {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    [880, 1174.7].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.28);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.28 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.28 + 0.6);
      o.connect(g); g.connect(master);
      o.start(t0 + i * 0.28);
      o.stop(t0 + i * 0.28 + 0.7);
    });
  } catch {}
}

function pomoLabel() {
  if (!pomoOn) { els.pomo.textContent = '⏳ ポモドーロ'; return; }
  const m = Math.floor(pomoRemain / 60), s = pomoRemain % 60;
  els.pomo.textContent = `${pomoPhase === 'work' ? '🍅 作業' : '☕ 休憩'} ${m}:${String(s).padStart(2, '0')}`;
}

function pomoTick() {
  pomoRemain--;
  if (pomoRemain <= 0) {
    if (pomoPhase === 'work') {
      pomoPhase = 'break';
      pomoRemain = pomoBreak * 60;
      chime();
      toast(`☕ 休憩(${pomoBreak}分)! BGMの音量を下げます`);
      if (master) master.gain.setTargetAtTime((vol / 100) * 0.4, ctx.currentTime, 1.5);
    } else {
      pomoPhase = 'work';
      pomoCycles++;
      pomoRemain = pomoWork * 60;
      chime();
      toast(`🍅 作業再開(${pomoWork}分) — ${pomoCycles}サイクル目`);
      if (master) master.gain.setTargetAtTime(vol / 100, ctx.currentTime, 1.5);
    }
  }
  pomoLabel();
}

function startPomo() {
  stopPomo(true);
  pomoPhase = 'work';
  pomoRemain = pomoWork * 60;
  pomoCycles = 0;
  pomoTimer = setInterval(pomoTick, 1000);
  pomoLabel();
  toast(`🍅 ポモドーロ開始: 作業${pomoWork}分 / 休憩${pomoBreak}分`);
}

function stopPomo(silent) {
  clearInterval(pomoTimer);
  pomoTimer = null;
  if (ctx && master) master.gain.setTargetAtTime(vol / 100, ctx.currentTime, 0.5);
  pomoLabel();
  if (!silent) toast('ポモドーロを終了しました');
}

let pomoOverlay = null;

function buildPomoOverlay() {
  pomoOverlay = document.createElement('div');
  pomoOverlay.id = 'help-overlay';
  pomoOverlay.innerHTML = `
    <div class="help-card">
      <h2>⏳ ポモドーロタイマー連動</h2>
      <p class="sched-hint">25分作業・5分休憩のサイクルに合わせて、BGMの音量を自動調整します。休憩中は音量が約40%に下がり、切り替わりにチャイムが鳴ります。</p>
      <div class="bz-row" style="margin:12px 0">
        <span class="s-label">作業</span><input id="pm-work" type="number" min="5" max="90"> 分
        <span class="s-label">休憩</span><input id="pm-break" type="number" min="1" max="30"> 分
      </div>
      <div id="pm-status" class="out-reg-info"></div>
      <div class="sched-actions" style="margin-top:12px">
        <button id="pm-start" class="chip">▶ 開始</button>
        <button id="pm-stop" class="chip">■ 停止</button>
        <button id="pm-close" class="chip">閉じる</button>
      </div>
    </div>`;
  document.body.appendChild(pomoOverlay);
  pomoOverlay.addEventListener('click', (e) => {
    if (e.target === pomoOverlay) pomoOverlay.classList.remove('open');
  });
  pomoOverlay.querySelector('#pm-work').value = pomoWork;
  pomoOverlay.querySelector('#pm-break').value = pomoBreak;
  pomoOverlay.querySelector('#pm-work').addEventListener('change', (e) => {
    pomoWork = Math.min(Math.max(+e.target.value || 25, 5), 90);
    S.set('pomoWork', pomoWork);
  });
  pomoOverlay.querySelector('#pm-break').addEventListener('change', (e) => {
    pomoBreak = Math.min(Math.max(+e.target.value || 5, 1), 30);
    S.set('pomoBreak', pomoBreak);
  });
  pomoOverlay.querySelector('#pm-start').addEventListener('click', () => {
    pomoOn = true; S.set('pomoOn', true);
    startPomo();
    pomoOverlay.classList.remove('open');
  });
  pomoOverlay.querySelector('#pm-stop').addEventListener('click', () => {
    pomoOn = false; S.set('pomoOn', false);
    stopPomo();
  });
  pomoOverlay.querySelector('#pm-close').addEventListener('click', () =>
    pomoOverlay.classList.remove('open'));
}

els.pomo.addEventListener('click', () => {
  if (!pomoOverlay) buildPomoOverlay();
  const st = pomoOverlay.querySelector('#pm-status');
  st.textContent = pomoOn
    ? `実行中: ${pomoPhase === 'work' ? '作業' : '休憩'}フェーズ / ${pomoCycles}サイクル完了`
    : '停止中';
  helpOverlay.classList.remove('open');
  pomoOverlay.classList.add('open');
});

/* ---------- 拡張機能(アドオン) ---------- *
 * theme = CSS差し込み / plugin = JS差し込み / ambient = 環境音の追加。
 * 配布は GitHub Releases の *.addon.zip。アプリ内からワンクリック導入できる。 */
const ADDON_API = 'https://api.github.com/repos/miyazk-dev/musicrepeat/releases?per_page=10';
const ADDON_TYPE_LABEL = { theme: '🎨 テーマ', plugin: '⚙ プラグイン', ambient: '🎧 環境音' };
let addonOverlay = null;
let addonItems = [];        // インストール済み(listAddonsの戻り値)
let addonPluginsDone = false;

async function refreshInstalledAddons() {
  try { addonItems = (await window.api.addonsList()) || []; } catch { addonItems = []; }
  renderInstalledAddons();
}

function renderInstalledAddons() {
  if (!addonOverlay) return;
  const box = addonOverlay.querySelector('#ad-installed');
  if (addonItems.length === 0) {
    box.innerHTML = '<p class="remote-idle">インストール済みの拡張機能はありません</p>';
    return;
  }
  box.innerHTML = addonItems.map((a) => `
    <div class="addon-row">
      <div class="addon-info">
        <b>${a.name}</b><span class="addon-ver">v${a.version || '?'}</span>
        <div class="hint2">${ADDON_TYPE_LABEL[a.type] || a.type}${a.author ? ' / ' + a.author : ''}${a.description ? ' — ' + a.description : ''}</div>
      </div>
      <button class="chip ad-del" data-id="${a.id}">削除</button>
    </div>`).join('');
  for (const b of box.querySelectorAll('.ad-del')) {
    b.addEventListener('click', async () => {
      if (!confirm(`拡張機能「${b.dataset.id}」を削除しますか?`)) return;
      await window.api.addonsRemove(b.dataset.id);
      await refreshInstalledAddons();
      await applyAddons(true);
      populateAddonAmbients();
      toast('拡張機能を削除しました');
    });
  }
}

/* テーマ(<link>)とプラグイン(<script>)の差し込み。起動時と導入後に呼ぶ */
async function applyAddons(reapply) {
  try { addonItems = (await window.api.addonsList()) || []; } catch { return; }
  for (const a of addonItems) {
    if (a.type === 'theme' && a.entry) {
      const old = document.querySelector(`link[data-addon="${a.id}"]`);
      if (old) old.remove();
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `addon://${a.id}/${a.entry}`;
      link.dataset.addon = a.id;
      document.head.appendChild(link);
    }
    // プラグインは起動時の1回だけ(導入後は再起動で有効)
    if (a.type === 'plugin' && a.entry && !addonPluginsDone && !reapply) {
      const s = document.createElement('script');
      s.src = `addon://${a.id}/${a.entry}`;
      s.dataset.addon = a.id;
      document.body.appendChild(s);
    }
  }
  addonPluginsDone = true;
}

/* 環境音セレクトにアドオンの音源を追加する */
function populateAddonAmbients() {
  for (const opt of [...els.ambSel.options]) {
    if (opt.value.startsWith('addon://')) opt.remove();
  }
  for (const a of addonItems) {
    for (const e of (a.ambient || [])) {
      if (!e || !e.file) continue;
      const opt = document.createElement('option');
      const val = `addon://${a.id}/${e.file}`;
      opt.value = val;
      opt.textContent = `🧩 ${e.name || e.file}(${a.name})`;
      els.ambSel.appendChild(opt);
    }
  }
  // 削除済みアドオンの環境音が選ばれていたらリセット
  if (ambientKind.startsWith('addon://') &&
      !els.ambSel.querySelector(`option[value="${CSS.escape(ambientKind)}"]`)) {
    ambientKind = 'none';
    S.set('ambient', 'none');
    els.ambSel.value = 'none';
    els.ambFileRow.classList.add('hidden');
  }
}

/* 配布一覧(GitHub Releasesの *.addon.zip)を取得して表示 */
async function loadAddonMarket() {
  if (!addonOverlay) return;
  const box = addonOverlay.querySelector('#ad-market');
  box.innerHTML = '<p class="remote-idle">読み込み中…</p>';
  let items = [];
  try {
    const res = await fetch(ADDON_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rels = await res.json();
    for (const r of rels) {
      for (const a of (r.assets || [])) {
        if (a.name.endsWith('.addon.zip')) {
          items.push({ url: a.browser_download_url, name: a.name, size: a.size, tag: r.tag_name });
        }
      }
    }
  } catch (e) {
    box.innerHTML = `<p class="remote-idle">一覧を取得できませんでした(${String((e && e.message) || e)})<br>オフライン時は「📁 zipから追加」をご利用ください。</p>`;
    return;
  }
  if (items.length === 0) {
    box.innerHTML = '<p class="remote-idle">配布中の拡張機能はまだありません</p>';
    return;
  }
  box.innerHTML = items.map((it, i) => `
    <div class="addon-row">
      <div class="addon-info">
        <b>${it.name.replace(/\.addon\.zip$/, '')}</b>
        <div class="hint2">${it.tag} ・ ${(it.size / 1024).toFixed(0)} KB</div>
      </div>
      <button class="chip ad-inst" data-i="${i}">インストール</button>
    </div>`).join('');
  for (const b of box.querySelectorAll('.ad-inst')) {
    b.addEventListener('click', async () => {
      const it = items[+b.dataset.i];
      b.disabled = true; b.textContent = '取得中…';
      try {
        const mf = await window.api.addonsInstallUrl(it.url);
        b.textContent = '✓ 完了';
        await refreshInstalledAddons();
        await applyAddons(true);
        populateAddonAmbients();
        if (mf && mf.type === 'plugin') toast(`「${mf.name}」を追加しました(再起動後に有効)`);
        else if (mf) toast(`「${mf.name}」を追加しました`);
      } catch (e) {
        b.disabled = false; b.textContent = 'インストール';
        toast('⚠ ' + String((e && e.message) || e));
      }
    });
  }
}

function buildAddonOverlay() {
  addonOverlay = document.createElement('div');
  addonOverlay.id = 'help-overlay';
  addonOverlay.innerHTML = `
    <div class="help-card">
      <h2>🧩 拡張機能</h2>
      <div class="st-sec-title">📥 配布一覧(GitHub Releases)</div>
      <div id="ad-market" class="addon-list"><p class="remote-idle">—</p></div>
      <div class="sched-actions" style="margin-top:6px">
        <button id="ad-reload" class="chip">🔄 更新</button>
        <button id="ad-local" class="chip">📁 zipから追加</button>
        <button id="ad-folder" class="chip">📂 保存先を開く</button>
      </div>
      <div class="adv-sep"></div>
      <div class="st-sec-title">✅ インストール済み</div>
      <div id="ad-installed" class="addon-list"></div>
      <button class="chip" id="ad-close" style="margin-top:12px">閉じる</button>
    </div>`;
  document.body.appendChild(addonOverlay);
  addonOverlay.addEventListener('click', (e) => {
    if (e.target === addonOverlay) addonOverlay.classList.remove('open');
  });
  addonOverlay.querySelector('#ad-close').addEventListener('click', () =>
    addonOverlay.classList.remove('open'));
  addonOverlay.querySelector('#ad-reload').addEventListener('click', loadAddonMarket);
  addonOverlay.querySelector('#ad-local').addEventListener('click', async () => {
    try {
      const mf = await window.api.addonsInstallZip();
      if (!mf) return;
      await refreshInstalledAddons();
      await applyAddons(true);
      populateAddonAmbients();
      if (mf.type === 'plugin') toast(`「${mf.name}」を追加しました(再起動後に有効)`);
      else toast(`「${mf.name}」を追加しました`);
    } catch (e) {
      toast('⚠ ' + String((e && e.message) || e));
    }
  });
  addonOverlay.querySelector('#ad-folder').addEventListener('click', () =>
    window.api.addonsOpenFolder());
}

els.addons.addEventListener('click', () => {
  if (!addonOverlay) buildAddonOverlay();
  renderInstalledAddons();
  loadAddonMarket();
  helpOverlay.classList.remove('open');
  addonOverlay.classList.add('open');
});

/* ---------- 起動 ---------- */
els.vol.value = vol;
els.calm.value = calm;
els.speed.value = speed * 100;
els.agct.value = agcTarget;
els.eql.value = eq.l; els.eqm.value = eq.m; els.eqh.value = eq.h;
els.eqlVal.textContent = eq.l; els.eqmVal.textContent = eq.m; els.eqhVal.textContent = eq.h;
els.reverb.value = reverbAmt; els.reverbVal.textContent = reverbAmt;
els.pan.value = panAmt; els.panVal.textContent = panAmt === 0 ? '中央' : (panAmt < 0 ? '左' : '右') + Math.abs(panAmt);
els.agctVal.textContent = agcTarget + '%';
els.mono.checked = monoOn;
els.fade.checked = fadeOn;
els.pitchkeep.checked = pitchKeep;
els.agc.checked = S.get('agc', true);
if (shuffleOn) refreshChips();
refreshModeUI();
refreshChips();
refreshSortLabel();

/* 環境音・スケジュール・出力先の復元 */
els.ambSel.value = ambientKind;
els.amb.value = ambientBlend;
els.ambVal.textContent = ambientBlend;
if (ambFile) els.ambFileName.textContent = ambFile.split(/[\\/]/).pop();
els.schedSw.checked = scheduleOn;
if (ctx) applyAmbient();
startScheduleTimer();
pomoLabel();

/* 出力デバイス復元(権限取得後にラベル付き一覧を取得) */
ensureMediaLabels().then(() => refreshOutputs()).then(() => applySink());

/* 拡張機能の復元(環境音の選択肢 → テーマ/プラグインの差し込み) */
window.api.addonsList().then((list) => {
  addonItems = list || [];
  populateAddonAmbients();
  applyAddons(false);
}).catch(() => {});

/* リモコンサーバーの自動再開(前回起動していた場合) */
if (S.get('remoteOn', false)) {
  window.api.remoteStart(S.get('remotePort', 8080), S.get('remoteTls', false)).then((info) => {
    if (info) {
      remoteActive = true;
      lastRemoteInfo = info;
      pushRemoteState();
      pushRemoteTracks();
      toast('📱 リモコンサーバーを自動再開しました(ポート ' + info.port + ')');
    } else {
      S.set('remoteOn', false);
    }
  });
}

const savedFolder = S.get('folder', null);
if (savedFolder) {
  loadFolder(savedFolder, false).then(() => {
    if (files.length) {
      els.title.textContent = '準備完了';
      els.sub.textContent = '再生ボタンで再開できます ・ ' + folder;
    }
  });
}
