import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const WORKSPACE = process.cwd();
export const DELIVERABLES = path.join(WORKSPACE, ".dead-sec", "deliverables");
export const POCS = path.join(WORKSPACE, ".dead-sec", "pocs");
const MAX_OUT = 8000;

function clip(s) {
  s = String(s);
  if (s.length <= MAX_OUT) return s;
  return s.slice(0, MAX_OUT) + `\n...[truncated ${s.length - MAX_OUT} chars]`;
}

function run(cmd, timeout) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: WORKSPACE, timeout: timeout * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) {
        resolve(`TIMEOUT after ${timeout}s (command: ${cmd})`);
        return;
      }
      let out = `exit=${err ? err.code ?? -1 : 0}\n` + (stdout || "");
      if (stderr) out += "\n[stderr]\n" + stderr;
      resolve(clip(out.trim()));
    });
  });
}

export function runCommand(cmd, timeout = 60) {
  return run(cmd, timeout);
}

export function readFile(p) {
  const target = path.isAbsolute(p) ? p : path.join(WORKSPACE, p);
  return new Promise((resolve) => {
    fs.readFile(target, "utf8", (err, data) => {
      if (err) return resolve(`ERROR: ${err.message}`);
      resolve(clip(data));
    });
  });
}

export function searchFiles(pattern, dir = ".") {
  return new Promise((resolve) => {
    const target = path.isAbsolute(dir) ? dir : path.join(WORKSPACE, dir);
    const rg = `rg -n ${JSON.stringify(pattern)} "${target}" --max-columns 300 -g '!*.min.js' -g '!node_modules' -g '!.git'`;
    exec(rg, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && stdout) {
        return resolve(clip(stdout.trim()));
      }
      if (err && /not found/i.test(stderr || "")) {
        const gr = `grep -rn ${JSON.stringify(pattern)} "${target}"`;
        return exec(gr, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (e2, out2, err2) => {
          resolve(clip((out2 || "").trim() || (e2 ? "no matches" : "")));
        });
      }
      resolve(clip((stdout || stderr || "no matches").trim()));
    });
  });
}

export async function fetchUrl(url, timeout = 20) {
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeout * 1000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const text = await resp.text();
    return clip(`[status=${resp.status}]\n` + text);
  } catch (e) {
    return "ERROR: " + e.message;
  }
}

const DELIVERABLE_NAMES = {
  PRE_RECON: "pre_recon.md",
  RECON: "recon.md",
  INJECTION_ANALYSIS: "injection_analysis.md",
  XSS_ANALYSIS: "xss_analysis.md",
  AUTH_ANALYSIS: "auth_analysis.md",
  SSRF_ANALYSIS: "ssrf_analysis.md",
  AUTHZ_ANALYSIS: "authz_analysis.md",
  EXPLOITATION_EVIDENCE: "exploitation_evidence.md",
  REPORT: "report.md",
};

export function saveDeliverable(type, content) {
  fs.mkdirSync(DELIVERABLES, { recursive: true });
  const name = DELIVERABLE_NAMES[type] || type.toLowerCase() + ".md";
  const target = path.join(DELIVERABLES, name);
  fs.writeFileSync(target, String(content));
  return `saved ${target}`;
}

const POC_EXT = {
  python: "py",
  bash: "sh",
  curl: "sh",
  http: "http",
  javascript: "js",
  node: "js",
};

export function savePoc(id, language, content) {
  fs.mkdirSync(POCS, { recursive: true });
  const ext = POC_EXT[String(language || "").toLowerCase()] || "txt";
  const name = `poc_${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}.${ext}`;
  const target = path.join(POCS, name);
  fs.writeFileSync(target, String(content));
  return `saved ${target}`;
}

export const TOOLS = [
  {
    name: "run_command",
    description: "Run a shell command (nmap, curl, python scripts, etc.) on the scan machine. Use for network scanning, HTTP requests, and exploit payloads.",
    tool_input: { cmd: "shell command to run" },
  },
  {
    name: "read_file",
    description: "Read a file from the target repository (for whitebox analysis).",
    tool_input: { path: "file path, absolute or relative" },
  },
  {
    name: "search_files",
    description: "Grep for a pattern across the repository (secrets, endpoints, sinks).",
    tool_input: { pattern: "regex pattern", path: "directory (default '.')" },
  },
  {
    name: "fetch_url",
    description: "Fetch a URL over HTTP(S). Use to probe the live target.",
    tool_input: { url: "full URL" },
  },
  {
    name: "save_deliverable",
    description: "Persist phase findings. Call this at the end of each phase.",
    tool_input: {
      type: "PRE_RECON|RECON|INJECTION_ANALYSIS|XSS_ANALYSIS|AUTH_ANALYSIS|SSRF_ANALYSIS|AUTHZ_ANALYSIS|EXPLOITATION_EVIDENCE|REPORT",
      content: "markdown or JSON content",
    },
  },
  {
    name: "save_poc",
    description: "Save a complete, runnable Proof-of-Concept script for a validated vulnerability into .dead-sec/pocs/. Use in the EXPLOITATION phase.",
    tool_input: {
      id: "unique id like DS-001-sql-login-bypass",
      language: "python | bash | curl | javascript",
      content: "self-contained PoC script (with target URL, payloads, expected output)",
    },
  },
];

const HANDLERS = {
  run_command: (a) => runCommand(a.cmd || "", a.timeout),
  read_file: (a) => readFile(a.path || ""),
  search_files: (a) => searchFiles(a.pattern || "", a.path || "."),
  fetch_url: (a) => fetchUrl(a.url || ""),
  save_deliverable: (a) => saveDeliverable(a.type || "", a.content || ""),
  save_poc: (a) => savePoc(a.id || "poc", a.language || "bash", a.content || ""),
};

export function dispatch(name, args) {
  const fn = HANDLERS[name];
  if (!fn) return `UNKNOWN TOOL: ${name}`;
  return fn(args || {});
}
