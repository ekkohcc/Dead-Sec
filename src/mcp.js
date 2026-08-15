import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const MCP_CONFIG_PATH = path.join(os.homedir(), ".dead-sec", "mcp.json");
const PROTOCOL_VERSION = "2025-03-26";

export function loadMcpConfig() {
  try {
    return JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeMcpConfig(cfg) {
  fs.mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function connectOne(name, serverCfg) {
  return new Promise((resolve) => {
    const child = spawn(serverCfg.command, serverCfg.args || [], {
      env: { ...process.env, ...(serverCfg.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    let nextId = 1;
    let stderr = "";

    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let msg;
      try {
        msg = JSON.parse(t);
      } catch {
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve(msg);
      }
    });

    const request = (method, params, timeoutMs = 15000) =>
      new Promise((resolveReq, rejectReq) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectReq(new Error(`${name}.${method}: timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve: resolveReq, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    const notify = (method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    };

    const close = () => {
      try {
        notify("shutdown");
      } catch {}
      try {
        child.stdin.end();
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 500);
    };

    const fail = (error) => resolve({ name, error, tools: [], request: null, close });

    const timer = setTimeout(() => fail(`handshake timeout`), 10000);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(String(e.message || e));
    });

    request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dead-sec", version: "1.0.0" },
    })
      .then(() => {
        notify("notifications/initialized", {});
        return request("tools/list", {});
      })
      .then((msg) => {
        clearTimeout(timer);
        if (msg.error) return fail(`tools/list error: ${JSON.stringify(msg.error)}`);
        const tools = (msg.result && msg.result.tools) || [];
        resolve({
          name,
          tools: tools.map((t) => ({
            server: name,
            name: t.name,
            description: t.description || "",
            inputSchema: t.inputSchema || {},
          })),
          request,
          close,
        });
      })
      .catch((e) => {
        clearTimeout(timer);
        fail(String(e.message || e));
      });
  });
}

export async function connectServers() {
  const cfg = loadMcpConfig();
  const servers = (cfg && cfg.mcpServers) || {};
  const entries = Object.entries(servers);
  if (!entries.length) return [];
  return Promise.all(
    entries.map(([name, serverCfg]) => {
      if (!serverCfg || !serverCfg.command) {
        return Promise.resolve({ name, error: "missing command", tools: [], request: null, close: () => {} });
      }
      return connectOne(name, serverCfg);
    })
  );
}

export function qualifiedToolName(serverName, toolName) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp_${clean(serverName)}_${clean(toolName)}`;
}

export function findTool(servers, qualified) {
  for (const s of servers) {
    for (const t of s.tools) {
      if (qualifiedToolName(t.server, t.name) === qualified) return { server: s, tool: t };
    }
  }
  return null;
}

export async function callTool(found, args, timeoutMs = 120000) {
  const msg = await found.server.request("tools/call", { name: found.tool.name, arguments: args || {} }, timeoutMs);
  if (msg.error) return `ERROR: ${JSON.stringify(msg.error)}`;
  const content = (msg.result && msg.result.content) || [];
  return content.map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
}

export function describeServers(servers) {
  if (!servers.length) return "未配置 MCP 服务器（~/.dead-sec/mcp.json）";
  return servers
    .map((s) => {
      if (s.error) return `${s.name}: 连接失败 (${s.error})`;
      return `${s.name}: ${s.tools.length} 个工具 (${s.tools.map((t) => t.name).join(", ") || "无"})`;
    })
    .join("\n");
}
