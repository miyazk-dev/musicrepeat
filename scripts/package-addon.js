/* アドオンフォルダーを *.addon.zip にパッケージする
 *   node scripts/package-addon.js [addons-src/<folder> ...]
 * 引数なしで addons-src の全フォルダーを処理する。
 * 出力: dist/<id>-v<version>.addon.zip */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'addons-src');
const OUT = path.join(ROOT, 'dist');

function readManifest(folder) {
  return JSON.parse(fs.readFileSync(path.join(folder, 'addon.json'), 'utf8'));
}

function zip(folder, outZip) {
  // addon.json が zip のルートに来るようにフォルダーの中身を圧縮
  const ps =
    `$d='${folder.replace(/'/g, "''")}';$o='${outZip.replace(/'/g, "''")}';` +
    `if(Test-Path $o){Remove-Item $o -Force};` +
    `Compress-Archive -Path (Join-Path $d '*') -DestinationPath $o -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'inherit',
    windowsHide: true
  });
}

const args = process.argv.slice(2);
const targets = (args.length > 0
  ? args.map((a) => path.resolve(ROOT, a))
  : fs.readdirSync(SRC)
      .map((n) => path.join(SRC, n))
      .filter((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'addon.json'))));

if (targets.length === 0) {
  console.error('アドオンフォルダーが見つかりません(addons-src/<folder>/addon.json を用意してください)');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
for (const t of targets) {
  const mf = readManifest(t);
  const name = `${mf.id}-v${mf.version}.addon.zip`;
  const outZip = path.join(OUT, name);
  zip(t, outZip);
  const size = (fs.statSync(outZip).size / 1024).toFixed(1);
  console.log(`✓ ${name}  (${size} KB)`);
}
console.log(`出力先: ${OUT}`);
