# 🧩 MusicRepeat 拡張機能(アドオン)の作り方 & 配布方法

MusicRepeat は `*.addon.zip` 形式の拡張機能に対応しています。
アプリの **上級者向けタブ → 🧩 拡張機能** パネルから、GitHub Releases に置かれたアドオンをワンクリックでインストールできます。

## アドオンの種類

| type | 動作 | entry |
|---|---|---|
| `theme` | CSS をアプリに差し込む(配色変更など) | `.css` ファイル |
| `plugin` | JS をアプリに差し込む(機能追加) | `.js` ファイル |
| `ambient` | 環境音ミキサーに音源を追加 | `ambient` 配列で音声ファイルを指定 |

## フォルダー構成

```
addons-src/
  my-addon/
    addon.json        ← 必須(マニフェスト)
    theme.css         ← type: theme の場合
```

## addon.json(マニフェスト)

```json
{
  "id": "my-addon",                    // 半角英数と -._ のみ(必須・ユニーク)
  "name": "✨ 拡張機能の名前",
  "version": "1.0.0",
  "type": "theme",                     // theme | plugin | ambient
  "entry": "theme.css",                // theme / plugin の場合に必須
  "author": "あなたの名前",
  "description": "1行の説明"
}
```

`ambient` 型は `entry` の代わりに音源のリストを書きます:

```json
{
  "id": "rain-sounds",
  "name": "🌧 厳選・雨の音",
  "version": "1.0.0",
  "type": "ambient",
  "ambient": [
    { "name": "🌙 夜の雨", "file": "night-rain.mp3" },
    { "name": "☂ 夕立", "file": "shower.mp3" }
  ]
}
```

インストールすると、環境音のセレクトボックスに「🧩 夜の雨(厳選・雨の音)」などが追加されます。

### プラグイン(plugin)で使えるもの

プラグインは renderer のスクリプトとして読み込まれるため、MusicRepeat 本体の関数がそのまま使えます。

- `toast('メッセージ')` — 画面下に通知
- `$(id)` / `document` — 既存UIの操作
- `S.get(k, d)` / `S.set(k, v)` — 設定の読み書き(localStorage)
- `els` — 主要UI要素への参照

※ プラグインを追加・更新した後はアプリの再起動で有効になります。

## 配布方法(GitHub Releases)

1. `addons-src/` にフォルダーを作る
2. zip化してReleasesに上げる:

```bash
node scripts/package-addon.js          # addons-src 全部 → dist/*.addon.zip
npx gh release create v1.0.0 addons/my-addon-v1.0.0.addon.zip
# または既存リリースへ追加
npx gh release upload v1.6.0 dist/my-addon-v1.0.0.addon.zip
```

3. ファイル名の末尾が `.addon.zip` のものだけが、アプリ内パネルの「配布一覧」に表示されます。

## ローカルで試す

アプリの **🧩 拡張機能 → 📁 zipから追加** で zip を選ぶか、`%APPDATA%/MusicRepeat/addons/` 直下にアドオンのフォルダー(中に `addon.json`)を置いて再起動してください。

## セキュリティ

- `plugin` 型はアプリのUIに対して自由に操作できるJSを実行します。**出所を信頼できるアドオンだけ**インストールしてください。
- zip内のファイルは、展開先のフォルダー外(`../` など)を参照できないよう検証しています。
