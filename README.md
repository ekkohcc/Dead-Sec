# Dead Sec

AI 渗透测试 agent,用户自带模型 API Key（OpenAI 兼容接口，免费模型通用）。核心理念：**No Exploit, No Report** —— 只报告实际利用/验证过的漏洞。

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

## 使用（对话式）

```bash
dead-sec                    # 进入聊天界面（终端对话框）
dead-sec -u https://your-app.com   # 带目标进入，agent 只围绕该目标行动
dead-sec -u <url> -p "开始扫描"    # 进入后立即执行一条指令
```

聊天界面内命令：

```
/help             显示帮助
/clear            清屏
/target <url>     设定/切换会话目标（注入上下文）
/skills           列出已安装的自定义 skill (当然也可以自然语言添加某个skill)
/use <skill>      手动注入某个 skill
/quit / Ctrl+C    退出
```

agent 会在需要时自动调用工具（灰色日志显示 `⚙ <tool>`），也可以纯聊天问答（自动降级，无需工具）。

## 自动流水线（可选，一次性扫描）

```bash
dead-sec scan -u https://your-app.com [-r /path/to/source] [--quiet]
```

9 阶段：PRE_RECON → RECON → 注入/XSS/认证/SSRF/越权 ×5 分析 → EXPLOITATION（实际利用 + 自动 PoC）→ REPORT（自动整理标准报告，只含已验证漏洞）。

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

**标准报告结构**（report.md，自动生成兜底保证始终存在）：报告信息 → 执行摘要 → 范围与方法 → 漏洞汇总表 → 漏洞详情（描述/复现/PoC/影响/修复） → PoC 索引 → 附录。

**PoC**：对每个验证成功的漏洞自动写入 `pocs/poc_<id>.<py|sh>`，自带目标 URL、payload 和断言，可直接复现。

## 自定义 Skill（你自己的方法论）

你可以添加自己的 skill，agent 会在对话中按需加载执行：

```
~/.dead-sec/skills/<name>/SKILL.md        # 用户级（所有项目可见）
.dead-sec/skills/<name>/SKILL.md          # 项目级（覆盖用户级同名 skill）
```

格式（支持 YAML 风格 frontmatter）：

```markdown
---
name: sqli-check
description: 对登录接口执行快速 SQLi 检查（报错型 + 布尔型）
---

# 步骤

1. 用 fetch_url 获取目标首页，找到登录/查询接口
2. ...
```

创建与查看：

```bash
dead-sec skill new <name>   # 生成模板（用户级）
dead-sec skills             # 列出所有已安装 skill
```

- agent 的系统提示词会注入 skill 清单（name + description），相关时自动调用 `use_skill` 工具加载全文并遵循
- 也可以输入 `/use <name>` 手动注入
- 聊天中 `use_skill` 与其他工具一样在灰色日志中可见

## Agent 工具

`run_command`（扫描/请求/利用）、`read_file`、`search_files`、`fetch_url`、`save_deliverable`、`save_poc`、`use_skill`（加载用户自定义 skill）。

## 免责声明

仅用于**你拥有或已获书面授权**的目标。未授权扫描/渗透测试在多数司法辖区属违法行为。
