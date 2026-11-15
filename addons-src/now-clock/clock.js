/* 🕐 デスククロック — 画面右下に現在時刻を常時表示するプラグイン */
(() => {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed', 'bottom:8px', 'right:14px', 'z-index:60',
    'font-size:11px', 'letter-spacing:.08em',
    'color:var(--text-dim)', 'pointer-events:none', 'user-select:none'
  ].join(';');
  document.body.appendChild(el);
  const tick = () => {
    const d = new Date();
    el.textContent = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' }) +
      ' ' + d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 5000);
})();
