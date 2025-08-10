# Repository Guidelines

## Communication

- Answer in the language of the user's one

## Project Structure & Modules
- `src/`: TypeScript sources
  - `index.ts`: CLI entry and server orchestration
  - `jsonrpc.ts`: JSON‑RPC framing and transport helpers
  - `schemaFixes.ts`: Tool schema normalization for `tools/list`
- `tsconfig.json`: Strict ESM (ES2020) config
- `package.json`: Scripts (`start`, `dev`) and bin mapping
- User config discovery: `~/.codex/.mcp.json` and nearest `./.mcp.json` up to repo root

## Build, Test, and Dev Commands
- `npm run start`: Run via `tsx` (`src/index.ts`). Reads config; boots one or many MCP servers.
- `npm run dev`: Same as start with `DEBUG=1` for verbose logs.
- Direct run: `npx tsx src/index.ts -- <server> <args...>` (single‑server passthrough).
- Useful env: `CODEX_MCP_WRAPPER_CONFIG=<path>`, `MCP_WRAPPER_SERVER_NAME=<name>`, `WRAPPER_SUMMARY=0`, `WRAPPER_ERROR_PASSTHROUGH=1`.

## Coding Style & Naming
- Language: TypeScript, strict mode on; ESM modules targeting ES2020.
- Indentation: 2 spaces; line width ~100; use trailing commas where natural.
- Filenames: `camelCase.ts` for modules; `index.ts` for entry.
- Patterns: prefer small, pure functions; avoid side effects in module scope; keep logging through stderr.
- Lint/format: No enforced tooling yet—keep style consistent. If using Prettier locally, standard defaults are fine.

## Testing Guidelines
- Framework: Not yet configured. When adding, prefer Vitest or Jest.
- Location: `tests/` with `*.test.ts` (e.g., `tests/schemaFixes.test.ts`).
- Focus: `jsonrpc` framing, schema normalization, routing decisions.
- Target: Fast unit tests; add CLI smoke test that boots a mock server.

## Commit & PR Guidelines
- Commits: Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Keep changes scoped and atomic.
- PRs must include: purpose/impact, linked issue, CLI example (command + expected output), affected env vars/flags, and README/usage updates when behavior changes. Add screenshots of logs when helpful.

## Security & Config Tips
- Do not log secrets; scrub env variables in debug output.
- Changing normalization rules must not alter `tools/call` payloads—only schema for `tools/list` and error shaping.
- Timeouts: tune with `WRAPPER_TOOLS_LIST_TIMEOUT_MS` and `WRAPPER_INIT_TIMEOUT_MS` for slow servers.
