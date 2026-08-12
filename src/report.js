import fs from "node:fs";
import path from "node:path";

import { DELIVERABLES, POCS } from "./tools.js";

export function buildStandardReport(url, repo) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const evPath = path.join(DELIVERABLES, "exploitation_evidence.md");
  let findings = [];
  if (fs.existsSync(evPath)) {
    const raw = fs.readFileSync(evPath, "utf8").trim();
    try {
      const parsed = JSON.parse(raw);
      findings = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      findings = [{ status: "UNKNOWN", evidence: raw.slice(0, 3000) }];
    }
  }
  const valid = findings.filter((f) => String(f.status).toUpperCase() === "VALIDATED");
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
  for (const f of valid) {
    const sev = String(f.severity || "Info");
    counts[sev] = (counts[sev] || 0) + 1;
  }
  const pocs = fs.existsSync(POCS) ? fs.readdirSync(POCS).sort() : [];
  const deliverables = fs.existsSync(DELIVERABLES) ? fs.readdirSync(DELIVERABLES).sort() : [];

  const L = [];
  L.push("# 漏洞检测报告 (Vulnerability Assessment Report)");
  L.push("");
  L.push("| 项目 | 内容 |");
  L.push("| --- | --- |");
  L.push(`| 目标 (Target) | ${url} |`);
  L.push(`| 源码 (Repository) | ${repo || "无 (黑盒测试)"} |`);
  L.push(`| 测试日期 (Date) | ${dateStr} |`);
  L.push(`| 测试工具 (Tool) | Dead Sec AI Pentester v1.0.0 |`);
  L.push("| 方法学 (Methodology) | Pre-Recon → Recon → Vulnerability Analysis → Exploitation → Reporting |");
  L.push(`| 原则 (Principle) | No Exploit, No Report |`);
  L.push("");
  L.push("## 1. 执行摘要 (Executive Summary)");
  L.push("");
  L.push(`本次测试共发现 **${valid.length}** 个已验证漏洞：Critical ${counts.Critical} 个, High ${counts.High} 个, Medium ${counts.Medium} 个, Low ${counts.Low} 个。`);
  L.push("");
  L.push("## 2. 范围与方法 (Scope & Methodology)");
  L.push("");
  L.push("| 阶段 | 内容 |");
  L.push("| --- | --- |");
  L.push("| 1. Pre-Recon | 指纹收集、子域名/端口/技术栈识别、源码密钥与入口点扫描 |");
  L.push("| 2. Recon | 攻击面映射：端点、参数、表单、认证机制 |");
  L.push("| 3. Vulnerability Analysis | 五类漏洞假设：Injection / XSS / Auth / SSRF / Authz |");
  L.push("| 4. Exploitation | 实际利用验证，自动生成 PoC，未验证的丢弃 |");
  L.push("| 5. Reporting | 汇总只含已验证发现的标准化报告 |");
  L.push("");
  L.push("## 3. 漏洞汇总表 (Findings Summary)");
  L.push("");
  L.push("| ID | 严重等级 | 标题 | 端点 | 状态 |");
  L.push("| --- | --- | --- | --- | --- |");
  if (valid.length === 0) {
    L.push("| - | - | 未发现已验证漏洞 | - | - |");
  }
  valid.forEach((f, i) => {
    const id = f.id || `DS-${String(i + 1).padStart(3, "0")}`;
    L.push(`| ${id} | ${f.severity || "Info"} | ${f.title || f.endpoint || "N/A"} | ${f.endpoint || "-"} | VALIDATED |`);
  });
  L.push("");
  L.push("## 4. 漏洞详情 (Findings Detail)");
  L.push("");
  if (valid.length === 0) {
    L.push("无。");
  }
  valid.forEach((f, i) => {
    const id = f.id || `DS-${String(i + 1).padStart(3, "0")}`;
    L.push(`### ${id} - ${f.title || "N/A"}`);
    L.push("");
    L.push(`- **严重等级 (Severity)**: ${f.severity || "Info"}`);
    L.push(`- **端点 (Endpoint)**: ${f.endpoint || "-"}`);
    L.push(`- **状态 (Status)**: VALIDATED`);
    L.push("");
    L.push("**描述 (Description)**");
    L.push("");
    L.push(f.description || "-");
    L.push("");
    L.push("**复现步骤 (Reproduction Steps)**");
    L.push("");
    L.push(f.reproduction || f.evidence || "-");
    L.push("");
    L.push("**PoC (Proof of Concept)**");
    L.push("");
    L.push(f.poc_file ? `\`${f.poc_file}\` (位于 \`.dead-sec/pocs/\` 目录)` : "-");
    L.push("");
    L.push("**修复建议 (Remediation)**");
    L.push("");
    L.push(f.remediation || "-");
    L.push("");
    L.push("---");
    L.push("");
  });
  L.push("## 5. PoC 文件索引 (PoC Index)");
  L.push("");
  if (pocs.length === 0) {
    L.push("无。");
  }
  for (const p of pocs) {
    L.push(`- \`${p}\``);
  }
  L.push("");
  L.push("## 6. 附录：交付物 (Appendix: Deliverables)");
  L.push("");
  for (const d of deliverables) {
    L.push(`- \`${d}\``);
  }
  L.push("");
  return L.join("\n");
}
