Codex MCP Wrapper (TypeScript)

MCP Server Wrapper for the Codex CLI. This wrapper focuses on smoothing over unstable MCP server behaviors to improve reliability, error handling, and performance, while preserving compatibility with existing Codex CLI workflows.

Key improvements
- Normalize common Codex-only failure modes (e.g., spawn failures, JSON‑RPC errors from MCP) into concise one‑line messages with a consistent error data shape.

Multi‑server aggregation
- Launches all MCP servers listed in `~/.codex/.mcp.json` in parallel and presents them to Codex as a single MCP server.
- Answers `tools/list` by merging tools from each server (first match wins on duplicate names).
- Routes `tools/call` to the correct child server based on the tool name.
- Rewrites tool names to `server_name__tool_name` (example: child server `serena` tool `list_dir` becomes `serena__list_dir`). Codex applies the server prefix `mcp__`, so tools appear as `mcp__serena__list_dir`.
- Set `MCP_WRAPPER_SERVER_NAME` to start only the named server (single‑server mode).

Config discovery (defaults)
- Reads `~/.codex/.mcp.json` by default and boots MCP servers from there.
- Also searches upward from the current directory to filesystem root for `.mcp.json` (e.g., a repo‑level `./.mcp.json`).
- You can override the config file path with `CODEX_MCP_WRAPPER_CONFIG`.
- To pass an explicit server command, run this wrapper with `-- <server> <args...>` to use single‑server passthrough mode.

Usage (two modes)
1) Passthrough (explicit command)
- Configure this wrapper under `mcp_servers.<name>` on the Codex side and pass the real server command after `--`.
- Example (wrapping Serena in `~/.codex/config.toml`):

  [mcp_servers.serena]
  command = "npx"
  args = ["-y","tsx","scripts/codex-mcp-wrapper/src/index.ts","--",
           "uvx","--from","git+https://github.com/oraios/serena",
           "serena-mcp-server","--context","ide-assistant","--project","/path/to/project"]

2) Config file mode (default)
- When started without `--`, the wrapper reads `~/.codex/.mcp.json` (override with `CODEX_MCP_WRAPPER_CONFIG`).
- If `MCP_WRAPPER_SERVER_NAME` is not set, it launches all listed servers in parallel and aggregates their tools.
- Accepts the following JSON shapes (best‑effort):
  - { "servers": { "name": { "command", "args", "env" } } }
  - { "mcp_servers": { "name": { "command", "args", "env" } } } (snake_case)
  - { "mcpServers": { "name": { "command", "args", "env" } } } (camelCase)
  - [ { "name?", "command", "args", "env" } ]
  - { "command", "args", "env" }

Error normalization (for Codex)
- Normalizes:
  - JSON‑RPC errors from child MCPs (especially `tools/call`).
  - Child process spawn failures (e.g., `ENOENT`).
- Returns JSON‑RPC errors with a standardized `data` shape:
  - `data.kind`: `tool_error` | `server_error` | `spawn_error`
  - `data.retryable`: true/false
  - `data.toolName` / `data.serverName` / `data.original`
- Representative mappings:
  - `-32601` → `Method not found` (server_error, retryable:false)
  - `-32602` → `Invalid params` (server_error, retryable:false)
  - `-32603` → `Internal error` (server_error, retryable:true)
  - `-32000..-32099` → `Server error` (retryable inferred from original)
  - `ENOENT` → `Spawn error`: `command not found. Check PATH or use 'npx tsx ...'` (spawn_error, retryable:false)
- Message shaping:
  - Produces a one‑line summary suitable for users. Full details are preserved in `data.original` (enable `DEBUG=1` to see logs).
- Toggle:
  - Set `WRAPPER_ERROR_PASSTHROUGH=1` or `true` to disable normalization and return child errors as‑is.

Why this exists
- In Codex CLI, the MCP→OpenAI tools conversion sometimes rejects `type: "integer"` or requires `type`, causing errors like:
  - `unknown variant "integer", expected one of "boolean", "string", "number", "array", "object"`
  - `missing field "type"`
- This wrapper only normalizes the `tools/list` response (tool definitions) so Codex can load them. It does not change the payloads of tool calls.

How it works
- Relays stdio using JSON‑RPC 2.0 (LSP‑compatible Content‑Length framing) and supports NDJSON for robustness.
- For `tools/list`, queries each server in parallel, merges the `tools` arrays, and returns a single response.
- For `tools/call`, routes to the child process mapped from the tool name.
- Normalization includes:
  - `"integer"` → `"number"` (also when `type` is an array/union)
  - When `type` is missing, infer heuristically:
    - If `enum` exists, infer from the first value type
    - If `properties` exists, use `object`
    - If `items` exists, use `array`
    - Otherwise default to `string`
- Recursively traverses nested schema containers: `properties`, `items`, `anyOf`, `oneOf`, `allOf`, `$defs`, `definitions`, etc.

Benefits
- Absorbs known issues (`integer` unsupported, missing `type`) so Codex CLI can load tools.
- Applies a consistent `server_name__tool_name` convention. With Codex’s `mcp__` server prefix, tools are called as `mcp__{server}__{tool}` (e.g., `mcp__serena__list_dir`).

Logging
- Always prints a one‑line startup summary to stderr (example: `Started 3 child server(s): brave_search, fetch, gcal`).
  - To suppress, set `WRAPPER_SUMMARY=0` or `WRAPPER_NO_SUMMARY=1`.
- Detailed debug logs when `DEBUG=1`, printed to stderr.
- `tools/list` timeout: `WRAPPER_TOOLS_LIST_TIMEOUT_MS` (default 4000ms). Slow children are skipped; returns tools from responsive servers.
- `initialize` timeout: `WRAPPER_INIT_TIMEOUT_MS` (default 4000ms). If children do not respond in time, returns minimal capabilities immediately.

Troubleshooting
- If child server startup fails (e.g., `ERR_MODULE_NOT_FOUND` / `ENOENT`):
  - Run via `npx tsx scripts/codex-mcp-wrapper/src/index.ts` (or `node --loader tsx`).
  - Ensure required binaries are on `PATH` (`tsx`/`uvx`/`python`/`docker`, etc.).
  - Verify `CODEX_MCP_WRAPPER_CONFIG` points to a valid `.mcp.json`.
  - To verify a single server, set `MCP_WRAPPER_SERVER_NAME`.

Developer notes
- Sources are under `src/`. Example run:
  - `npx tsx scripts/codex-mcp-wrapper/src/index.ts -- <server> <args...>`
- The wrapper is intentionally conservative; default behavior is pass‑through. Aggregation and normalization apply to `tools/list`, routing and error shaping apply to `tools/call`.
