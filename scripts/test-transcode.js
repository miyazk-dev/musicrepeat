/* 変換パイプライン再現テスト: node scripts/test-transcode.js
 * 対象ファイルをローカルにコピー → ffmpegでmp3変換 → 成否と所要時間を表示 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = '\\\\Laptop-cfupdljp\\保存用共有フォルダー\\$allfile\\Disney作業bgm';
const FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(DIR).map((n) => path.join(DIR, n));

function transcode(src) {
  return new Promise((resolve) => {
    const tmpIn = path.join(os.tmpdir(), `mr-in-${Date.now()}${path.extname(src)}`);
    const tmpOut = path.join(os.tmpdir(), `mr-out-${Date.now()}.mp3`);
    console.time('copy ' + path.basename(src));
    let data;
    try { data = fs.readFileSync(src); } catch (e) { resolve('READ FAIL: ' + e.message); return; }
    fs.writeFileSync(tmpIn, data);
    console.timeEnd('copy ' + path.basename(src));
    console.log('  bytes:', data.length);
    console.time('ffmpeg');
    const ff = spawn(path.join(__dirname, '..', 'bin', 'ffmpeg.exe'), [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', tmpIn, '-vn', '-ac', '2',
      '-codec:a', 'libmp3lame', '-b:a', '192k',
      '-y', tmpOut
    ], { windowsHide: true });
    let err = '';
    ff.stderr.on('data', (c) => err += c);
    ff.on('error', (e) => { console.log('spawn error', e.message); resolve('SPAWN FAIL'); });
    ff.on('close', async (code) => {
      console.timeEnd('ffmpeg');
      let size = 0;
      try { size = fs.statSync(tmpOut).size; } catch {}
      fs.unlinkSync(tmpIn);
      if (code === 0 && size) { fs.unlinkSync(tmpOut); resolve('OK mp3=' + (size / 1e6).toFixed(1) + 'MB'); }
      else resolve('FFMPEG FAIL exit=' + code + ' stderr=' + err.trim().slice(-300));
    });
  });
}

(async () => {
  for (const f of FILES) {
    console.log('===', path.basename(f), '===');
    console.log(await transcode(f));
  }
})();
