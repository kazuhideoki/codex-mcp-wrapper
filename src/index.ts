#!/usr/bin/env -S node --enable-source-maps
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonRpcStdio } from "./jsonrpc.js";
import { normalizeToolsListResult } from "./schemaFixes.js";

type ServerSpec = {
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type Json = any;

const DEBUG = !!process.env.DEBUG;
const SUMMARY_DISABLED =
  process.env.WRAPPER_SUMMARY === "0" || process.env.WRAPPER_NO_SUMMARY === "1";
const ERROR_PASSTHROUGH =
  process.env.WRAPPER_ERROR_PASSTHROUGH === "1" ||
  process.env.WRAPPER_ERROR_PASSTHROUGH === "true";

function minimalInitializeResult(protocolVersion: string) {
  return {
    serverInfo: { name: "mcp", version: "0.0.0" },
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
    },
  };
}

function logDebug(msg: string) {
  if (DEBUG) process.stderr.write(`[mcp-wrapper] ${msg}\n`);
}

function findServersInConfig(cfg: any): ServerSpec[] {
  const out: ServerSpec[] = [];
  if (!cfg || typeof cfg !== "object") return out;
  // Shape 1: { servers: { name: { command, args, env } } }
  if (cfg.servers && typeof cfg.servers === "object") {
    for (const [name, v] of Object.entries(cfg.servers)) {
      const sv = v as any;
      if (sv && typeof sv === "object" && typeof sv.command === "string") {
        out.push({
          name,
          command: sv.command,
          args: sv.args ?? [],
          env: sv.env ?? {},
        });
      }
    }
  }
  // Shape 1b: { mcp_servers: { name: { command, args, env } } }
  if (cfg.mcp_servers && typeof cfg.mcp_servers === "object") {
    for (const [name, v] of Object.entries(cfg.mcp_servers)) {
      const sv = v as any;
      if (sv && typeof sv === "object" && typeof sv.command === "string") {
        out.push({
          name,
          command: sv.command,
          args: sv.args ?? [],
          env: sv.env ?? {},
        });
      }
    }
  }
  // Shape 1c: { mcpServers: { name: { command, args, env } } } (camelCase)
  if (cfg.mcpServers && typeof cfg.mcpServers === "object") {
    for (const [name, v] of Object.entries(cfg.mcpServers)) {
      const sv = v as any;
      if (sv && typeof sv === "object" && typeof sv.command === "string") {
        out.push({
          name,
          command: sv.command,
          args: sv.args ?? [],
          env: sv.env ?? {},
        });
      }
    }
  }
  // Shape 2: [ { name?, command, args, env } ]
  if (Array.isArray(cfg)) {
    for (const sv of cfg) {
      if (
        sv &&
        typeof sv === "object" &&
        typeof (sv as any).command === "string"
      ) {
        out.push({
          name: (sv as any).name,
          command: (sv as any).command,
          args: (sv as any).args ?? [],
          env: (sv as any).env ?? {},
        });
      }
    }
  }
  // Shape 3: { command, args, env }
  if (typeof (cfg as any).command === "string") {
    const sv = cfg as any;
    out.push({
      name: sv.name,
      command: sv.command,
      args: sv.args ?? [],
      env: sv.env ?? {},
    });
  }
  return out;
}

function discoverServersFromConfig(): ServerSpec[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const envPath = process.env.CODEX_MCP_WRAPPER_CONFIG;
  if (envPath) candidates.push(envPath);
  candidates.push(path.join(os.homedir(), ".codex", ".mcp.json"));
  // Search .mcp.json upwards from CWD to filesystem root
  let dir = process.cwd();
  while (true) {
    candidates.push(path.join(dir, ".mcp.json"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const p of candidates) {
    const cfgPath = path.resolve(p);
    if (seen.has(cfgPath)) continue;
    seen.add(cfgPath);
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const text = fs.readFileSync(cfgPath, "utf8");
      const json = parseJsonWithLeniency(text);
      const servers = findServersInConfig(json);
      if (servers.length === 0) {
        logDebug(
          `No servers found in config ${cfgPath}. Keys: ${Object.keys(json || {}).join(", ")}`,
        );
        continue;
      }
      const desired = process.env.MCP_WRAPPER_SERVER_NAME;
      if (desired) {
        const byName = servers.find((s) => s.name === desired);
        if (byName) return [byName];
        logDebug(
          `Server '${desired}' not found in ${cfgPath}, starting all in this file.`,
        );
      }
      logDebug(`Loaded MCP server definitions from ${cfgPath}`);
      return servers;
    } catch (e) {
      logDebug(`Config read failed from ${cfgPath}: ${String(e)}`);
      continue;
    }
  }
  return [];
}

function parseArgv(): { command?: string; args: string[] } {
  const idx = process.argv.indexOf("--");
  if (idx >= 0) {
    const rest = process.argv.slice(idx + 1);
    if (rest.length > 0) return { command: rest[0], args: rest.slice(1) };
    return { args: [] };
  }
  return { args: [] };
}

function startChildServer(spec: ServerSpec): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...(spec.env || {}) };
  logDebug(
    `Spawning MCP: ${spec.command} ${(spec.args || []).join(" ")}${spec.name ? ` (name=${spec.name})` : ""}`,
  );
  const child = spawn(spec.command, spec.args ?? [], {
    stdio: ["pipe", "pipe", "inherit"],
    env,
  });
  return child;
}

class ChildClient {
  public readonly proc: ChildProcessWithoutNullStreams;
  public readonly name?: string;
  private idSeq = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: any) => void; reject: (e: any) => void; method: string }
  >();
  constructor(spec: ServerSpec) {
    this.name = spec.name;
    this.proc = startChildServer(spec);
    this.proc.on("error", (err) => {
      logDebug(
        `Child '${spec.name || spec.command}' spawn error: ${String(err)}`,
      );
    });

    // Handle incoming messages from child
    new JsonRpcStdio(this.proc.stdout, (msg) => {
      // Responses for our internal requests
      if (
        msg &&
        msg.jsonrpc === "2.0" &&
        msg.id != null &&
        !("method" in msg)
      ) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if ("error" in msg && msg.error) pending.reject(msg.error);
          else pending.resolve(msg.result);
          // Note: do not return here. Allow aggregator to forward
          // responses for forwarded parent requests.
        }
      }
      // Notifications from child -> forward to parent as-is
      if (msg && msg.jsonrpc === "2.0" && msg.method && msg.id == null) {
        process.stdout.write(encodeFrame(msg));
        return;
      }
      // Responses to forwarded parent requests: let aggregator decide elsewhere
      if (msg && msg.jsonrpc === "2.0") {
        // We'll not auto-forward here; the aggregator will forward when appropriate
        aggregatorOnChildMessage(this, msg);
      }
    });
  }

  request(method: string, params?: any, id?: number | string): Promise<any> {
    const useId = id ?? this.idSeq++;
    const msg = { jsonrpc: "2.0", id: useId, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(useId, { resolve, reject, method });
      this.proc.stdin.write(encodeFrame(msg));
    });
  }

  notify(method: string, params?: any) {
    const msg = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(encodeFrame(msg));
  }
}

// Aggregator state
const children: ChildClient[] = [];
const toolToChild = new Map<string, { child: ChildClient; orig: string }>();

function normalizeKey(s: string): string {
  try {
    return String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_");
  } catch {
    return "child";
  }
}
function getChildKey(child: ChildClient): string {
  const raw = child.name || (child.proc?.spawnfile ? path.basename(child.proc.spawnfile) : "child");
  return normalizeKey(raw);
}
const parentIdToForward = new Map<number | string, ChildClient>();
const parentIdToCtx = new Map<
  number | string,
  { method: string; params?: any }
>();

function normalizeError(
  raw: any,
  ctx: { method?: string; toolName?: string; serverName?: string },
) {
  if (ERROR_PASSTHROUGH) return raw?.error ? raw.error : raw;
  const original = raw?.error ? raw.error : raw;
  // Default structure
  let code = typeof original?.code === "number" ? original.code : -32000;
  let message = String(original?.message || "Server error");
  const data: any = { kind: "server_error", retryable: false, original };
  if (ctx.toolName) data.toolName = ctx.toolName;
  if (ctx.serverName) data.serverName = ctx.serverName;

  // Node spawn errors or process-level issues
  if (original?.code && typeof original.code === "string") {
    const scode = original.code as string;
    if (scode === "ENOENT") {
      code = -32001;
      message = `Spawn error (ENOENT): command not found. Check PATH or use 'npx tsx <path-to-index.ts>'.`;
      data.kind = "spawn_error";
      data.retryable = false;
      return { code, message, data };
    }
  }

  // JSON-RPC standard errors
  if (typeof original?.code === "number") {
    const c = original.code as number;
    if (c === -32601) {
      data.kind = "server_error";
      data.retryable = false;
      message = `Method not found${ctx.toolName ? ` for tool '${ctx.toolName}'` : ""}`;
    } else if (c === -32602) {
      data.kind = "server_error";
      data.retryable = false;
      message = `Invalid params${ctx.toolName ? ` for tool '${ctx.toolName}'` : ""}`;
    } else if (c === -32603) {
      data.kind = "server_error";
      data.retryable = true;
      message = `Internal error${ctx.toolName ? ` while calling '${ctx.toolName}'` : ""}`;
    } else if (c <= -32000 && c >= -32099) {
      data.kind = "server_error";
      data.retryable = !!original?.data?.retryable;
    }
  }

  // Tool-level error convention: if child returned data.kind or similar
  if (original?.data && typeof original.data === "object") {
    const od = original.data;
    if (od.kind === "tool_error") {
      data.kind = "tool_error";
      data.retryable = !!od.retryable;
      if (od.message && !message) message = String(od.message);
    }
  }

  // Ensure concise one-line message
  if (!message || message === "[object Object]") message = "Tool/server error";
  return { code, message, data };
}

function aggregatorOnChildMessage(child: ChildClient, msg: Json) {
  // Only forward messages that correspond to forwarded parent requests
  if (msg && msg.jsonrpc === "2.0" && msg.id != null && !("method" in msg)) {
    const pendingChild = parentIdToForward.get(msg.id);
    if (pendingChild && pendingChild === child) {
      // For tools/list we aggregate elsewhere; here forward others
      const ctx = parentIdToCtx.get(msg.id);
      if (ctx?.method === "tools/list") return; // handled separately
      if (ctx?.method === "tools/call") {
        if ("error" in msg && msg.error) {
          const toolName = ctx?.params?.name;
          const normalized = {
            jsonrpc: "2.0",
            id: msg.id,
            error: normalizeError(msg, {
              method: "tools/call",
              toolName,
              serverName: child.name,
            }),
          };
          process.stdout.write(encodeFrame(normalized));
        } else {
          process.stdout.write(encodeFrame(msg));
        }
      } else {
        process.stdout.write(encodeFrame(msg));
      }
      parentIdToForward.delete(msg.id);
      parentIdToCtx.delete(msg.id);
    }
  }
}

async function handleToolsList(parentId: number | string) {
  const results: any[] = [];
  const errors: any[] = [];
  const perChildTimeoutMs = Number(
    process.env.WRAPPER_TOOLS_LIST_TIMEOUT_MS || 4000,
  );
  function withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject({
            code: -32002,
            message: `tools/list timeout after ${perChildTimeoutMs}ms`,
          }),
        perChildTimeoutMs,
      );
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }
  await Promise.all(
    children.map(async (ch) => {
      try {
        const r = await withTimeout(ch.request("tools/list"));
        results.push({ child: ch, result: r });
      } catch (e) {
        errors.push({ child: ch, error: e });
        logDebug(
          `tools/list from '${ch.name || "child"}' failed: ${String(e?.message || e)}`,
        );
      }
    }),
  );
  const merged: any[] = [];
  toolToChild.clear();
  for (const { child, result } of results) {
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    for (const t of tools) {
      if (!t || typeof t !== "object") continue;
      const orig = typeof (t as any).name === "string" ? (t as any).name : undefined;
      if (orig) {
        const childKey = getChildKey(child);
        const newName = `${childKey}__${orig}`;
        if (!toolToChild.has(newName)) {
          toolToChild.set(newName, { child, orig });
          (t as any).name = newName;
          merged.push(t);
        } else {
          logDebug(`Duplicate tool name '${newName}' ignored`);
          // First occurrence wins; skip pushing duplicate into merged
        }
      } else {
        // No valid name; include as-is to avoid data loss
        merged.push(t);
      }
    }
  }
  let payload = { tools: merged } as any;
  payload = normalizeToolsListResult(payload, DEBUG);
  const resp = { jsonrpc: "2.0", id: parentId, result: payload };
  process.stdout.write(encodeFrame(resp));

  if (DEBUG) {
    try {
      const counts = new Map<string, number>();
      for (const { child, result } of results) {
        const n = Array.isArray(result?.tools) ? result.tools.length : 0;
        counts.set(child.name || "child", n);
      }
      const parts = [...counts].map(([k, v]) => `${k}:${v}`).join(", ");
      logDebug(`[tools/list] per-child counts: ${parts}`);
      if (errors.length > 0) {
        for (const { child, error } of errors) {
          const msg = error?.message || String(error);
          logDebug(`tools/list from '${child.name || "child"}' failed: ${msg}`);
        }
      }
    } catch {}
  }
}

async function handleToolsCall(parentMsg: any) {
  const name = parentMsg?.params?.name;
  const parentId = parentMsg?.id;
  const entry = typeof name === "string" ? toolToChild.get(name) : undefined;
  if (!entry) {
    const error = normalizeError(
      { error: { code: -32601, message: `Tool not found: ${String(name)}` } },
      { method: "tools/call", toolName: String(name) },
    );
    const err = { jsonrpc: "2.0", id: parentId, error };
    process.stdout.write(encodeFrame(err));
    return;
  }
  const { child, orig } = entry;
  // Forward to the selected child with the same id
  parentIdToForward.set(parentId, child);
  parentIdToCtx.set(parentId, {
    method: "tools/call",
    params: parentMsg.params,
  });
  const fwdParams = { ...(parentMsg.params || {}), name: orig };
  child.request("tools/call", fwdParams, parentId).catch((e) => {
    const error = normalizeError(e, {
      method: "tools/call",
      toolName: String(name),
      serverName: child.name,
    });
    const err = { jsonrpc: "2.0", id: parentId, error };
    process.stdout.write(encodeFrame(err));
    parentIdToForward.delete(parentId);
    parentIdToCtx.delete(parentId);
  });
}

function main() {
  const { command, args } = parseArgv();
  let specs: ServerSpec[] = [];
  if (command) specs = [{ command, args }];
  else specs = discoverServersFromConfig();
  if (specs.length === 0) {
    logDebug("No MCP servers configured; running with 0 children.");
  }

  for (const spec of specs) {
    const ch = new ChildClient(spec);
    ch.proc.on("exit", (code, signal) => {
      logDebug(
        `Child '${spec.name || spec.command}' exited code=${code} signal=${signal}`,
      );
      // Remove from children
      const idx = children.indexOf(ch);
      if (idx >= 0) children.splice(idx, 1);
      if (children.length === 0) {
        logDebug("All children exited. Exiting wrapper.");
        process.exit(code == null ? 0 : (code as number));
      }
    });
    children.push(ch);
  }
  const summaryLine = `[mcp-wrapper] Started ${children.length} child server(s): ${children
    .map((c) => c.name || c.proc.spawnfile)
    .join(", ")}`;
  if (!SUMMARY_DISABLED) {
    try {
      process.stderr.write(summaryLine + "\n");
    } catch {}
  } else {
    logDebug(summaryLine);
  }

  // Parent -> Aggregator
  new JsonRpcStdio(process.stdin, (msg) => {
    try {
      if (msg && msg.jsonrpc === "2.0" && typeof msg.method === "string") {
        // Record method + params for potential passthrough replies
        if (msg.id != null)
          parentIdToCtx.set(msg.id, { method: msg.method, params: msg.params });
        switch (msg.method) {
          case "initialize": {
            // Broadcast initialize to all children, return first successful result
            // If there are no children, return minimal capabilities immediately.
            if (msg.id == null) return;
            const pver = msg?.params?.protocolVersion || "2024-06-13";
            if (children.length === 0) {
              const resp = { jsonrpc: "2.0", id: msg.id, result: minimalInitializeResult(pver) };
              process.stdout.write(encodeFrame(resp));
              return;
            }
            (async () => {
              const parentId = msg.id;
              const params = msg.params;
              const results: any[] = [];
              const errors: any[] = [];
              const timeoutMs = Number(
                process.env.WRAPPER_INIT_TIMEOUT_MS || 4000,
              );
              let settled = false;
              const onSettle = (fn: () => void) => {
                if (!settled) {
                  settled = true;
                  fn();
                }
              };
              const timer = setTimeout(() => {
                onSettle(() => {
                  const resp = {
                    jsonrpc: "2.0",
                    id: parentId,
                    result: minimalInitializeResult(pver),
                  };
                  process.stdout.write(encodeFrame(resp));
                  logDebug(
                    `initialize: timed out after ${timeoutMs}ms; returned minimal capabilities`,
                  );
                });
              }, timeoutMs);

              try {
                await Promise.all(
                  children.map(async (ch) => {
                    try {
                      const r = await ch.request("initialize", params);
                      results.push({ child: ch, result: r });
                    } catch (e) {
                      errors.push({ child: ch, error: e });
                    }
                  }),
                );
                if (settled) return;
                clearTimeout(timer);
                if (results.length > 0) {
                  onSettle(() => {
                    let result = results[0].result;
                    const protoVer = params?.protocolVersion || pver;
                    if (!result || typeof result !== "object") result = {};
                    if (result.protocolVersion == null)
                      (result as any).protocolVersion = protoVer;
                    if (!(result as any).capabilities)
                      (result as any).capabilities = {};
                    if (!(result as any).capabilities.tools)
                      (result as any).capabilities.tools = { listChanged: false };
                    // Force serverInfo.name to 'mcp' so parent prefixes as 'mcp__'
                    if (!(result as any).serverInfo) (result as any).serverInfo = {};
                    (result as any).serverInfo.name = "mcp";

                    const resp = { jsonrpc: "2.0", id: parentId, result };
                    process.stdout.write(encodeFrame(resp));
                  });
                } else {
                  onSettle(() => {
                    const firstErr = errors[0]?.error ?? {
                      code: -32000,
                      message: "initialize failed",
                    };
                    const normalized = normalizeError(firstErr, {
                      method: "initialize",
                    });
                    const err = {
                      jsonrpc: "2.0",
                      id: parentId,
                      error: normalized,
                    };
                    process.stdout.write(encodeFrame(err));
                  });
                }
              } catch (e) {
                if (settled) return;
                clearTimeout(timer);
                onSettle(() => {
                  const normalized = normalizeError(e, {
                    method: "initialize",
                  });
                  const err = {
                    jsonrpc: "2.0",
                    id: parentId,
                    error: normalized,
                  };
                  process.stdout.write(encodeFrame(err));
                });
              }
            })();
            return;
          }
          case "tools/list": {
            if (msg.id == null) return; // must have id
            handleToolsList(msg.id);
            return;
          }
          case "tools/call": {
            handleToolsCall(msg);
            return;
          }
          default: {
            // Pass-through unknown methods to the first child; if none, acknowledge health checks like 'ping'
            if (msg.id != null && msg.method === "ping") {
              const resp = { jsonrpc: "2.0", id: msg.id, result: { ok: true } };
              process.stdout.write(encodeFrame(resp));
              return;
            }
            const first = children[0];
            if (!first) {
              if (msg.id != null) {
                const err = {
                  jsonrpc: "2.0",
                  id: msg.id,
                  error: {
                    code: -32601,
                    message: `Method not found: ${msg.method}`,
                  },
                };
                process.stdout.write(encodeFrame(err));
              }
              return;
            }
            if (msg.id != null) parentIdToForward.set(msg.id, first);
            first.proc.stdin.write(encodeFrame(msg));
            return;
          }
        }
      }
      // Notifications (no id): broadcast
      if (msg && msg.jsonrpc === "2.0" && msg.method && msg.id == null) {
        for (const ch of children) ch.notify(msg.method, msg.params);
        return;
      }
      // Responses from parent? Typically none; ignore
    } catch (e) {
      logDebug(`Parent->Agg error: ${String(e)}`);
    }
  });
}

function encodeFrame(msg: any): Buffer {
  // NDJSON (newline-delimited JSON) per MCP STDIO transport
  return Buffer.from(JSON.stringify(msg) + "\n", "utf8");
}

function parseJsonWithLeniency(text: string): any {
  // Strip // and /* */ comments, and trailing commas in objects/arrays (best-effort)
  let t = text;
  // Remove /* */ comments
  t = t.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove // comments
  t = t.replace(/^\s*\/\/.*$/gm, "");
  // Remove trailing commas in objects
  t = t.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(t);
}

main();
