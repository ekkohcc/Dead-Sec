import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MEM_DIR =
  process.env.DEAD_SEC_MEMORY_DIR || path.join(os.homedir(), ".dead-sec", "memory");
const SESSIONS_FILE = path.join(MEM_DIR, "sessions.jsonl");
const PROFILE_FILE = path.join(MEM_DIR, "profile.json");

const DEFAULT_PROFILE = () => ({
  preferences: { language: "", style: "", tone: "" },
  facts: [],
  corrections: [],
  model: "",
  msgCount: 0,
  sessionCount: 0,
  firstSeen: null,
  lastSeen: null,
});

let _sessionId = null;
export function getSessionId() {
  if (!_sessionId) _sessionId = "s-" + Date.now().toString(36);
  return _sessionId;
}

export function setSessionId(id) {
  _sessionId = id;
}

function ensureDir() {
  fs.mkdirSync(MEM_DIR, { recursive: true });
}

export function appendSession(entry) {
  try {
    ensureDir();
    const rec = {
      ts: new Date().toISOString(),
      sessionId: getSessionId(),
      channel: entry.channel || "cli",
      role: entry.role,
      content: String(entry.content || ""),
      model: entry.model || "",
      target: entry.target || "",
      title: entry.title || "",
    };
    fs.appendFileSync(SESSIONS_FILE, JSON.stringify(rec) + "\n");
  } catch {
    /* memory is best-effort */
  }
}

function readAll() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    return fs
      .readFileSync(SESSIONS_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 按会话分组: [{sessionId, title, ts(最后时间), count}] 按最近排序
export function listSessions() {
  const byId = new Map();
  for (const rec of readAll()) {
    let g = byId.get(rec.sessionId);
    if (!g) {
      g = { sessionId: rec.sessionId, title: rec.title || "", ts: rec.ts, count: 0 };
      byId.set(rec.sessionId, g);
    }
    g.count++;
    if (rec.ts > g.ts) g.ts = rec.ts;
    if (!g.title && rec.title) g.title = rec.title;
  }
  return [...byId.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

export function renameSession(sessionId, title) {
  try {
    ensureDir();
    const recs = readAll();
    let changed = false;
    for (const r of recs) {
      if (r.sessionId === sessionId) {
        r.title = title;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(SESSIONS_FILE, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } catch {
    /* ignore */
  }
}

// 载入某个会话的全部历史 (不含 memory 内部标记)
export function loadSessionMessages(sessionId) {
  return readAll()
    .filter((r) => r.sessionId === sessionId && (r.role === "user" || r.role === "assistant"))
    .map((r) => ({ role: r.role, content: r.content }));
}

export function loadSessions(limit = 30) {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    const raw = fs.readFileSync(SESSIONS_FILE, "utf8").split("\n").filter(Boolean);
    return raw.slice(-limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function sessionCount() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return 0;
    return new Set(fs.readFileSync(SESSIONS_FILE, "utf8").split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l).sessionId;
      } catch {
        return null;
      }
    })).size;
  } catch {
    return 0;
  }
}

export function loadProfile() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return DEFAULT_PROFILE();
    return { ...DEFAULT_PROFILE(), ...JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8")) };
  } catch {
    return DEFAULT_PROFILE();
  }
}

export function saveProfile(profile) {
  try {
    ensureDir();
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
  } catch {
    /* ignore */
  }
}

// ---- 规则学习: 从对话中提取用户偏好、事实与纠正 ----
export function learn(role, content, model) {
  const text = String(content || "");
  const profile = loadProfile();
  profile.msgCount = (profile.msgCount || 0) + 1;
  profile.lastSeen = new Date().toISOString();
  if (!profile.firstSeen) profile.firstSeen = profile.lastSeen;
  if (model) profile.model = model;

  if (role === "user") {
    const lang =
      /(?:用|说|讲|回复|回答)?(中文|简体中文|简体|英文|英语|英文回复|日语|日文|韩语|法语|西班牙语)/i.exec(text);
    if (lang) profile.preferences.language = lang[1].replace(/(用|说|讲|回复|回答)/, "");

    const style = /(简洁|简短|简明|详细|啰嗦|废话少|言简意赅|展开|长篇|字少)/.exec(text);
    if (style) profile.preferences.style = style[1];

    const tone = /(正式|随意|轻松|严肃|口语|专业|幽默)/.exec(text);
    if (tone) profile.preferences.tone = tone[1];

    const fact = /^记住[:：]?\s*(.+)$/.exec(text.trim()) || /(?:记住|以后都要|每次都要|从现在起)\s*(.+)/.exec(text);
    if (fact) {
      const f = fact[1].trim().slice(0, 120);
      if (f && !profile.facts.includes(f)) {
        profile.facts.push(f);
        if (profile.facts.length > 10) profile.facts.shift();
      }
    }

    if (/不对|错了|不是[这那]?样|说错|讲错|改掉|别这样|不要[这样再]?|错了[！!]|再想想|重新来/.test(text)) {
      const c = text.replace(/\s+/g, " ").slice(0, 120);
      if (!profile.corrections.includes(c)) {
        profile.corrections.push(c);
        if (profile.corrections.length > 5) profile.corrections.shift();
      }
    }
  }

  saveProfile(profile);
  return profile;
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

export function buildMemoryBlock(limit = 5) {
  const profile = loadProfile();
  const parts = [];
  const prefs = profile.preferences || {};
  const prefBits = [];
  if (prefs.language) prefBits.push(`语言=${prefs.language}`);
  if (prefs.style) prefBits.push(`风格=${prefs.style}`);
  if (prefs.tone) prefBits.push(`语气=${prefs.tone}`);
  if (prefBits.length) parts.push(`- 用户偏好: ${prefBits.join(", ")}`);
  if (profile.facts?.length) parts.push(`- 用户说过要记住: ${profile.facts.slice(-3).join("; ")}`);
  if (profile.corrections?.length) {
    parts.push(`- 曾被用户纠正: ${profile.corrections.slice(-2).map((c) => stripAnsi(c).slice(0, 60)).join(" | ")}`);
  }
  if (profile.msgCount) parts.push(`- 已服务 ${profile.msgCount} 条消息 / ${profile.sessionCount || sessionCount()} 次会话`);

  const recent = loadSessions(limit);
  if (recent.length) {
    const ctx = recent
      .map((r) => `[${(r.ts || "").slice(11, 19)} ${r.role}] ${stripAnsi(r.content).slice(0, 140)}`)
      .join("\n");
    parts.push(`- 最近对话片段:\n${ctx}`);
  }
  return parts.length ? parts.join("\n") : "";
}
