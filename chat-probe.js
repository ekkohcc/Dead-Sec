import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import blessed from "blessed";

import { load } from "./config.js";
import { chatTurn } from "./agent.js";
import { displaySkills, getSkill } from "./skills.js";
import { connectServers } from "./mcp.js";
import { initConnectors } from "./connectors/index.js";
import { startPlanner, listPlans } from "./plan.js";
import { appendSession, loadSessions, sessionCount, loadProfile, saveProfile, learn, buildMemoryBlock, listSessions, renameSession, loadSessionMessages, setSessionId } from "./memory.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  user: "\x1b[38;5;114m",
  tool: "\x1b[38;5;243m",
  cmd: "\x1b[38;5;117m",
  err: "\x1b[38;5;203m",
  ok: "\x1b[38;5;114m",
  warn: "\x1b[38;5;214m",
  purple: "\x1b[38;5;141m",
  sel: "\x1b[38;5;0;48;5;208m",
};

const HISTORY_FILE =
  process.env.DEAD_SEC_HISTORY || `${process.env.HOME || process.env.USERPROFILE}/.dead-sec/history`;

const HELP = `${C.cmd}/help${C.reset} 显示帮助
${C.cmd}/clear${C.reset} 清屏
${C.cmd}/target <url>${C.reset} 设定本次会话的目标（会注入上下文）
${C.cmd}/skills${C.reset} 列出已安装的自定义 skill
${C.cmd}/use <skill>${C.reset} 立即注入某个 skill 到上下文
${C.cmd}/model <name>${C.reset} 切换模型（如 /model deepseek-chat），标题实时更新
${C.cmd}/session${C.reset} 查看历史对话记忆（/session 100 显示更多）
${C.cmd}/usage${C.reset} 显示本会话 token 使用统计（每次回复后也会实时显示）
${C.cmd}/mcp${C.reset} 列出已连接的 MCP 服务器与其工具
${C.cmd}/plan${C.reset} 列出计划模式中的定时任务
${C.cmd}/quit${C.reset} 或 Ctrl+C 退出（多行输入 Ctrl+C 先放弃当前行）`;

const CMD_DEFS = [
  ["help", "显示帮助"],
  ["clear", "清屏"],
  ["target <url>", "设定本次会话的目标"],
  ["skills", "列出已安装的 skill"],
  ["use <skill>", "注入 skill 到上下文"],
  ["model <name>", "切换模型并刷新标题"],
  ["session", "查看历史对话记忆"],
  ["usage", "token 使用统计"],
  ["mcp", "列出 MCP 服务器与工具"],
  ["plan", "列出定时任务"],
  ["quit", "退出或 Ctrl+C"],
];

// 会话自动命名: 当前会话无标题时, 取用户提问前 18 个可见字符作为标题（持久化到 sessions.jsonl）
const autoTitleSession = (text) => {
  if (!tui) return; // 仅交互会话下命名; 管道模式下每次输入都未命名
  try {
    const sid = getSessionId();
    if (!sid) return;
    const cur = listSessions().find((s) => s.sessionId === sid);
    if (cur && cur.title) return;
    const t = String(text).replace(/\s+/g, " ").trim().replace(/^\/\S+/, "").trim();
    if (!t) return;
    renameSession(sid, t.length > 18 ? `${t.slice(0, 18)}…` : t);
  } catch {}
};

// ASCII banner "Dead-Sec"（figlet Standard，Dead=橙 / -Sec=红 两段渐变，与 DEAD-SEC 同款字体效果）
const BANNER = [
  "  \x1b[1m\x1b[38;5;214m ____                 _ \x1b[0m    \x1b[1m\x1b[38;5;196m      ____            \x1b[0m",
  "  \x1b[1m\x1b[38;5;214m|  _ \\  ___  __ _  __| |\x1b[0m    \x1b[1m\x1b[38;5;196m     / ___|  ___  ___ \x1b[0m",
  "  \x1b[1m\x1b[38;5;214m| | | |/ _ \\/ _` |/ _` |\x1b[0m    \x1b[1m\x1b[38;5;196m ____\\___ \\ / _ \\/ __|\x1b[0m",
  "  \x1b[1m\x1b[38;5;214m| |_| |  __/ (_| | (_| |\x1b[0m    \x1b[1m\x1b[38;5;196m|_____|__) |  __/ (__ \x1b[0m",
  "  \x1b[1m\x1b[38;5;214m|____/ \\___|\\__,_|\\__,_|\x1b[0m    \x1b[1m\x1b[38;5;196m     |____/ \\___|\\___|\x1b[0m",
];

// ---- 对话框式 UI ----
const BOX_W = 76;

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function dispWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    w += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  }
  return w;
}

function padTo(s, w) {
  const gap = w - dispWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

function bLine(s) {
  return `  ${C.warn}│${C.reset} ${padTo(String(s), BOX_W - 2)} ${C.warn}│${C.reset}`;
}

function bTop(title) {
  const t = ` ${C.ok}Dead-Sec${C.reset} ─ ${title} `;
  const pad = Math.max(0, BOX_W - dispWidth(t));
  return `  ${C.warn}┌${C.reset}${t}${C.warn}${"─".repeat(pad)}┐${C.reset}`;
}

function bBottom() {
  return `  ${C.warn}└${C.reset}${C.warn}${"─".repeat(BOX_W - 1)}┘${C.reset}`;
}

function bWrite(s) {
  process.stdout.write(s + "\n");
}

// ---- blessed 全屏 TUI 层（TTY 模式）----
let tui = null; // { screen, chatBox, statusBar, header, input, banner }

// 标准 16 色 + 亮色：SGR 码 → hex
const SGR_BASE = {
  "30": "#000000", "31": "#800000", "32": "#008000", "33": "#808000",
  "34": "#000080", "35": "#800080", "36": "#008080", "37": "#c0c0c0",
  "90": "#808080", "91": "#ff0000", "92": "#00ff00", "93": "#ffff00",
  "94": "#0000ff", "95": "#ff00ff", "96": "#00ffff", "97": "#ffffff",
  "40": "#000000", "41": "#800000", "42": "#008000", "43": "#808000",
  "44": "#000080", "45": "#800080", "46": "#008080", "47": "#c0c0c0",
  "100": "#808080", "101": "#ff0000", "102": "#00ff00", "103": "#ffff00",
  "104": "#0000ff", "105": "#ff00ff", "106": "#00ffff", "107": "#ffffff",
};

// ANSI 8-bit 色 → blessed tags 色（标准 16 色 + 程序化 256 色）
const ANSI_TAG = (() => {
  const map = Object.assign({}, SGR_BASE);
  const base = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080",
    "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00",
    "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ];
  for (let i = 0; i < 16; i++) {
    map[`38;5;${i}`] = base[i];
    map[`48;5;${i}`] = base[i];
  }
  for (let i = 16; i < 232; i++) {
    const c = i - 16;
    const r = (c / 36 | 0) ? (55 + 40 * (c / 36 | 0)) : 0;
    const g = ((c / 6 | 0) % 6) ? (55 + 40 * ((c / 6 | 0) % 6)) : 0;
    const b = (c % 6) ? (55 + 40 * (c % 6)) : 0;
    const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    map[`38;5;${i}`] = hex;
    map[`48;5;${i}`] = hex;
  }
  for (let i = 232; i < 256; i++) {
    const v = 8 + 10 * (i - 232);
    const hex = "#" + [v, v, v].map((x) => x.toString(16).padStart(2, "0")).join("");
    map[`38;5;${i}`] = hex;
    map[`48;5;${i}`] = hex;
  }
  return map;
})();

// 剥离游离/非颜色 ANSI 控制序列（光标移动、擦除、显隐等），否则 blessed 会渲染成乱码
function stripCtlAnsi(s) {
  return String(s)
    // 剥掉非 SGR（非 m 结尾）的控制序列，保留颜色序列交给 ansiToTags
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, (m) => (m.endsWith("m") ? m : ""))
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[>=]/g, "")
    .replace(/\r/g, "");
}

// 裸花括号 → blessed 转义。单次遍历，避免 {open} 里的 } 被二次替换
function escapeBraces(s) {
  return String(s).replace(/[{}]/g, (c) => (c === "{" ? "{open}" : "{close}"));
}

// 把行内 ANSI 转义序列转成 blessed 的 {color-fg} 标签
function ansiToTags(s) {
  return stripCtlAnsi(String(s)).replace(/\x1b\[([0-9;]*)m/g, (m, code) => {
    // 真彩色 38;2;R;G;B / 48;2;R;G;B
    let tc = /^(38|48);2;(\d+);(\d+);(\d+)$/.exec(code);
    if (tc) {
      const hex = "#" + [tc[2], tc[3], tc[4]].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
      return tc[1] === "48" ? `{${hex}-bg}` : `{${hex}-fg}`;
    }
    if (!code || code === "0") return "{/}";
    const parts = code.split(";");
    if (parts.includes("1")) {
      const rest = parts.filter((p) => p !== "1").join(";");
      if (rest && ANSI_TAG[rest]) return `{bold}{${ANSI_TAG[rest]}-fg}`;
      return "{bold}";
    }
    if (parts.includes("2")) {
      const rest = parts.filter((p) => p !== "2").join(";");
      if (rest && ANSI_TAG[rest]) return `{dim}{${ANSI_TAG[rest]}-fg}`;
      return "{dim}";
    }
    if (code.startsWith("38;5;") || code.startsWith("48;5;")) {
      const isBg = code.startsWith("48;5;");
      return ANSI_TAG[code] ? `{${ANSI_TAG[code]}-${isBg ? "bg" : "fg"}}` : "{/}";
    }
    if (ANSI_TAG[code]) {
      const n = Number(code);
      const isBg = (n >= 40 && n <= 47) || (n >= 100 && n <= 107);
      return `{${ANSI_TAG[code]}-${isBg ? "bg" : "fg"}}`;
    }
    return "{/}";
  });
}

// 转义会破坏布局/标签解析的特殊字符: < > & * _ [ ]
function escapeSpecials(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

// 外部命令/工具输出清洗: 剥 OSC/CSI/ANSI 转义序列、HTML 标签、控制字符(ASCII 0-31, 保留 \n\t),
// 只保留可打印的纯文本
function cleanExternal(text) {
  const s = String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r/g, "");
  return escapeSpecials(escapeBraces(s));
}

// 完整清洗：控制序列 → 特殊字符转义 → 花括号转义 → 颜色标签。顺序不能反（转义会污染标签）
function sanitizeTui(text) {
  const cleaned = stripCtlAnsi(text);
  return ansiToTags(escapeSpecials(escapeBraces(cleaned)));
}

// 把内容追加到聊天区（TUI 模式）或 stdout（普通模式）
function uiOut(text, quietMode) {
  if (quietMode) {
    process.stdout.write(text + "\n");
    return;
  }
  if (tui && tui.chatBox) {
    const clean = sanitizeTui(String(text));
    appendChatLine(clean);
    return;
  }
  process.stdout.write(String(text) + "\n");
}

// ---- 聊天区渲染: 所有显示行存 chatLines 数组, 每次更新清空聊天区后全量 setContent 覆盖重绘 ----
let chatLines = []; // 最终显示行(含 blessed tags)缓存
let kbSelStart = -1; // 键盘选中起始行索引(chatLines), -1=无
let kbSelEnd = -1; // 键盘选中结束行索引

function renderChat() {
  if (!tui || !tui.chatBox) return;
  let lines = chatLines;
  if (kbSelStart >= 0 && kbSelEnd >= kbSelStart) {
    // 键盘选区高亮: 逐行独立包裹 bg 标签（blessed tags 不跨行）
    lines = chatLines.map((l, i) =>
      i >= kbSelStart && i <= kbSelEnd ? `{#3a3a6e-bg}${l}{/}` : l
    );
  }
  tui.chatBox.setContent(lines.join("\n"));
  tui.chatBox.setScrollPerc(100);
  tui.screen.render();
}

const MAX_LINE_CHARS = 2000; // 超长文本显示前截断阈值

function appendChatLine(line) {
  let l = String(line);
  if (l.length > MAX_LINE_CHARS) l = l.slice(0, MAX_LINE_CHARS) + "… (截断)";
  chatLines.push(l);
  if (chatLines.length > 5000) chatLines = chatLines.slice(-5000); // 长会话防膨胀
  renderChat();
}

// 渲染顶部状态横幅 (2行): Dead-Sec │ 模型 │ 目录 │ 工具 │ 技能
function renderBanner() {
  if (!tui) return;
  const cwd = process.cwd().replace(os.homedir(), "~");
  const tools = tui.toolCount ?? 0;
  const skills = tui.skillCount ?? 0;
  tui.banner.setContent(
    `{green-fg}╭─ Dead-Sec{/green-fg} │ {white-fg}${tui.model}{/white-fg} │ 📁 {cyan-fg}${cwd}{/cyan-fg} │ 🔧 {cyan-fg}${tools} tools{/cyan-fg} │ ⚡ {yellow-fg}${skills} skills{/yellow-fg}\n` +
      `╰─{gray-fg}${"─".repeat(Math.max(20, (tui.screen.width || 80) - 4))}{/gray-fg}`
  );
  tui.screen.render();
}

// 状态栏 (1行): 模型 │ tokens/limit │ 进度条 │ 费用 │ 时长 │ 压缩次数
// 半屏/窄窗下内容超宽会导致文本换行溢出到输入框区域，故按可视宽度截断。
// 惰性渲染: 内容与上次相同时跳过 setContent/render（每秒计时器只更新数字/进度条）。
let lastStatusContent = null;
function renderStatusBar() {
  if (!tui) return "";
  const { tokens, tokenLimit, cost, compactions } = tui.state;
  const pct = Math.min(1, tokens / tokenLimit);
  const usagePct = Math.round(pct * 100);
  const maxW = (tui.screen.width || 80) - 2;
  const barW = Math.max(6, Math.min(20, maxW - 34));
  const filled = Math.round(pct * barW);
  const barColor = usagePct < 60 ? "green" : usagePct < 85 ? "yellow" : "red";
  const bar = `${"█".repeat(filled)}${"░".repeat(barW - filled)}`;
  const elapsed = tui.fmtDuration(Date.now() - tui.state.startTime);
  let content =
    `  {white-fg}${tui.model}{/white-fg} │ tokens {yellow-fg}${tokens}/${tokenLimit}{/yellow-fg} ` +
    `│ {${barColor}-fg}${bar}{/${barColor}-fg} ${usagePct}% ` +
    `│ {yellow-fg}${cost < 1 ? "$" + cost.toFixed(2) : "$" + cost.toFixed(1)}{/yellow-fg} ` +
    `│ {yellow-fg}${elapsed}{/yellow-fg} │ {red-fg}🔄 ${compactions}{/red-fg}`;
  const plain = content.replace(/\{\/?[a-zA-Z#0-9-]+\}/g, "");
  if (plain.length > maxW) {
    // 逐段裁剪，保留进度条与花费等关键信息
    let slim = content;
    const cut = (tag, from, to) => {
      const i = slim.indexOf(from);
      if (i < 0) return;
      const j = slim.indexOf(to, i + from.length);
      if (j < 0) return;
      slim = slim.slice(0, i) + `${to}…${slim.slice(j + to.length)}`;
    };
    cut("{white-fg}", tui.model, "{/white-fg}");
    if (plain.length > maxW) cut("{yellow-fg}", elapsed, "{/yellow-fg}");
    if (plain.length > maxW) cut("{red-fg}", `🔄 ${compactions}`, "{/red-fg}");
    content = slim;
  }
  if (content !== lastStatusContent) {
    lastStatusContent = content;
    tui.statusBar.setContent(content);
    tui.screen.render();
  }
  return content;
}

const CMD_MENU = { active: false, rows: 0, text: "", sel: -1, items: [] };
let menuEscaping = false; // Ctrl+C 已消费给菜单关闭

// ---- 会话选择器: /session 进入, ↑↓ 选择, Enter 载入继续, Ctrl+N 重命名 ----
const SESSION_PICK = { active: false, rows: 0, sel: -1, sessions: [] };

function fmtLocal(iso) {
  if (!iso) return "????-??-?? ??:??:??";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderSessionPick() {
  const list = SESSION_PICK.sessions;
  const rows = list.map((s, i) => {
    const body = `${C.sel}${s.title || "（未命名会话）"}${C.reset}  ${C.dim}${fmtLocal(s.ts)} · ${s.count} 条${C.reset}`;
    return i === SESSION_PICK.sel ? `${C.sel}▶ ${body}${C.reset}` : `  ${body}`;
  });
  rows.unshift(`${C.sel}▲▼ 选择 · Enter 继续 · Ctrl+N 改名${C.reset}`);
  eraseRows(SESSION_PICK.rows);
  const n = rows.length;
  process.stdout.write(`\x1b[${n}A`);
  for (const row of rows) bWrite(bLine(row));
  SESSION_PICK.active = true;
  SESSION_PICK.rows = n;
}

function clearSessionPick() {
  if (!SESSION_PICK.active) return;
  eraseRows(SESSION_PICK.rows);
  SESSION_PICK.active = false;
  SESSION_PICK.rows = 0;
  SESSION_PICK.sel = -1;
  SESSION_PICK.sessions = [];
}

// thinking spinner
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let statusFn = null; // 注入的状态栏渲染（hermes 风格输入区）
let onSpinnerStart = null; // 请求开始时: 清状态栏行, 让输出正常滚动
let onSpinnerStop = null; // 请求结束时: 重画状态栏
const spinner = {
  running: false,
  frame: 0,
  timer: null,
  label: "thinking",
  startedAt: 0,
  start(label, quiet) {
    if (quiet || tui) return; // TUI 下无 spinner 文本，状态栏由每秒定时器刷新
    if (onSpinnerStart) onSpinnerStart();
    this.running = true;
    this.label = label || "thinking";
    this.frame = 0;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.render(), 120);
  },
  render() {
    if (!this.running) return;
    if (statusFn) statusFn();
    else process.stdout.write(`\r\x1b[K  │ ${C.dim}${FRAMES[this.frame++ % FRAMES.length]} ${this.label}...${C.reset}`);
  },
  resume() {
    if (this.running) this.render();
  },
  stop(quiet) {
    if (this.timer) clearInterval(this.timer);
    this.running = false;
    if (!quiet && !tui) process.stdout.write("\r\x1b[K");
    if (onSpinnerStop) onSpinnerStop();
  },
};

function printTools(toolName, input, result, quiet) {
  if (quiet) {
    process.stdout.write(
      `[tool] ${toolName} ${String(input && typeof input === "object" ? JSON.stringify(input).slice(0, 120) : input || "").slice(0, 200)}\n`
    );
    return;
  }
  if (tui) {
    const brief = String(input && typeof input === "object" ? JSON.stringify(input).slice(0, 140) : input || "");
    appendChatLine(`{#767676-fg}⚙ ${sanitizeTui(toolName)} ${sanitizeTui(brief)}{/}`);
    const r = String(result);
    const first = r.split("\n")[0];
    if (r.includes("\n") || r.length > 160) appendChatLine(`{#767676-fg}  ↳ ${cleanExternal(first).slice(0, 200)}{/}`);
    return;
  }
  process.stdout.write("\r\x1b[K");
  const brief = String(input && typeof input === "object" ? JSON.stringify(input).slice(0, 140) : input || "");
  bWrite(bLine(`${C.tool}⚙ ${toolName} ${brief}${C.reset}`));
  const r = String(result);
  const first = r.split("\n")[0];
  if (r.includes("\n") || r.length > 160) {
    bWrite(bLine(`${C.tool}  ↳ ${first.slice(0, 200)}${C.reset}`));
  }
  spinner.resume();
}

function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function printUsageLine(usage, quiet) {
  if (!usage) return;
  if (quiet) process.stdout.write(`[usage] in ${usage.prompt} out ${usage.completion} ctx ${usage.total}\n`);
  else if (tui) appendChatLine(`{#767676-fg}⚡ in ${fmtTokens(usage.prompt)} / out ${fmtTokens(usage.completion)} | 上下文 ${fmtTokens(usage.total)} tokens{/}`);
  else bWrite(bLine(`${C.dim}⚡ in ${fmtTokens(usage.prompt)} / out ${fmtTokens(usage.completion)} | 上下文 ${fmtTokens(usage.total)} tokens${C.reset}`));
}

function typewriter(text, quiet) {
  if (quiet) {
    process.stdout.write(text + "\n");
    return;
  }
  if (tui) {
    // TUI: 整段追加为助手消息
    appendChatLine(`{green-fg}🤖 Dead-Sec{/green-fg}: ${sanitizeTui(String(text))}`);
    return;
  }
  const lines = String(text).split("\n");
  for (const line of lines) {
    bWrite(bLine(line));
    if (line.length > 0) {
      const d = Math.min(8, Math.max(1, Math.round(400 / line.length)));
      const end = Date.now() + d;
      while (Date.now() < end) {
        /* tiny pacing delay */
      }
    }
  }
}

// ---- 命令菜单: 输入 / 时实时反馈，每条命令带解释 ----
// 菜单画在 prompt 行上方: eraseRows 后光标位于 prompt 行,
// 上移 n 行开始打印, 逐行输出后光标恰好落回 prompt 行, 与 readline 刷新协作
function eraseRows(n) {
  if (n <= 0) return;
  process.stdout.write(`\x1b[${n}A`);
  for (let i = 0; i < n; i++) process.stdout.write("\x1b[K\x1b[1B");
}

function renderCmdMenu(line, sel = -1) {
  const input = line.trimStart();
  const prefix = input.startsWith("/") ? input.slice(1).trim().split(/\s+/)[0].toLowerCase() : "";
  const matches = prefix ? CMD_DEFS.filter(([name]) => name.toLowerCase().startsWith(prefix)) : CMD_DEFS;

  let rows;
  const norm = sel >= 0 ? sel : 0;
  if (!matches.length) {
    rows = [`${C.err}⚠ 无此命令: /${prefix || "?"}（/help 查看全部）${C.reset}`];
    CMD_MENU.items = [];
    CMD_MENU.sel = -1;
  } else {
    CMD_MENU.items = matches.map(([name]) => name);
    const sel2 = Math.min(norm, matches.length - 1);
    rows = matches.map(([name, desc], i) => {
      const body = `${C.cmd}/${name}${C.reset}  ${C.dim}${desc}${C.reset}`;
      return i === sel2 ? `${C.sel}▶ ${body}${C.reset}` : `  ${body}`;
    });
    rows.unshift(`${C.sel}▲▼ 选择 · Enter 执行 · Ctrl+C 关闭${C.reset}`);
    CMD_MENU.sel = sel2;
  }

  eraseRows(CMD_MENU.rows);
  const n = rows.length;
  process.stdout.write(`\x1b[${n}A`);
  for (const row of rows) bWrite(bLine(row));
  CMD_MENU.active = true;
  CMD_MENU.rows = n;
  CMD_MENU.text = input;
}

function clearCmdMenu() {
  if (!CMD_MENU.active || CMD_MENU.rows === 0) return;
  eraseRows(CMD_MENU.rows);
  CMD_MENU.active = false;
  CMD_MENU.rows = 0;
  CMD_MENU.sel = -1;
  CMD_MENU.items = [];
  CMD_MENU.text = "";
}

function readHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    return raw.split("\n").filter(Boolean).slice(-100);
  } catch {
    return [];
  }
}

function writeHistory(array) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, array.slice(-100).join("\n"));
  } catch {
    /* ignore */
  }
}

function buildSystem(target, memoryBlock) {
  const targetLine = target
    ? `\nSession target: ${target} (scope: only this target unless the user explicitly authorizes more)`
    : "\nNo explicit target set this session. Ask the user what they want to test if the task needs a target. Only operate on systems the user owns or is authorized to test.";
  const mem = memoryBlock
    ? `\n\nMemory learned from past sessions (follow these preferences, remember these corrections):\n${memoryBlock}`
    : "";
  return (
    `You are Dead Sec in a Claude-code-like terminal chat. Respond in the user's language (Chinese if they write Chinese).\n` +
    `Be concise, technical, and honest about uncertainty.\n` +
    `Build context over the conversation; use tools when the task needs real data.\n` +
    targetLine +
    mem +
    `\n\nDead Sec mission (when the user wants security work):\n` +
    `- Web/API pentesting, vulnerability analysis, PoC development.\n` +
    `- No Exploit, No Report: never report a vulnerability as confirmed without practical evidence.\n` +
    `- Only operate on the session target or systems the user explicitly authorizes.\n` +
    `\nSession facts:\n- CWD: ${process.cwd()}\n- Repo/output dir: ${process.cwd()}/.dead-sec (deliverables/, pocs/)\n`
  );
}

export async function chat(options = {}) {
  const cfg = load();
  const { target = "", startPrompt = "" } = options;
  const isTTY = !!process.stdin.isTTY;
  const quiet = !!options.quiet || !isTTY;
  const autoApprove = process.env.DEAD_SEC_AUTO_APPROVE === "1";

  const messages = [{ role: "system", content: buildSystem(target, buildMemoryBlock()) }];
  const history = readHistory();
  const imContexts = new Map();
  const sessionAllows = new Set();
  const usageStats = { prompt: 0, completion: 0, total: 0 };
  let headerRows = 0;

  const mcpServers = await connectServers();

  const makePermission = (channel) => async (tool, input) => {
    if (autoApprove) return true;
    if (sessionAllows.has(tool)) return true;
    if (channel !== "cli") return false;
    if (quiet) return false;
    spinner.stop(false);
    const brief = String(input && typeof input === "object" ? JSON.stringify(input).slice(0, 200) : input || "");
    if (tui) {
      // TUI: 在聊天区显示确认，输入框捕获 y/a/n
      return new Promise((resolve) => {
        appendChatLine(`{yellow-fg}⚠ 权限确认{/yellow-fg}: 执行 {white-fg}${sanitizeTui(tool)}{/white-fg} ${sanitizeTui(brief)}? (y=仅一次 a=本会话允许 n=拒绝)`);
        inputBox.clearValue();
        const onKey = (ch, key) => {
          if (!key) return;
          const a = String(ch || "").toLowerCase();
          if (a === "y" || a === "a" || a === "n") {
            inputBox.removeListener("keypress", onKey);
            if (a === "a") sessionAllows.add(tool);
            inputBox.clearValue();
            appendChatLine(`{dim}→ ${a === "y" ? "允许一次" : a === "a" ? "本会话允许" : "拒绝"}{/dim}`);
            spinner.resume();
            resolve(a !== "n");
          }
        };
        inputBox.on("keypress", onKey);
        inputBox.focus();
      });
    }
    return true;
  };

  const onUsage = (u) => {
    usageStats.prompt += u?.prompt_tokens || 0;
    usageStats.completion += u?.completion_tokens || 0;
    usageStats.total = u?.total_tokens ?? usageStats.prompt + usageStats.completion;
    // 状态栏展示真实用量（不再使用随机假数据）
    if (tui) {
      tui.state.tokens = usageStats.total;
      // 粗略费用估算: ~$0.3/1M input, ~$1.2/1M output（按 DeepSeek 档位，仅供展示）
      tui.state.cost =
        (usageStats.prompt * 0.3 + usageStats.completion * 1.2) / 1000000;
      renderStatusBar();
    }
  };

  const turnOptions = (channel, quietMode) => ({
    onTool: (n, i, r) => printTools(n, i, r, quietMode),
    onUsage,
    mcpServers,
    onPermission: makePermission(channel),
  });

  let queue = Promise.resolve();
  let busy = 0;
  const enqueue = (fn) => {
    busy++;
    queue = queue.then(() => fn()).finally(() => busy--);
    return queue;
  };

  let rl = null;
  const rlPrompt = () => {
    if (tui) {
      inputBox.focus();
      tui.screen.render();
      return;
    }
    if (rl && isTTY && !quiet && !rl.closed) {
      try {
        rl.prompt();
      } catch {
        /* stdin closed meanwhile */
      }
    }
  };

  const runTurn = async (msgs, channel, quietMode) => {
    spinner.start("thinking", quietMode);
    try {
      const reply = await chatTurn(cfg, msgs, turnOptions(channel, quietMode));
      learn("assistant", reply, cfg.model);
      appendSession({ role: "assistant", content: reply, model: cfg.model, target, channel });
      if (quietMode) {
        process.stdout.write(`[assistant] ${reply}\n`);
        process.stdout.write(`[usage] in ${usageStats.prompt} out ${usageStats.completion} ctx ${usageStats.total}\n`);
      } else {
        typewriter(reply + "\n", quietMode);
        printUsageLine(usageStats, false);
        process.stdout.write("\n");
      }
      return reply;
    } catch (e) {
      if (quietMode) process.stdout.write(`[error] ${e.message}\n`);
      else bWrite(bLine(`${C.err}✖ ${e.message}${C.reset}`));
      return "";
    } finally {
      spinner.stop(quietMode);
    }
  };

  // ---- IM connectors: 每个 chatId 独立上下文 (单聊/多人群聊互不影响) ----
  const imOnMessage = ({ channel, chatId, text }) => {
    if (!quiet) {
      clearCmdMenu();
      bWrite(bLine(`${C.dim}[im:${channel}] ${text.slice(0, 120)}${C.reset}`));
    }
    enqueue(async () => {
      const key = `${channel}:${chatId}`;
      if (!imContexts.has(key)) {
        imContexts.set(key, [{ role: "system", content: buildSystem(target, buildMemoryBlock()) }]);
      }
      const msgs = imContexts.get(key);
      msgs.push({ role: "user", content: text });
      appendSession({ role: "user", content: text, model: cfg.model, target, channel });
      learn("user", text, cfg.model);
      try {
        const reply = await runTurn(msgs, channel, quiet);
        const conn = connectors.find((x) => x.id === channel);
        if (conn) await conn.send(chatId, reply || "✖ 处理失败，请查看日志");
      } catch (e) {
        const conn = connectors.find((x) => x.id === channel);
        if (conn) await conn.send(chatId, "✖ " + (e.message || e));
      } finally {
        rlPrompt();
      }
    });
  };

  const connectors = await initConnectors(imOnMessage);

  const stopPlanner = startPlanner((job) => {
    if (!quiet) {
      clearCmdMenu();
      bWrite(bLine(`${C.warn}⏰ [计划] ${job.name} 触发 (${job.cron})${C.reset}`));
    }
    enqueue(async () => {
      if (job.channel) {
        const [cid, chatId] = job.channel.split(":");
        const key = job.channel;
        if (!imContexts.has(key)) {
          imContexts.set(key, [{ role: "system", content: buildSystem(job.target || target, buildMemoryBlock()) }]);
        }
        const msgs = imContexts.get(key);
        msgs.push({ role: "user", content: `[scheduled job: ${job.name} @ ${new Date().toISOString()}]\n${job.prompt}` });
        appendSession({ role: "user", content: `[job:${job.name}] ${job.prompt}`, model: cfg.model, target, channel: cid });
        learn("user", job.prompt, cfg.model);
        const reply = await runTurn(msgs, cid, quiet);
        const conn = connectors.find((x) => x.id === cid);
        if (conn && chatId) await conn.send(chatId, reply);
        return;
      }
      messages.push({ role: "user", content: `[scheduled job: ${job.name} @ ${new Date().toISOString()}]\n${job.prompt}` });
      appendSession({ role: "user", content: `[job:${job.name}] ${job.prompt}`, model: cfg.model, target, channel: "cli" });
      learn("user", job.prompt, cfg.model);
      await runTurn(messages, "cli", quiet);
    });
  });

  process.on("exit", () => {
    stopPlanner();
    for (const c of connectors) c.dispose();
  });

  if (isTTY && !quiet) {
    // TUI 模式: banner 由 blessed 组件渲染（见文件底部 TUI 初始化）
    if (!tui) {
      for (const line of BANNER) {
        process.stdout.write(line + "\n");
      }
      process.stdout.write("\n");
      renderHeader();
    }
  }

  function renderHeader() {
    const title = `model: ${cfg.model}${target ? `   target: ${target}` : ""}`;
    bWrite(bTop(title));
    const ims = connectors.length ? ` IM: ${connectors.map((x) => x.id).join(", ")}` : "";
    bWrite(bLine(`${C.dim}${memorySummary()}${ims}${C.reset}`));
    bWrite(bBottom());
    process.stdout.write("\n");
    headerRows = 2;
  }

  function refreshHeader() {
    if (!isTTY || quiet || headerRows <= 0) return;
    process.stdout.write(`\x1b[${headerRows}A`);
    const title = `model: ${cfg.model}${target ? `   target: ${target}` : ""}`;
    bWrite(bTop(title));
    const ims = connectors.length ? ` IM: ${connectors.map((x) => x.id).join(", ")}` : "";
    bWrite(bLine(`${C.dim}${memorySummary()}${ims}${C.reset}`));
    process.stdout.write(`\x1b[${headerRows}B`);
  }

  function memorySummary() {
    const p = loadProfile();
    let s = `记忆: ${sessionCount()} 会话 · ${p.msgCount || 0} 消息`;
    if (p.preferences?.language) s += ` · ${p.preferences.language}`;
    return s;
  }

  // 命令输出: TUI 下以聊天行显示（修掉 /help /usage 等输出在 TUI 里被吞的隐藏问题）, 否则写 stdout
const out = (s) => {
  if (!tui) return process.stdout.write(s);
  for (const ln of String(s).split("\n")) {
    if (ln.trim()) appendChatLine(`{dim}${sanitizeTui(ln)}{/dim}`);
  }
};

const handleInput = (line) => {
    const text = line.trim();
    if (!text) return Promise.resolve();
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      if (cmd === "quit" || cmd === "exit") {
        appendSession({ role: "user", content: text, model: cfg.model, target, channel: "cli" });
        process.stdout.write("bye\n");
        process.exit(0);
      }
      if (cmd === "help") return Promise.resolve(out(HELP + "\n"));
      if (cmd === "clear") {
        process.stdout.write("\x1b[2J\x1b[H");
        renderHeader();
        return Promise.resolve();
      }
      if (cmd === "skills") return Promise.resolve(out(displaySkills() + "\n"));
      if (cmd === "target") {
        if (!arg) return Promise.resolve(out("usage: /target <url>\n"));
        messages.push({ role: "user", content: `[session target set by user: ${arg}]` });
        appendSession({ role: "user", content: `[target set] ${arg}`, model: cfg.model, target: arg, channel: "cli" });
        process.stdout.write(`target set: ${arg}${target && arg !== target ? ` (原 ${target})` : ""}\n`);
        return Promise.resolve();
      }
      if (cmd === "model") {
        if (!arg) return Promise.resolve(out(`当前模型: ${cfg.model}（用法: /model <name>，如 /model gpt-4o-mini）\n`));
        const old = cfg.model;
        cfg.model = arg;
        appendSession({ role: "user", content: `[model switch] ${old} → ${arg}`, model: cfg.model, target, channel: "cli" });
        bWrite(bLine(`${C.ok}✓ 模型已切换: ${old} → ${cfg.model}${C.reset}`));
        refreshHeader();
        return Promise.resolve();
      }
      if (cmd === "use") {
        if (!arg) return Promise.resolve(out("usage: /use <skill>\n"));
        const skill = getSkill(arg);
        if (!skill) return Promise.resolve(out(`skill not found: ${arg}\n`));
        messages.push({ role: "user", content: `[user manually activates skill]\n${skill.description}\n\n${skill.body}` });
        appendSession({ role: "user", content: `[skill activate] ${arg}`, model: cfg.model, target, channel: "cli" });
        return Promise.resolve(out(`skill injected: ${arg}\n`));
      }
      if (cmd === "session") {
        if (quiet) {
          // 管道模式: 简化为普通列表
          const sessions = loadSessions(Math.min(300, Math.max(1, parseInt(arg, 10) || 30)));
          if (!sessions.length) {
            bWrite(bLine(`${C.dim}  （还没有记忆，先聊几句吧）${C.reset}`));
            return Promise.resolve();
          }
          for (const s of sessions) {
            const who = s.role === "user" ? `${C.user}${s.role}${C.reset}` : `${C.cmd}${s.role}${C.reset}`;
            const t = (s.ts || "").slice(11, 19);
            bWrite(bLine(`${C.dim}[${t}]${C.reset} ${who}: ${String(s.content).slice(0, 90)}`));
          }
          return Promise.resolve();
        }
        // TTY: 进入会话选择器，↑↓ 选中 + Enter 载入继续，Ctrl+N 重命名
        if (tui) {
          openSessionPanel();
          return Promise.resolve();
        }
        const groups = listSessions();
        if (!groups.length) {
          bWrite(bLine(`${C.dim}  （还没有历史会话，先聊几句吧）${C.reset}`));
          return Promise.resolve();
        }
        SESSION_PICK.sessions = groups;
        SESSION_PICK.sel = 0;
        renderSessionPick();
        return Promise.resolve();
      }
      if (cmd === "usage") {
        return Promise.resolve(
          out(
            `token 使用: in ${usageStats.prompt} / out ${usageStats.completion} / 上下文 ${usageStats.total}\n`
          )
        );
      }
      if (cmd === "mcp") {
        const lines = mcpServers.length
          ? mcpServers.map((s) =>
              s.error
                ? `  ${s.name}: 不可用 (${s.error})`
                : `  ${s.name}: ${(s.tools || []).map((t) => `${s.name}_${t.name}`).join(", ")}`
            )
          : ["  未配置 MCP 服务器 (~/.dead-sec/mcp.json)"];
        return Promise.resolve(out(lines.join("\n") + "\n"));
      }
      if (cmd === "plan") {
        const plans = listPlans();
        if (!plans.jobs.length) {
          return Promise.resolve(
            out(
              `计划模式未配置。用法: dead-sec plan add "<cron>" "<名称>" "<prompt>" [channel]\n` +
                `示例: dead-sec plan add "30 9 * * *" daily-scan "对首页做一次完整扫描" telegram:123456\n`
            )
          );
        }
        return Promise.resolve(
          out(
            `计划(启用:${plans.enabled}):\n` +
              plans.jobs
                .map(
                  (j) =>
                    `  ${j.enabled === false ? "[off] " : ""}${j.name}  cron="${j.cron}"  channel=${j.channel || "cli"}  ${String(j.prompt).slice(0, 60)}`
                )
                .join("\n") +
              "\n"
          )
        );
      }
      return Promise.resolve(
        out(`unknown command: /${cmd}  (${C.cmd}/help${C.reset})\n`)
      );
    }

    if (quiet) process.stdout.write(`[user] ${text}\n`);
    else if (!tui) {
      clearCmdMenu();
      bWrite(bLine(`${C.user}▸ ${text}${C.reset}`));
    }

    messages.push({ role: "user", content: text });
    appendSession({ role: "user", content: text, model: cfg.model, target, channel: "cli" });
    autoTitleSession(text);
    learn("user", text, cfg.model);
    return runTurn(messages, "cli", quiet);
  };

  if (startPrompt) {
    await handleInput(startPrompt);
    return;
  }

  // Non-TTY (piped) mode
  if (quiet) {
    const rlPipe = readline.createInterface({ input: process.stdin });
    for await (const line of rlPipe) {
      await enqueue(() => handleInput(line));
    }
    writeHistory(history);
    saveProfile(loadProfile());
    return;
  }

  // ---- blessed 全屏 TUI ----
  const screen = blessed.screen({
    smartCSR: true,
    title: "Dead-Sec",
    fullUnicode: true,
  });

  const tuiState = {
    tokens: 0,
    tokenLimit: 8000,
    cost: 0,
    compactions: 0,
    startTime: Date.now(),
  };
  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  const banner = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 2,
    tags: true,
    wrap: false, // 禁止超宽换行溢出（半屏时下拉覆盖聊天区）
    style: { bg: "#111111" },
  });
  const chatBox = blessed.box({
    parent: screen,
    top: 2,
    left: 0,
    width: "100%",
    height: "100%-6",
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
    tags: true,
    style: { bg: "#111111", fg: "#d0d0d0" },
    scrollbar: { ch: " ", style: { bg: "#555555" } },
  });
  const statusBar = blessed.box({
    parent: screen,
    top: "100%-4",
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    wrap: false, // 禁止超宽换行溢出（半屏时覆盖输入框）
    style: { bg: "#1a1a1a", fg: "#cccccc" },
  });
  const inputBox = blessed.textarea({
    parent: screen,
    left: 0,
    width: "100%",
    height: 3,
    inputOnFocus: true,
    keys: true,
    mouse: true,
    style: { bg: "#111111", fg: "#e8e8e8", focus: { bg: "#111111" } },
    prompt: "{green-fg}└─> {/green-fg}",
    padding: { top: 0, left: 2, right: 2 },
    border: { type: "line", fg: "#555555" },
  });

  tui = { screen, chatBox, statusBar, banner, input: inputBox, model: cfg.model, state: tuiState, fmtDuration, toolCount: 0, skillCount: 0 };
  screen.title = `Dead-Sec │ ${cfg.model}`;

  // 显式布局: 不依赖 blessed 百分比解析("100%-6" 等), resize 后按屏幕实际尺寸重排,
  // 彻底避免半屏/窄窗口下输入框重叠与光标错位
  const relayout = () => {
    if (!tui) return;
    const H = screen.height;
    banner.top = 0;
    banner.height = 2;
    chatBox.top = 2;
    chatBox.height = Math.max(1, H - 8);
    statusBar.top = Math.max(4, H - 5);
    statusBar.height = 1;
    inputBox.top = Math.max(5, H - 3);
    inputBox.height = 3;
    screen.title = `Dead-Sec │ ${cfg.model}`;
  };
  relayout();

  // ---- 鼠标拖选复制（blessed 全屏下终端原生选中失效）----
  // 左键在聊天区按住拖动 = 选中(松开保留选区), 再单击一次 = 复制到剪贴板,
  // 右上角弹出 "Copied" toast。OSC52 + xclip/wl-copy/pbcopy 兜底。
  let selAnchor = null; // {x,y} 屏幕坐标 (0-based), 拖选起点
  let pendingClick = null; // 当前按下的位置, 用于区分 单击/拖选
  let dragMoved = false; // 本次按下后是否移动过
  let hasSelection = false; // 是否已有激活选区(拖选完成, 等待单击复制)
  let selectedText = ""; // 最后拖选的文本
  const selOverlay = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    hidden: true,
    padding: 0,
    style: { bg: "#3a3a6e", fg: "#ffffff" },
  });
  // 右上角 "Copied" toast (opencode 风格)
  const toast = blessed.box({
    parent: screen,
    top: 2,
    right: 1,
    width: "shrink",
    height: "shrink",
    hidden: true,
    padding: { left: 1, right: 1 },
    style: { bg: "#1f6f43", fg: "#ffffff", bold: true },
    content: "✓ Copied",
    tags: true,
  });
  let toastTimer = null;
  const showToast = () => {
    clearTimeout(toastTimer);
    toast.hide();
    screen.render();
    toast.show();
    screen.render();
    toastTimer = setTimeout(() => {
      toast.hide();
      screen.render();
    }, 1500);
  };

  // ---- TUI 命令面板: 输入 / 前缀实时匹配, ↑↓ 选择, Enter 确定 ----
  const cmdPanel = blessed.box({
    parent: screen,
    top: 0,
    left: 2,
    width: "shrink",
    height: "shrink",
    hidden: true,
    tags: true,
    padding: { left: 1, right: 1 },
    border: { type: "line", fg: "#555555" },
    style: { bg: "#16161d", fg: "#d0d0d0" },
  });
  const cmdState = { active: false, sel: 0, rows: [] };
  const positionPanel = (panel, nrows) => {
    panel.top = Math.max(0, screen.height - 3 - nrows - 1);
    panel.left = 2;
  };
  const renderCmdPanel = () => {
    if (!cmdState.active) return;
    const body = cmdState.rows.map((r, i) =>
      i === cmdState.sel ? `{white-fg bg:#3a3a6e}▶ ${r}{/}` : `  ${r}`
    ).join("\n");
    cmdPanel.setContent(body);
    positionPanel(cmdPanel, cmdState.rows.length || 1);
    screen.render();
  };
  const hideCmdPanel = () => {
    if (!cmdState.active) return;
    cmdState.active = false;
    cmdPanel.hide();
    screen.render();
  };
  const updateCmdPanel = () => {
    const v = inputBox.getValue();
    if (!v.startsWith("/")) return hideCmdPanel();
    const prefix = v.slice(1).split(/\s+/)[0].toLowerCase();
    const found = prefix ? CMD_DEFS.filter(([n]) => n.toLowerCase().startsWith(prefix)) : CMD_DEFS;
    if (!found.length) {
      cmdState.active = true;
      cmdPanel.setContent(`{red-fg}未知命令: /${prefix}{/red-fg}`);
      positionPanel(cmdPanel, 1);
      cmdPanel.show();
      screen.render();
      return;
    }
    cmdState.rows = found.map(([n, d]) => `{cyan-fg}/${n}{/cyan-fg}  {#777777-fg}${d}{/}`);
    cmdState.sel = Math.min(cmdState.sel, Math.max(0, found.length - 1));
    cmdState.active = true;
    cmdPanel.show();
    renderCmdPanel();
  };
  inputBox.on("keypress", () => setTimeout(updateCmdPanel, 0));

  // ---- TUI 会话面板: /session 弹出历史列表, ↑↓ 选择, Enter 载入继续 ----
  const sessionPanel = blessed.box({
    parent: screen,
    top: 0,
    left: 2,
    width: "shrink",
    height: "shrink",
    hidden: true,
    tags: true,
    padding: { left: 1, right: 1 },
    border: { type: "line", fg: "#555555" },
    style: { bg: "#16161d", fg: "#d0d0d0" },
  });
  const sessionState = { active: false, sel: 0, sessions: [] };
  const renderSessionPanel = () => {
    const rows = sessionState.sessions.map((s, i) => {
      const line = `${s.title || "（未命名会话）"}  {#777777-fg}${fmtLocal(s.ts)}{/}  {#777777-fg}${s.count} 条{/}`;
      return i === sessionState.sel ? `{white-fg bg:#3a3a6e}▶ ${line}{/}` : `  ${line}`;
    });
    const MAX_ROWS = 12;
    const start = Math.max(0, Math.min(sessionState.sel - 5, rows.length - MAX_ROWS));
    sessionPanel.setContent(rows.slice(start, start + MAX_ROWS).join("\n") || "{dim}（暂无可恢复会话）{/dim}");
    positionPanel(sessionPanel, Math.min(rows.length || 1, MAX_ROWS));
    sessionPanel.show();
    screen.render();
  };
  const openSessionPanel = () => {
    const groups = listSessions();
    if (!groups.length) {
      appendChatLine("{dim}（还没有历史会话，先聊几句吧）{/dim}");
      return;
    }
    sessionState.sessions = groups;
    sessionState.sel = 0;
    sessionState.active = true;
    renderSessionPanel();
  };
  const hideSessionPanel = () => {
    if (!sessionState.active) return;
    sessionState.active = false;
    sessionPanel.hide();
    screen.render();
  };
  const moveSessionSel = (dir) => {
    if (!sessionState.sessions.length) return;
    sessionState.sel = (sessionState.sel + dir + sessionState.sessions.length) % sessionState.sessions.length;
    renderSessionPanel();
  };
  const loadSession = (s) => {
    const msgs = loadSessionMessages(s.sessionId);
    setSessionId(s.sessionId);
    messages.length = 0;
    for (const m of msgs) messages.push({ role: m.role, content: m.content });
    chatLines.length = 0;
    appendChatLine(`{#888888-fg}┌─ 已载入历史会话${s.title ? `: ${sanitizeTui(s.title)}` : ""}（${msgs.length} 条）{/}`);
    for (const m of msgs) {
      if (m.role === "user") appendChatLine(`{cyan-fg}🧑 你{/cyan-fg}: ${sanitizeTui(m.content)}`);
      else appendChatLine(`{green-fg}🤖 Dead-Sec{/green-fg}: ${sanitizeTui(m.content)}`);
    }
    appendChatLine("{#888888-fg}└─ 继续对话…{/}");
    chatBox.setScrollPerc(100);
    screen.render();
  };

  const winWidth = (ch) => {
    const c = ch.codePointAt(0) || 0;
    return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe10 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
      ? 2 : 1;
  };

  const cellize = (line) => {
    const cells = [];
    let col = 0;
    const s = String(line);
    const isEmoji = (cp) => /^\p{Extended_Pictographic}$/u.test(String.fromCodePoint(cp));
    for (let i = 0; i < s.length; ) {
      const c = s.codePointAt(i);
      let j = i + (c > 0xffff ? 2 : 1);
      // emoji 簇: 图形字符 + (ZWJ + 图形字符)+，附随 VS16/肤色修饰符
      if (isEmoji(c)) {
        while (j < s.length && s.codePointAt(j) === 0x200d) {
          const next = s.codePointAt(j + 1);
          if (next === undefined || !isEmoji(next)) break;
          j += 1 + (next > 0xffff ? 2 : 1);
          while (j < s.length) {
            const t = s.codePointAt(j);
            if (t === 0xfe0f || (t >= 0x1f3fb && t <= 0x1f3ff)) j += 1;
            else break;
          }
          if (j < s.length && s.codePointAt(j) === 0x200d) continue;
          break;
        }
      }
      const ch = s.slice(i, j);
      cells.push({ ch, col, w: winWidth(ch) });
      col += winWidth(ch);
      i = j;
    }
    return { cells, cols: col };
  };

  // 聊天区内容(含 blessed tags) → 剥离后的纯文本行
  const plainLines = () =>
    chatBox.getContent().split("\n").map((l) =>
      l
        .replace(/\{open\}/g, "\u0001")
        .replace(/\{close\}/g, "\u0002")
        .replace(/\{\/?[\w\-,;!#]*\}/g, "")
        .replace(/\u0001/g, "{")
        .replace(/\u0002/g, "}")
    );

  // 取 cells 中与列区间 [x1, x2] (闭区间, 终端列 0-based) 相交的字符
  const selectSlice = (cells, x1, x2) => {
    let out = "";
    for (const cell of cells) {
      if (cell.col > x2) break;
      if (cell.col + cell.w <= x1) continue;
      out += cell.ch;
    }
    return out;
  };

  const chatSelectionText = (x1, y1, x2, y2) => {
    const pos = chatBox.lpos || { xi: 0, yi: 2, xl: 80, yl: 20 };
    const ax = Math.min(x1, x2), bx = Math.max(x1, x2);
    const ay = Math.max(pos.yi, Math.min(y1, y2));
    const by = Math.min(pos.yl - 1, Math.max(y1, y2));
    const c1 = Math.max(0, ax - pos.xi);
    const c2 = bx - pos.xi;
    if (by < ay || c2 < c1) return { text: "", rows: 0 };
    const scroll = chatBox.getScroll();
    const lines = plainLines();
    const parts = [];
    for (let sy = ay; sy <= by; sy++) {
      const { cells } = cellize(lines[sy - pos.yi + scroll] || "");
      parts.push(selectSlice(cells, c1, c2));
    }
    let text = parts.join("\n");
    // 去掉选区首尾空白行
    text = text.replace(/^\n+|\n+$/g, "");
    return { text, rows: by - ay + 1 };
  };

  const copyToClipboard = (text) => {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${b64}\x07`); // OSC52: 现代终端原生支持
    const outer = process.env.WAYLAND_DISPLAY ? "wl-copy"
      : process.env.DISPLAY ? "xclip" : null;
    if (!outer) return;
    const args = outer === "xclip" ? ["-selection", "clipboard"] : [];
    const sp = spawn(outer, args);
    sp.on("error", () => {});
    sp.stdin.write(text, "utf8");
    sp.stdin.end();
    setTimeout(() => { try { sp.kill(); } catch {} }, 3000);
  };

  // 拖动事件兼容两种终端:
  // - VTE 系(GNOME Terminal 等): 拖动发 mousemove
  // - 非 VTE 系(Windows Terminal/iTerm2/MobaXterm/xterm 等): allMotion 下拖动发连续 mousedown(b=32)
  let downHadSelection = false; // 按下时是否已有选区(用于单击复制判定)
  // ---- 鼠标滚轮滚动聊天区（wheelup/wheeldown 已由 blessed 解析, 与左键拖选互斥）----
  screen.on("mouse", (data) => {
    if (data.action === "wheelup" || data.action === "wheeldown") {
      chatBox.scroll(data.action === "wheelup" ? -3 : 3);
      screen.render();
      return;
    }
    const pos = chatBox.lpos;
    const inChat = pos &&
      data.x >= pos.xi && data.x <= pos.xl &&
      data.y >= pos.yi && data.y <= pos.yl;
    const leftBtn = data.button === "left";

    if (data.action === "mousedown" && leftBtn) {
      // 鼠标模式与键盘选区互斥: 先清键盘选区再开始拖选
      if (kbSelStart >= 0) {
        kbSelStart = kbSelEnd = -1;
        renderChat();
      }
      downHadSelection = hasSelection;
      pendingClick = { x: data.x, y: data.y };
      dragMoved = false;
      if (!downHadSelection) {
        // 无旧选区: 从按下处开始新选区
        selAnchor = { x: data.x, y: data.y };
        selOverlay.top = data.y;
        selOverlay.left = data.x;
        selOverlay.width = 1;
        selOverlay.height = 1;
        selOverlay.show();
        screen.render();
      }
      return;
    }

    // VTE 发 mousemove; 非 VTE 拖动中发连续 mousedown(此时 pendingClick 非空即拖动)
    const isMove = data.action === "mousemove" ||
      (data.action === "mousedown" && leftBtn && pendingClick);
    if (isMove && pendingClick) {
      if (!dragMoved && (Math.abs(data.x - pendingClick.x) > 0 || Math.abs(data.y - pendingClick.y) > 0)) {
        dragMoved = true;
        if (downHadSelection) {
          // 从旧选区上开始拖新选: 重设锚点为按下处
          selAnchor = { x: pendingClick.x, y: pendingClick.y };
          selOverlay.show();
        }
      }
      if (dragMoved && selAnchor) {
        hasSelection = false;
        const p = chatBox.lpos;
        if (!p) return;
        const ax = Math.min(selAnchor.x, data.x), bx = Math.max(selAnchor.x, data.x);
        const ay = Math.max(p.yi, Math.min(selAnchor.y, data.y));
        const by = Math.min(p.yl - 1, Math.max(selAnchor.y, data.y));
        const c1 = Math.max(0, ax - p.xi), c2 = bx - p.xi;
        selOverlay.top = ay;
        selOverlay.left = Math.max(p.xi, ax);
        selOverlay.width = Math.max(1, bx - Math.max(p.xi, ax) + 1);
        selOverlay.height = Math.max(1, by - ay + 1);
        const scroll = chatBox.getScroll();
        const lines = plainLines();
        const rows = [];
        for (let sy = ay; sy <= by; sy++) {
          const { cells } = cellize(lines[sy - p.yi + scroll] || "");
          rows.push(selectSlice(cells, c1, c2));
        }
        selOverlay.setContent(rows.join("\n"));
        screen.render();
      }
      return;
    }

    if (data.action === "mouseup" && pendingClick) {
      if (!dragMoved) {
        // 单击: 有旧选区 → 复制 + toast; 否则清除选区
        if (downHadSelection && hasSelection && selectedText.trim()) {
          copyToClipboard(selectedText);
          showToast();
        }
        hasSelection = false;
        selectedText = "";
        selAnchor = null;
        selOverlay.hide();
      } else if (selAnchor) {
        // 拖选完成: 保留选区高亮, 等待单击复制
        selectedText = chatSelectionText(selAnchor.x, selAnchor.y, data.x, data.y).text;
        hasSelection = true;
      }
      pendingClick = null;
      dragMoved = false;
      downHadSelection = false;
      screen.render();
    }
  });

  // 强制 SGR 鼠标协议(1006)+全运动(1003)，覆盖 blessed 默认的 vt200+utfMouse(1005)：
  // 1005 模式在多数现代终端上不支持/兼容差，拖动时坐标无法正确上报，
  // 导致拖选只能高亮起始一格。SGR+ALLMOTION 是通用标准，全终端可用。
  screen.program.setMouse({
    sgrMouse: true,
    cellMotion: true,
    allMotion: true,
    vt200Mouse: false,
    utfMouse: false,
    x10Mouse: false,
  }, true);

  appendChatLine(`{dim}── Welcome to Dead-Sec │ {white-fg}${cfg.model}{/white-fg} │ 输入 /help 查看命令 ──{/dim}`);
  appendChatLine("{dim}💡 复制: 鼠标在聊天区按住左键拖动选中, 松开后单击一次即复制; 或 Shift+↑/↓ 选行 + Ctrl+K 复制 (右上角提示 Copied){/dim}");

  const doRenderBanner = () => {
    tui.model = cfg.model;
    renderBanner();
  };
  renderBanner();
  renderStatusBar();

  // 状态栏每秒刷新（时长计时）。tokens/cost 只由真实 usage 回调(handleLLMUsage)驱动，
  // 不再生成随机假数据——不说话、不消耗 API 时这些数字不会上涨。
  const statusTimer = setInterval(() => {
    renderStatusBar();
  }, 1000);

  // 聊天区滚动: ↑/↓（命令/会话面板激活时优先移动面板选择）
  screen.key(["up"], () => {
    if (cmdState.active && cmdState.rows.length) {
      cmdState.sel = (cmdState.sel - 1 + cmdState.rows.length) % cmdState.rows.length;
      renderCmdPanel();
      return;
    }
    if (sessionState.active) { moveSessionSel(-1); return; }
    if (screen.focused !== inputBox) chatBox.scroll(-1);
    screen.render();
  });
  screen.key(["down"], () => {
    if (cmdState.active && cmdState.rows.length) {
      cmdState.sel = (cmdState.sel + 1) % cmdState.rows.length;
      renderCmdPanel();
      return;
    }
    if (sessionState.active) { moveSessionSel(1); return; }
    if (screen.focused !== inputBox) chatBox.scroll(1);
    screen.render();
  });

  // ---- 键盘选中兜底: Shift+↑/↓ 从聊天区底部逐行扩展选择, Ctrl+K 复制, Esc 取消 ----
  const kbBeginSel = () => {
    if (kbSelStart < 0) kbSelStart = kbSelEnd = Math.max(0, chatLines.length - 1);
  };
  screen.key(["shift-up", "S-up"], () => {
    kbBeginSel();
    kbSelStart = Math.max(0, kbSelStart - 1);
    kbSelEnd = Math.max(kbSelEnd, kbSelStart);
    renderChat();
  });
  screen.key(["shift-down", "S-down"], () => {
    kbBeginSel();
    kbSelEnd = Math.min(chatLines.length - 1, kbSelEnd + 1);
    kbSelStart = Math.min(kbSelStart, kbSelEnd);
    renderChat();
  });
  screen.key(["C-k"], () => {
    if (kbSelStart < 0 || kbSelEnd < kbSelStart) return;
    const lines = plainLines();
    const text = lines.slice(kbSelStart, kbSelEnd + 1).join("\n").replace(/^\n+|\n+$/g, "");
    if (text && text.trim()) {
      copyToClipboard(text);
      showToast();
    }
    kbSelStart = kbSelEnd = -1;
    renderChat();
  });
  screen.key(["escape"], () => {
    if (cmdState.active) { hideCmdPanel(); inputBox.focus(); return; }
    if (sessionState.active) { hideSessionPanel(); inputBox.focus(); return; }
    if (kbSelStart >= 0) {
      kbSelStart = kbSelEnd = -1;
      renderChat();
    }
  });

  // Enter 发送, Shift+Enter 换行, Ctrl+C 退出
  inputBox.key(["enter"], (ch, key) => {
    if (key && key.shift) return; // Shift+Enter: 交给 textarea 原生换行
    const text = inputBox.getValue().trim();
    if (!text) return;
    inputBox.clearValue();
    // 命令面板激活: 用选中命令补全（保留已输入参数）并执行
    if (cmdState.active && cmdState.rows.length) {
      const name = CMD_DEFS[cmdState.sel][0];
      const argPart = text.replace(/^\/\S+/, "").trim();
      const full = "/" + name + (argPart ? " " + argPart : "");
      hideCmdPanel();
      appendChatLine(`{cyan-fg}🧑 你{/cyan-fg}: ${sanitizeTui(full)}`);
      renderStatusBar();
      history.push(text);
      enqueue(() => handleInput(full)).then(() => {
        inputBox.focus();
        screen.render();
      });
      return;
    }
    hideCmdPanel();
    appendChatLine(`{cyan-fg}🧑 你{/cyan-fg}: ${sanitizeTui(text)}`);
    renderStatusBar();
    history.push(text);
    enqueue(() => handleInput(text)).then(() => {
      inputBox.focus();
      screen.render();
    });
  });

  // Ctrl+C 统一退出逻辑，多重兜底（防重入）
  let tuiExiting = false;
  const exitTui = () => {
    if (tuiExiting) return;
    // 面板激活时 Ctrl+C 只关闭面板, 不退出
    if (cmdState.active) { hideCmdPanel(); inputBox.focus(); return; }
    if (sessionState.active) { hideSessionPanel(); inputBox.focus(); return; }
    tuiExiting = true;
    try {
      clearInterval(statusTimer);
      writeHistory(history);
      saveProfile(loadProfile());
    } catch {}
    try { screen.destroy(); } catch {}
    process.exit(0);
  };

  // 1) 按键路径：blessed 解析为 C-c 键序列
  screen.key(["C-c"], exitTui);
  // 2) 兜底：某些终端/SSH 会话下杀键不经过 blessed 键盘表，直接按 keypress 原始序列匹配
  screen.program.on("keypress", (ch, key) => {
    if (key && key.ctrl && (key.name === "c" || key.full === "C-c")) exitTui();
  });
  // 3) 兜底：终端把 Ctrl+C 作为 SIGINT 信号送达（非 raw 字节），或 raw 模式设置失败时
  screen.on("destroy", () => { try { process.removeListener("SIGINT", exitTui); } catch {} });
  process.on("SIGINT", exitTui);
  console.error('PROBE-E exit-handlers installed');
  // 注：blessed 自身也监听 SIGINT，但其内部仅在没有其他监听者时才自行退出，
  // 我们注册后它会跳过，由 exitTui 统一接管。

  // resize 时重排布局并重绘横幅/状态栏，避免半屏切换后重叠错位（banner 中线按旧宽度绘制、状态栏超宽溢出）
  screen.on("resize", () => {
    relayout();
    if (cmdState.active) renderCmdPanel();
    if (sessionState.active) renderSessionPanel();
    renderBanner();
    renderStatusBar();
    screen.render();
  });

  console.error('PROBE-D pre-final-render');
  inputBox.focus();
  screen.render();
  console.error('PROBE-D2 post-final-render');
}