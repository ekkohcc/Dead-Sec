import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const USER_SKILLS_DIR = path.join(os.homedir(), ".dead-sec", "skills");
export const PROJECT_SKILLS_DIR = path.join(process.cwd(), ".dead-sec", "skills");

let _cache = null;
let _cacheStamp = 0;

export function parseSkill(raw) {
  const m = raw.match(/^\ufeff?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (m) {
    let lastKey = null;
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (kv) {
        lastKey = kv[1].trim();
        meta[lastKey] = kv[2].trim().replace(/^['"]|['"]$/g, "");
      } else {
        const item = line.match(/^\s*-\s*(.*)$/);
        if (item && lastKey) {
          if (!Array.isArray(meta[lastKey])) meta[lastKey] = [meta[lastKey]];
          meta[lastKey].push(item[1].trim().replace(/^['"]|['"]$/g, ""));
        }
      }
    }
    body = m[2].trim();
  }
  return {
    name: meta.name || "",
    description: meta.description || "",
    extras: meta,
    body,
  };
}

export function discoverSkills({ refresh = false } = {}) {
  if (_cache && !refresh) return _cache;
  const found = new Map();
  for (const base of [USER_SKILLS_DIR, PROJECT_SKILLS_DIR]) {
    if (!fs.existsSync(base)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(base, entry);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      let skillFile = null;
      if (stat.isDirectory()) {
        const candidate = path.join(dir, "SKILL.md");
        if (fs.existsSync(candidate)) skillFile = candidate;
      } else if (entry.endsWith(".md")) {
        skillFile = dir;
      }
      if (!skillFile) continue;
      let parsed;
      try {
        parsed = parseSkill(fs.readFileSync(skillFile, "utf8"));
      } catch {
        continue;
      }
      const name = parsed.name || path.basename(skillFile, ".md");
      found.set(name, {
        name,
        description: parsed.description || "",
        body: parsed.body,
        extras: parsed.extras,
        source: base === USER_SKILLS_DIR ? "user" : "project",
        file: skillFile,
      });
    }
  }
  _cache = [...found.values()];
  return _cache;
}

export function getSkill(name) {
  return discoverSkills().find((s) => s.name === name) || null;
}

const FLAT_FIELDS = ["domain", "subdomain", "display_name", "category", "version", "author", "description_en", "description_zh"];

let _indexCache = null;

function toIndexText(s) {
  if (!_indexCache) _indexCache = new Map();
  if (_indexCache.has(s.file)) return _indexCache.get(s.file);
  const extra = FLAT_FIELDS.map((k) => (Array.isArray(s.extras[k]) ? s.extras[k].join(" ") : s.extras[k] || "")).join(" ");
  const tags = (Array.isArray(s.extras.tags) ? s.extras.tags.join(" ") : s.extras.tags || "").trim();
  const text = `${s.name} ${s.description} ${extra} ${tags}`.toLowerCase();
  _indexCache.set(s.file, text);
  return text;
}

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "for", "on", "with", "and", "or", "is", "are", "do", "does", "how",
  "what", "when", "where", "which", "why", "can", "could", "should", "would", "will", "you", "your", "me",
  "use", "using", "从", "把", "对", "用", "帮", "给", "为", "请", "我", "你", "的", "了", "一下", "这个",
  "服务器", "排查", "看看", "处理", "怎么", "什么", "是否",
]);

const CJK_STOP = new Set(["帮我", "一下", "这个", "那个", "什么", "怎么", "是否", "没有", "一下", "分析下"]);

function tokenize(text) {
  const tokens = new Set();
  for (const m of text.matchAll(/[a-z0-9]+(?:[-+][a-z0-9]+)*/g)) {
    const t = m[0];
    if (t.length < 2 || STOP.has(t)) continue;
    tokens.add(t);
  }
  const cjkRuns = [];
  for (const m of text.matchAll(/[\u4e00-\u9fff]+/g)) cjkRuns.push(m[0]);
  for (const run of cjkRuns) {
    if (run.length <= 3) {
      if (!CJK_STOP.has(run) && !STOP.has(run)) tokens.add(run);
    } else {
      for (let i = 0; i + 1 < run.length; i++) {
        const g = run.slice(i, i + 2);
        if (!CJK_STOP.has(g) && !STOP.has(g)) tokens.add(g);
      }
    }
  }
  return [...tokens];
}

const NAME_CJK = /\b[a-z0-9]+ cas?e\b|备案|合规|工控|勒索|钓鱼|渗透|审计/;

const TERM_ALIASES = [
  [/恶意域名|恶意链接|恶意网址|恶意url/g, "malicious domain url"],
  [/恶意pdf|恶意文件/g, "malicious pdf file"],
  [/勒索软件|勒索病毒/g, "ransomware"],
  [/数据看板|看板报表|可视化报表/g, "dashboard visualization report"],
  [/断网|网络不通|网络故障|掉线|连不上|网络排查/g, "network troubleshooting"],
  [/故障|不通|断网|排查/g, "troubleshooting"],
  [/暗网|深网/g, "darkweb"],
  [/监控/g, "monitoring"],
  [/内存/g, "memory"],
  [/转储|dump/g, "dump"],
  [/入侵|被黑|被入侵|入侵检测/g, "intrusion detection"],
  [/恶意软件|恶意样本|恶意脚本|恶意文件/g, "malware"],
  [/钓鱼/g, "phishing"],
  [/提权/g, "privilege escalation"],
  [/越权|越权访问|授权绕过/g, "authorization bypass"],
  [/凭据|密码凭证/g, "credential"],
  [/爆破/g, "brute force"],
  [/注入/g, "injection"],
  [/漏洞/g, "vulnerability"],
  [/审计|检查|检测/g, "audit scan detect"],
  [/报告/g, "report"],
  [/渗透/g, "penetration pentest"],
  [/应急/g, "incident response"],
  [/取证/g, "forensics"],
  [/外泄|泄露/g, "leak exfiltration"],
  [/僵尸网络|木马|病毒/g, "botnet trojan virus"],
  [/容器/g, "container"],
  [/云计算|云安全/g, "cloud"],
  [/工控|工业/g, "industrial control scada ot"],
  [/溯源/g, "attribution"],
  [/情报/g, "intelligence"],
  [/邮件/g, "email"],
  [/网络/g, "network"],
  [/流量/g, "traffic packets"],
  [/日志/g, "logs"],
  [/基因|指纹|特征/g, "fingerprint"],
  [/加固/g, "hardening"],
  [/合规/g, "compliance"],
  [/设备/g, "device"],
  [/域名/g, "domain"],
  [/exe|可执行/g, "pe executable"],
  [/看板|报表|可视化/g, "dashboard visualization"],
];

function aliasTokens(text) {
  const extra = new Set();
  for (const [re, en] of TERM_ALIASES) {
    if (re.test(text)) {
      for (const w of tokenize(en)) extra.add(w);
    }
  }
  return [...extra];
}

function nameSegments(skillName) {
  return skillName.split("-");
}

function countHits(text, token) {
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(token, i)) !== -1) {
    n++;
    i += token.length;
  }
  return n;
}

export function matchSkills(query, topN = 3) {
  const skills = discoverSkills();
  if (!skills.length) return [];
  const raw = String(query || "").toLowerCase();
  const baseTokens = new Set(tokenize(raw));
  const aliasTokensSet = new Set(aliasTokens(raw));
  if (!baseTokens.size && !aliasTokensSet.size) return [];
  const scored = [];
  for (const s of skills) {
    const index = toIndexText(s);
    const segs = nameSegments(s.name.toLowerCase());
    let score = 0;
    for (const t of baseTokens) {
      if (segs.includes(t)) score += 6 * countHits(s.name.toLowerCase(), t) || 6;
      else if (index.includes(t)) score += 4 + Math.min(countHits(index, t) - 1, 2);
    }
    for (const t of aliasTokensSet) {
      if (baseTokens.has(t)) continue;
      if (segs.includes(t)) score += 3;
      else if (index.includes(t)) score += 2;
    }
    if (score > 0) scored.push({ skill: s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((x) => x.skill);
}

export function catalogText() {
  const skills = discoverSkills();
  if (!skills.length) {
    return "No custom skills installed. Users can add their own skills as ~/.dead-sec/skills/<name>/SKILL.md (or ./.dead-sec/skills/).";
  }
  return `${skills.length} custom skills installed; relevant ones are auto-matched and injected for each request (no manual selection needed).`;
}

export function scaffoldSkill(name) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    return { ok: false, error: "skill name must match [A-Za-z0-9_-], max 64 chars" };
  }
  const dir = path.join(USER_SKILLS_DIR, name);
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) {
    return { ok: false, error: `skill already exists: ${file}` };
  }
  fs.mkdirSync(dir, { recursive: true });
  const template = `---
name: ${name}
description: 一句话说明这个 skill 做什么（匹配到相关任务时会被自动注入）
---

# ${name}

在这里写你的 skill 指令。当用户请求与本文档相关时，会被自动匹配并注入遵循。

## 用法
- 步骤 1...
- 步骤 2...

## 注意
- 只针对已授权的目标执行操作。
`;
  fs.writeFileSync(file, template);
  fs.chmodSync(file, 0o600);
  return { ok: true, file };
}

export function displaySkills() {
  const skills = discoverSkills();
  if (!skills.length) {
    return "未安装自定义 skill。\n使用 dead-sec skill new <name> 创建，或手动放到 ~/.dead-sec/skills/<name>/SKILL.md（项目级: ./.dead-sec/skills/）。";
  }
  return skills
    .map(
      (s, i) =>
        `${i + 1}. ${s.name} [${s.source}]${s.description ? " - " + s.description : ""}\n   ${s.file}`,
    )
    .join("\n");
}