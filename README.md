Codex MCP Wrapper (TypeScript)

MCP Server Wrapper for Codex CLI by addressing the unstable aspects of the Codex CLI MCP Server: This implementation introduces improvements in reliability, error handling, and performance while maintaining compatibility with existing Codex CLI workfl

$1- Codex 単独起動時に表面化しやすいエラー（spawn 失敗、MCP 側の JSON-RPC エラーなど）を、読みやすい一行メッセージ＋標準化データ構造へ正規化します。

マルチサーバー集約（新機能）
- `~/.codex/.mcp.json` に記載された「すべての」MCP サーバーを同時に起動し、1 つの MCP として Codex に見せます。
- Codex からの `tools/list` には、各サーバーのツールを結合して返します（重複名は先勝ち）。
- `tools/call` はツール名で適切な子サーバーへルーティングします（ツール名は変更しません）。
- ツール名は `server_name__tool_name` に付け替えます（例: 子サーバー `serena` の `list_dir` は `serena__list_dir`）。Codex 側でのサーバー名プレフィックスは `mcp__` に統一されるため、最終的なツール名は `mcp__serena__list_dir` になります。
- `MCP_WRAPPER_SERVER_NAME` を設定すると、そのサーバーだけを起動します（従来互換）。

デフォルトの設定読み込み
- 既定では `~/.codex/.mcp.json` を読み込み、そこから MCP サーバーを起動します。
- さらに、カレントディレクトリからファイルシステムのルートまで `.mcp.json` を上方向に探索します（例: リポジトリ直下の `./.mcp.json`）。
- 環境変数 `CODEX_MCP_WRAPPER_CONFIG` で明示的にパスを指定可能です。
- 明示的にサーバーコマンドを渡したい場合は、`--` 以降にコマンドを指定できます（この場合は単一サーバーモード）。

使い方（2通り）
1) パススルー（明示コマンド指定）
- Codex 側の `mcp_servers.<name>` にこのラッパーを設定し、`--` 以降に実サーバーの起動コマンドを渡します。
- 例（Serena をラップする場合／`~/.codex/config.toml`）：

  [mcp_servers.serena]
  command = "npx"
  args = ["-y","tsx","scripts/codex-mcp-wrapper/src/index.ts","--",
           "uvx","--from","git+https://github.com/oraios/serena",
           "serena-mcp-server","--context","ide-assistant","--project","/path/to/project"]

2) 設定ファイルモード（デフォルト）
- ラッパーを `--` なしで起動すると、`~/.codex/.mcp.json`（環境変数 `CODEX_MCP_WRAPPER_CONFIG` で変更可）を読み込みます。
- `MCP_WRAPPER_SERVER_NAME` を指定しない場合、記載されたすべてのサーバーを並列に起動し、ツールを集約します。
- 対応する JSON 形状（ベストエフォート）：
  - { "servers": { "name": { "command", "args", "env" } } }
  - { "mcp_servers": { "name": { "command", "args", "env" } } }（スネークケース）
  - { "mcpServers": { "name": { "command", "args", "env" } } }（キャメルケース）
  - [ { "name?", "command", "args", "env" } ]
  - { "command", "args", "env" }

エラー正規化（Codex向け）
- 変換対象：
  - 子MCPが返す JSON-RPC エラー（特に `tools/call`）
  - 子プロセスの spawn 失敗（例: `ENOENT`）
- 返却形式（JSON-RPC errorの `data` を標準化）：
  - `data.kind`: `tool_error` | `server_error` | `spawn_error`
  - `data.retryable`: true/false
  - `data.toolName` / `data.serverName` / `data.original`
- 代表マッピング：
  - `-32601` → `Method not found`（server_error, retryable:false）
  - `-32602` → `Invalid params`（server_error, retryable:false）
  - `-32603` → `Internal error`（server_error, retryable:true）
  - `-32000..-32099` → `Server error`（retryable は元データを参照）
  - `ENOENT` → `Spawn error`: `command not found. Check PATH or use 'npx tsx ...'`（spawn_error, retryable:false）
- メッセージ整形：
  - ユーザー向けに一行で要約されます。詳細は `data.original` に保持（`DEBUG=1` で参照推奨）。
- トグル：
  - `WRAPPER_ERROR_PASSTHROUGH=1` または `true` で正規化を無効化し、子のエラーをそのまま返します。

なぜ必要か
- Codex CLI の「MCP → OpenAI ツール」変換が `type: "integer"` を受け付けない、あるいは `type` を必須扱いすることがあり、以下のようなエラーを誘発します：
  - `unknown variant "integer", expected one of "boolean", "string", "number", "array", "object"`
  - `missing field "type"`
- 本ラッパーは `tools/list` の応答（ツール定義）だけを正規化し、Codex に読み込ませます。ツール呼び出しのペイロード自体は変更しません。

仕組み
- JSON-RPC 2.0（LSP 互換の Content-Length フレーミング）で stdio を中継します。
- `tools/list` は各サーバーへ並列に問い合わせ、`tools` 配列を結合して 1 つの応答として返します。
- `tools/call` はツール名 → 子プロセスへの対応表でルーティングします。
- 正規化内容：
  - `"integer"` → `"number"`（`type` が配列の場合も含む）
  - `type` 欠落時はヒューリスティックで補完：
    - `enum` があれば先頭要素の型から推定
    - `properties` があれば `object`
    - `items` があれば `array`
    - それ以外は `string`
- `properties` / `items` / `anyOf` / `oneOf` / `allOf` / `$defs` / `definitions` など、スキーマの入れ子を再帰的に処理します。

期待できる効果
- 既知のエラー（`integer` 未対応、`type` 欠落）を吸収し、Codex CLI でツールを読み込めるようにします。
- ツール名は `server_name__tool_name` に統一します。Codex 側のサーバープレフィックスは `mcp__` になるため、最終的に `mcp__{server}__{tool}`（例: `mcp__serena__list_dir`）で呼び出せます。

ログ
- 起動サマリは常時 1 行、標準エラーに出力します（例: `Started 3 child server(s): brave_search, fetch, gcal`）。
  - 抑止したい場合は `WRAPPER_SUMMARY=0` または `WRAPPER_NO_SUMMARY=1` を設定してください。
- デバッグ詳細ログは `DEBUG=1` で有効化され、標準エラーに出力します。
- ツール一覧タイムアウト: `WRAPPER_TOOLS_LIST_TIMEOUT_MS`（既定 4000ms）。応答が遅い子はスキップし、取得できたツールのみを返します。
- 初期化タイムアウト: `WRAPPER_INIT_TIMEOUT_MS`（既定 4000ms）。時間内に子が応答しない場合、最小の capabilities で即時応答します。


トラブルシュート
- `ERR_MODULE_NOT_FOUND` / `ENOENT` などで子サーバー起動に失敗する場合：
  - `npx tsx scripts/codex-mcp-wrapper/src/index.ts` で起動（もしくは `node --loader tsx`）。
  - `PATH` に `tsx`/`uvx`/`python`/`docker` など必要なバイナリがあるか確認。
  - `CODEX_MCP_WRAPPER_CONFIG` が正しい `.mcp.json` を指すか確認。
  - 単一サーバーで検証する場合は `MCP_WRAPPER_SERVER_NAME` を設定。



開発メモ
- ソースは `src/` 配下。実行例：
  - `npx tsx scripts/codex-mcp-wrapper/src/index.ts -- <server> <args...>`
- このラッパーは保守的に設計されており、基本は透過中継です。集約・正規化の対象は `tools/list` と `tools/call` のルーティングおよびエラー整形です。
