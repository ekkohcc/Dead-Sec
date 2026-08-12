# Dead Sec

AI 渗透测试 用户自带模型 API Key（OpenAI 兼容接口，免费模型通用）。核心理念：**No Exploit, No Report** —— 只报告实际利用/验证过的漏洞。

## 安装

```bash
npm install -g .          # 在项目目录安装（或 npm install -g dead-sec 从 npm 安装）
```

## 配置你的模型 API

```bash
dead-sec setup
```

支持预设：OpenAI / Gemini 免费版 / Groq 免费版 / xAI / DeepSeek / Ollama 本机 / Custom Base URL。

也可以不写进配置，全部用环境变量：

```bash
export DEAD_SEC_API_KEY=你的key
export DEAD_SEC_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
export DEAD_SEC_MODEL=gemini-3.6-flash
```

## 运行

```bash
# 白盒：有源码
dead-sec start -u https://your-app.com -r /path/to/source

# 黑盒：无源码
dead-sec start -u https://your-app.com -r ""
```

## 流水线（5 阶段）

1. `PRE_RECON` — 指纹收集 + 源码密钥/入口点搜索
2. `RECON` — 攻击面映射（端点、参数、认证）
3. 漏洞分析 ×5 — injection / xss / auth / ssrf / authz 五类假设生成
4. `EXPLOITATION` — 实际利用验证，**自动生成 PoC 脚本**，未验证的丢弃
5. `REPORT` — **自动整理成标准漏洞报告**，只含已验证漏洞

## 输出

```
.dead-sec/
├── deliverables/     # 各阶段交付物
│   ├── pre_recon.md / recon.md
│   ├── injection_analysis.md / xss_analysis.md / auth_analysis.md / ssrf_analysis.md / authz_analysis.md
│   ├── exploitation_evidence.md   # 结构化 JSON: 漏洞 ID/等级/端点/验证状态/证据
│   └── report.md                  # 标准漏洞报告
└── pocs/             # 每个已验证漏洞的可运行 PoC 脚本
    └── poc_DS-001-sql-login-bypass.py
```

**标准报告结构**（report.md，模型跑完 REPORT 阶段后由程序兜底自动生成，保证始终存在）：
报告信息 → 执行摘要（各等级数量统计） → 范围与方法 → 漏洞汇总表（ID/等级/端点/状态） → 漏洞详情（描述/复现步骤/PoC/影响/修复建议） → PoC 文件索引 → 附录

**PoC**：EXPLOITATION 阶段对每个验证成功的漏洞自动写入 `pocs/poc_<id>.<py|sh>`，脚本自带目标 URL、payload 和断言，可直接运行复现。

## Agent 工具

`run_command`（扫描/请求/利用）、`read_file`、`search_files`、`fetch_url`、`save_deliverable`（阶段交付物）、`save_poc`（PoC 脚本）。

## 免责声明

仅用于**你拥有或已获书面授权**的目标。未授权扫描/渗透测试在多数司法辖区属违法行为。
# Dead-Sec
