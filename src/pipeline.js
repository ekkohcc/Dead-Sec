import fs from "node:fs";
import path from "node:path";

import { runAgent } from "./agent.js";
import { load } from "./config.js";
import { buildStandardReport } from "./report.js";
import { DELIVERABLES } from "./tools.js";

const PHASES = {
  PRE_RECON: `External footprinting and source-code mapping.
- If a repo path is given: search for hardcoded secrets (API_KEY, SECRET, password, token), map entry points (controllers, routes, handlers).
- If the target is a live web app/API: run nmap/subfinder/whatweb (via run_command) to fingerprint ports, subdomains, tech stack.
- Save a PRE_RECON deliverable with everything found.`,
  RECON: `Attack-surface mapping of the live application.
- Fetch the app, map all forms, links, API endpoints, URL parameters, auth mechanisms.
- Correlate with source code if available.
- Save a RECON deliverable listing endpoints and parameters.`,
  INJECTION_ANALYSIS: `Analyze the surface for injection vulnerabilities (SQLi, command injection, SSTI, XXE, NoSQLi).
- Form concrete, testable hypotheses with exact endpoints and payload ideas.
- Save an INJECTION_ANALYSIS deliverable (JSON: endpoint, parameter, injection type, hypothesis).`,
  XSS_ANALYSIS: `Analyze for XSS (stored/reflected/DOM). Identify input reflection points and output contexts.
- Form concrete hypotheses. Save an XSS_ANALYSIS deliverable.`,
  AUTH_ANALYSIS: `Analyze authentication and session management (broken auth, token/JWT flaws, session fixation, password reset flaws).
- Form concrete hypotheses. Save an AUTH_ANALYSIS deliverable.`,
  SSRF_ANALYSIS: `Analyze for SSRF: user-controllable URLs, fetchers, proxies, redirects, file/url params that reach internal services.
- Form concrete hypotheses. Save an SSRF_ANALYSIS deliverable.`,
  AUTHZ_ANALYSIS: `Analyze for broken access control and IDOR: object IDs in URLs/API, missing role checks, mass assignment.
- Form concrete hypotheses. Save an AUTHZ_ANALYSIS deliverable.`,
  EXPLOITATION: `Validate the hypotheses recorded in the analysis deliverables.
- Read .dead-sec/deliverables/*analysis*.md, attempt practical exploitation against the live target with real payloads.
- Capture evidence: HTTP responses, commands, output.
- For EVERY finding you validate, also generate a complete runnable PoC script and save it with the save_poc tool (id: unique like DS-001-sql-login-bypass, language: python|bash|curl, content: self-contained script with target URL, payloads, expected output).
- Then save an EXPLOITATION_EVIDENCE deliverable via save_deliverable: a JSON array, each entry {id, title, severity (Critical/High/Medium/Low), endpoint, status (VALIDATED|UNCONFIRMED), description, reproduction, evidence, poc_file (filename in .dead-sec/pocs/), remediation}.
- Mark each hypothesis VALIDATED (with evidence + PoC) or UNCONFIRMED (do not report).`,
  REPORT: `Compile the final professional vulnerability report and save it as a REPORT deliverable (report.md).
Read all .dead-sec/deliverables/*.md and the PoC files in .dead-sec/pocs/.
Follow EXACTLY this standard structure (markdown):
1. 报告信息 (target, 测试日期, 工具 Dead Sec, 模式白盒/黑盒)
2. 执行摘要 (统计: 已验证发现总数、Critical/High/Medium/Low 数量)
3. 范围与方法 (5 阶段流水线)
4. 漏洞汇总表 (ID | 严重等级 | 标题 | 端点 | 状态)
5. 漏洞详情 - 每个已验证发现一节: 描述 / 复现步骤 / PoC(引用 .dead-sec/pocs/ 中文件名与执行方式) / 影响 / 修复建议
6. 附录 (交付物列表)
Only include VALIDATED findings (No Exploit, No Report).`,
};

const VULN_CLASSES = [
  "INJECTION_ANALYSIS",
  "XSS_ANALYSIS",
  "AUTH_ANALYSIS",
  "SSRF_ANALYSIS",
  "AUTHZ_ANALYSIS",
];

export async function run(url, repo, verbose = true) {
  const cfg = load();
  fs.mkdirSync(DELIVERABLES, { recursive: true });
  const steps = ["PRE_RECON", "RECON", ...VULN_CLASSES, "EXPLOITATION", "REPORT"];
  const total = steps.length;
  for (let i = 0; i < total; i++) {
    const name = steps[i];
    console.log(`== Phase ${i + 1}/${total}: ${name} ==`);
    await runAgent(cfg, name, PHASES[name], url, repo, 25, verbose);
  }
  const report = path.join(DELIVERABLES, "report.md");
  if (fs.existsSync(report)) {
    console.log(`\nDone. Report: ${report}`);
  } else {
    fs.writeFileSync(report, buildStandardReport(url, repo));
    console.log(`\nDone. Standard report auto-generated: ${report}`);
  }
}
