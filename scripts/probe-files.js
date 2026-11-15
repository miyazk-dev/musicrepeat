/* ffmpeg -i で3曲の実フォーマットを確認 */
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const DIR = '\\\\Laptop-cfupdljp\\保存用共有フォルダー\\$allfile\\Disney作業bgm';

(async () => {
  for (const name of fs.readdirSync(DIR)) {
    const src = path.join(DIR, name);
    const tmp = path.join(os.tmpdir(), 'mr-probe' + path.extname(name));
    fs.copyFileSync(src, tmp);
    await new Promise((resolve) => {
      const ff = spawn(path.join(__dirname, '..', 'bin', 'ffmpeg.exe'), ['-hide_banner', '-i', tmp], { windowsHide: true });
      let err = '';
      ff.stderr.on('data', (c) => err += c);
      ff.on('close', () => {
        const lines = err.split(/\r?\n/).filter((l) => /Stream|Duration|Audio/.test(l));
        console.log('===', name, '===');
        console.log(lines.join('\n'));
        fs.unlinkSync(tmp);
        resolve();
      });
    });
  }
})();
