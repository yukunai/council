<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**軽量なマルチモデル・ワークフロー・デスクトップアプリ。**
複数の異なる LLM をパイプラインにつなぎ、各ステップが一つの仕事だけをこなす — あるステップの出力が次のステップへと渡されます。

[简体中文](./README.zh.md) · [English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · 日本語 · [한국어](./README.ko.md) · [Tiếng Việt](./README.vi.md) · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · vanilla TypeScript · フロントエンドフレームワークなし

</div>

---

## council とは

`council` は、複数のモデルを線形の**パイプライン**につなぐためのアプリです。各ステップは自分自身の
モデル（ホスト型 API、または Claude Code / Codex のようなローカル CLI）を選び、一つの仕事 — 下書き、推敲、
ファクトチェック、仕上げ — をこなして、その出力を下流へ渡します。さらに、ワンショットの**単一記事**
モード（GEO）も用意されており、完成した記事 + SNS 投稿文を一度のパスで生成できます。インライン
画像生成にも対応しています。

すべてはネイティブのデスクトップアプリとしてローカルで動作します。**API キーはブラウザの
localStorage の中だけに保存され**、あなたが設定したプロバイダのエンドポイント以外へは決して送信されません。

## 機能

- **テキストパイプライン** — 複数のステップを並べ、それぞれに固有のモデルと指示を与えます。上流の
  出力はプレースホルダで参照します： `{{input}}`（最初の入力）、`{{prev}}`（前のステップ）、`{{1}}` `{{2}}` …（ステップ N）。
- **モデルマーケット** — DeepSeek、OpenAI、Gemini、Qwen、Kimi、GLM、xAI Grok、Mistral、
  Volcengine Doubao、Ollama、MiniMax のプリセットを用意。OpenAI 互換の `/chat/completions` エンドポイントなら、
  プロバイダを追加するだけでどれでも利用できます。
- **ローカル CLI ワーカー** — 汎用の `cli_run`（プログラム + 引数 + プロンプト）を介して、ローカルエージェント
  （Claude Code、Codex、Gemini CLI、Grok CLI）をパイプラインのステップとして動かせます。
- **スキルライブラリ** — `~/.council/skills` に置いた再利用可能な `SKILL.md` プロンプトを、ステップごとに
  アタッチできます。ローカルのファイル/フォルダからインポートしたり、git リポジトリと同期（ダウンロード / アップロード）したりできます。
- **単一記事（GEO）モード** — 独立したジェネレータ：タイトル/トピック、任意のルート/場所、
  10 種類の文体、長さスライダー、素材やリファレンス URL の投入、任意のインライン
  画像。編集可能な記事 + 短い SNS 投稿文を出力し、コピーまたは Markdown へエクスポートできます。
- **画像生成** — OpenAI-images スタイルのエンドポイント（例：Volcengine Seedream）によるテキスト・トゥ・イメージ、
  またはローカル CLI ワーカーによる SVG。
- **動画生成** — 非同期のテキスト・トゥ・ビデオ（Volcengine Ark / Seedance）。結果カード内にレンダリングされます。
- **名前付きワークフロー** — パイプライン全体をファイルとして保存 / 読み込み / 削除できます。

## 実行する

必要なもの： [Node.js](https://nodejs.org/) 18+、[Rust](https://rustup.rs/)（stable）、そしてお使いの OS 向けの
[Tauri 2 の前提条件](https://tauri.app/start/prerequisites/)。

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## 使い方

1. 上部バーの **厂商 / 命令 / Key**（プロバイダ / コマンド / キー）を開き、API キーを貼り付けます。
   DeepSeek プロバイダは初期登録済みなので、キーを追加するだけです。その他の OpenAI 互換サービスの場合は、
   クリックしてプロバイダを追加し、その Endpoint を `/chat/completions` まで含めて設定します。
2. 左パネルでパイプラインを組み立てます：各ステップでモデル（またはローカル CLI）と指示を選びます。
3. 指示の中でプレースホルダを使って上流の出力を参照します：
   - `{{input}}` — 一番上の最初の入力
   - `{{prev}}` — 前のステップの出力
   - `{{1}}` `{{2}}` … — ステップ N の出力
4. **▶ 运行（Run）** をクリックします。ステップは上から下へ実行され、右側の結果パネルにストリーミング表示されます。
5. ワンショットの GEO ジェネレータを使うには、上部バーで **单篇（Single-article）** に切り替えます。

## アーキテクチャ

Rust バックエンド（`src-tauri/src/lib.rs`）はわずかな数の Tauri コマンドを公開し、vanilla-TS
フロントエンドがパイプラインを調整して各ステップをストリーミングします。

| Command | 目的 |
| --- | --- |
| `chat_stream` | OpenAI 互換の `/chat/completions`（SSE）。Tauri Channel 経由でデルタをストリーミングする |
| `cli_run` | ローカル CLI ワーカーを実行する（プログラム + 固定引数 + 最後の argv としてのプロンプト） |
| `fetch_url` | Web ページを取得し、読みやすいテキストを抽出する（リファレンス URL の投入用） |
| `image_generate` | テキスト・トゥ・イメージ（OpenAI-images スタイル、画像 URL を返す） |
| `video_generate` | 非同期のテキスト・トゥ・ビデオのタスク API（投入 + ポーリング）。動画 URL を返す |
| `*_workflow` / `*_skill` | ワークフローとスキルの保存 / 読み込み / 一覧 / 削除。スキルの git ダウンロード / アップロード |

- **ストリーミング**： HTTP ワーカーと CLI ワーカーはいずれも、Tauri の
  `Channel<StreamEvent>` を介して増分テキストをフロントエンドへ送ります。フロントエンドはそれらを統一的に扱います。
- **`reqwest`** は `rustls-tls` を使用します（システムの OpenSSL に依存しません）。
- **キー**は localStorage の中だけに保存されます。実行を停止するとフロントエンドはリッスンを止めますが、
  処理中のバックエンド HTTP リクエストはバックグラウンドで完了します。

## ロードマップ

- 単一記事モードのマルチモデル共同執筆（ライター→エディタのチェーン / 比較用の並列バリアント）。
- 円卓討論モード（同じ質問を複数のモデルに、複数ラウンド + 要約）。

## ライセンス

[MIT](./LICENSE)
