# LetsPlayQuiz

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

[LetsPlayQuiz](https://letsplayquiz.net) は、リンク1つで友だちがスマホで遊べるクイズを作れるサービスです。このリポジトリには公開 API まわりのツールが入っていて、AI エージェント(とあなた)がターミナルからクイズを作って公開できます。

- **`letsplayquiz`** (`packages/cli`): コマンドラインクライアント
- **`lpqz`** (`packages/lpqz`): 同じ CLI を実行する短い別名パッケージ (`npx lpqz ...`)
- **`skills/letsplayquiz`**: CLI を使ってあなたと一緒にクイズを設計する Claude スキル
- **[`docs/api.md`](docs/api.md)**: 公開 HTTP API v1 の仕様 (英語)

作れる種類:

| 種類 | `kind` | 参加者が得るもの |
|---|---|---|
| スコア型 | `score` | 4択の正解ありクイズ、スコアが出る |
| タイプ診断 | `type` | 正解なし、選択が集計されて「あなたは___タイプ」と出る |
| バランス | `balance` | 2択を選ぶ、みんなの選択も見られる |
| トーナメント | `worldcup` | 候補8個または16個が1対1で戦い、優勝を決める |

クイズの作成にログインは不要です。公開すると、遊ぶためのリンクと秘密のオーナー(ダッシュボード)リンクが返ります。

> LetsPlayQuiz の Web アプリ本体はオープンソースでは**ありません**。このリポジトリの CLI、別名パッケージ、スキル、API ドキュメントのみ MIT で公開しています。

## CLI

Node.js 20 以上が必要です。インストール不要で使えます。

```sh
npx letsplayquiz guide --kind balance   # 種類ごとのルールと完成例
npx letsplayquiz validate test.json     # 保存せずに検査
npx letsplayquiz publish test.json      # 検査してから公開
npx letsplayquiz list                   # このコンピューターで公開したテスト
```

短く書くなら別名 `npx lpqz guide` です。ファイル名の代わりに `-` を渡すと標準入力から JSON を読みます。

| コマンド | 説明 |
|---|---|
| `guide [--kind score\|type\|balance\|worldcup]` | ガイドを出力 (`--kind` 省略で全部) |
| `validate <file \| ->` | 保存せずに検査のみ |
| `publish <file \| ->` | 検査を通れば公開 |
| `list` | このコンピューターで公開したテストを新しい順に表示 (サーバーは呼ばない) |

| オプション | 説明 |
|---|---|
| `--json` | サーバーの応答 (または `list` の記録) をそのまま出力 |
| `--lang ko\|ja\|en` | サーバーメッセージの言語 (クエリ `lang`)、既定は `ko` |
| `--api <url>` | サーバーの URL。`https` のみ可 (ローカル開発は `http://localhost`、`http://127.0.0.1` が例外)。環境変数 `LETSPLAYQUIZ_API` でも指定可 (フラグが優先)。既定値 `https://letsplayquiz.net` |
| `--no-save` | `publish` の結果をローカルに記録しない |
| `--help`, `--version` | ヘルプ / バージョン |

終了コード: `0` 成功、`1` 検査失敗、`2` 使い方の誤り、`3` リクエスト制限、`4` ネットワーク・サーバーエラー(公開されていない)、`5` 公開結果が不明(すぐ再試行しない)。詳細は [`packages/cli/README.md`](packages/cli/README.md) (韓国語) を参照してください。

`publish` は秘密のオーナーリンクを含む結果を `~/.config/letsplayquiz/tests.jsonl` (`XDG_CONFIG_HOME` があればその下) に制限付きの権限で記録し、画面にも出力します。オーナーリンクは再発行できないので秘密として扱い、CI のログへの露出に注意してください。

## MCP サーバー

`letsplayquiz-mcp` は、シェルの代わりに MCP を使うエージェント向けのローカル [MCP](https://modelcontextprotocol.io) (stdio) サーバーです。ツールは `get_guide`、`validate_quiz`、`publish_quiz`、`list_my_quizzes` で、CLI と同じロジックと履歴ファイルを使います。

```sh
claude mcp add letsplayquiz -- npx -y letsplayquiz-mcp
```

Claude Desktop・Cursor の設定と `LETSPLAYQUIZ_API` の上書き方法は [`packages/mcp/README.md`](packages/mcp/README.md) (英語) にあります。`publish_quiz` は公開クイズを発行するため、エージェントは先にユーザーへ確認する必要があります。

## Claude スキル

`skills/letsplayquiz` は、簡単に質問してからクイズ JSON を書き、検査し、確認を取って公開する [Agent Skill](https://agentskills.io) です。

**Claude Code**(プラグインマーケットプレイス):

```sh
claude plugin marketplace add letsplayquiz/letsplayquiz
claude plugin install letsplayquiz@letsplayquiz
```

セッション内では `/plugin marketplace add letsplayquiz/letsplayquiz`、`/plugin install letsplayquiz@letsplayquiz` でも使えます。

**ほかのエージェント**(Codex、Cursor、GitHub Copilot、Gemini CLI など。オープンなインストーラー [`skills`](https://www.npmjs.com/package/skills) を使います):

```sh
npx skills add letsplayquiz/letsplayquiz
```

**Claude.ai / Claude デスクトップアプリ**: `skills/letsplayquiz` フォルダを ZIP にして、Claude の設定からスキルとしてアップロードします。

そのあと「ラーメンのバランスゲームを作って」のように頼めば使えます。

## API

CLI は公開 HTTP API の薄いクライアントです。直接呼び出したい場合は [`docs/api.md`](docs/api.md) を参照してください。

## コントリビュート

Issue とプルリクエストを歓迎します。開発には pnpm を使います (`package.json` の `packageManager` を参照)。

```sh
pnpm install
pnpm test     # vitest
pnpm build    # パッケージをビルド
pnpm smoke    # ビルド後、ローカルのモックサーバーでビルド済み CLI を実行
```

クイズのルールはすべてサーバーが持ちます。CLI でルールを重複させたり回避したりしないでください。変更は小さく、挙動が変わるときはテストも追加してください。

## ライセンス

[MIT](LICENSE) © 2026 swewpapa
