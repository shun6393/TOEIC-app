# TOEIC-app

## 概要

短期間で目標TOEICスコアを達成するための単語学習アプリ
chatgpt,codexを活用して作成
## 技術

- HTML
- CSS
- JavaScript
- Local Storage
- Git

## ローカル起動

標準単語は `toeic-words.csv` から `fetch` で読み込むため、`index.html` を直接ダブルクリックせず、ローカルHTTPサーバー経由で開いてください。

例：

```powershell
python -m http.server 8000
```

起動後、ブラウザで `http://localhost:8000/` を開きます。VS CodeのLive Serverも利用できます。外部ライブラリの追加は不要です。

## 実装済み

- Git導入
- CSVインポート
- CSVエクスポート
- 学習履歴
- 目標点数設定
- 単語検索
- 約1540語登録済み

## 今後の予定

- 初回診断
- 出題アルゴリズム改善
- 忘却曲線
- PWA化
- 音声

## 開発ルール

- ChatGPTは設計、仕様検討、レビュー、優先順位の提案を担当する。
- 実装は原則としてCodexで行う。
- ChatGPTは基本的にコードを直接生成せず、Codexへ送るためのプロンプト作成を優先する。
- コードレビューや設計レビューが必要な場合のみコードを扱う。
