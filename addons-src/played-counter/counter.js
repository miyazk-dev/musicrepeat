/* 🔢 再生回数カウンター — 再生した曲数を表示 */
(() => {
  let count = 0;
  try { count = parseInt(localStorage.getItem('mr_playedCount') || '0', 10) || 0; } catch {}
  const badge = document.createElement('span');
  badge.style.cssText = 'margin-left:8px;font-size:11px;color:var(--text-dim);font-variant-numeric:tabular-nums;';
  badge.textContent = `♪ ${count}`;
  const brand = document.querySelector('.brand');
  if (brand) brand.appendChild(badge);
  // audio の play イベントを監視
  const audio = document.querySelector('audio');
  if (audio) {
    audio.addEventListener('play', () => {
      count++;
      badge.textContent = `♪ ${count}`;
      try { localStorage.setItem('mr_playedCount', String(count)); } catch {}
    });
  }
})();
