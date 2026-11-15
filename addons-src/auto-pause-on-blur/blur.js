/* ⏸ 離席自動一時停止プラグイン */
(() => {
  let wasPlaying = false;
  window.addEventListener('blur', () => {
    // audio はグローバル
    try {
      if (typeof playing !== 'undefined' && playing) { wasPlaying = true; togglePlay(); }
    } catch {}
  });
  window.addEventListener('focus', () => {
    if (wasPlaying) { wasPlaying = false; try { togglePlay(); } catch {} }
  });
})();
