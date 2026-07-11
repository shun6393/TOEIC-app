# TOEIC-app

## 概要

短期間で目標TOEICスコアを達成するための単語学習アプリ

## バージョン

v1.0.0

## 技術

- HTML
- CSS
- JavaScript
- Local Storage
- Git
- GitHub Pages
- Fetch API

## 公開URL

https://shun6393.github.io/TOEIC-app/

## 実装済み

- Git導入
- GitHub Pages公開
- 標準単語CSV管理
- 起動時CSV自動読み込み
- CSVインポート
- CSVエクスポート
- 学習履歴
- 目標点数設定
- 単語検索
- 約1540語登録済み

## データ構成

### 標準単語
- `toeic-words.csv`で管理
- 起動時に自動読み込み
- 全ユーザー共通

### ユーザーデータ（Local Storage）
- 学習履歴
- アプリ設定
- ユーザー追加単語

## 公開

GitHub Pagesで公開

新規ユーザーはURLを開くだけで約1540語を利用可能。

## 開発環境

### 公開環境
- GitHub Pages

### ローカル実行

開発時はローカルHTTPサーバーを使用する。

例
- VS Code Live Server
- `python -m http.server`

※ `index.html` を `file://` で直接開くと、Fetch APIによる標準単語CSVの自動読み込みが動作しない。

## 今後の予定

- 初回診断
- 出題アルゴリズム改善
- 忘却曲線
- PWA化
- 音声

## 開発ルール

- 設計はChatGPTで行う
- 実装はCodexで行う
- 実装前に設計を確定する
- 機能ごとにコミットする
- 動作確認後にGitHubへPushする
- 実装完了後はCHANGELOGを更新する
- アイデアはIDEASへ追加する

## 開発方針

「まず動くものを作る」ことを優先し、大規模な設計変更は必要になるまで行わない。