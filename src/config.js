import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const CONFIG_DIR = path.join(os.homedir(), ".dead-sec");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const PRESETS = {
  "1": ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
  "2": ["Gemini 免费版", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-3.6-flash"],
  "3": ["Groq 免费版", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
  "4": ["xAI", "https://api.x.ai/v1", "grok-3-mini"],
  "5": ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
  "6": ["Ollama 本机", "http://localhost:11434/v1", "qwen3:32b"],
  "7": ["Custom Base URL", null, null],
};

export async function setup() {
  const isTTY = !!process.stdin.isTTY;
  let queue = [];
  if (!isTTY) {
    const pre = readline.createInterface({ input: process.stdin });
    for await (const line of pre) queue.push(line.trim());
  }
  let idx = 0;
  const ask = (q, fallback) =>
    new Promise((resolve) => {
      if (isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => {
          rl.close();
          resolve(a.trim() || fallback);
        });
      } else {
        const a = queue[idx++] ?? "";
        console.log(q + " " + (a || fallback || ""));
        resolve(a || fallback);
      }
    });
  console.log("┌  Dead Sec Setup");
  for (const [k, [name]] of Object.entries(PRESETS)) {
    console.log(`│  ${k}. ${name}`);
  }
  const choice = String((await ask("│  Select provider (1-7): "))).trim();
  const preset = PRESETS[choice];
  if (!preset) {
    console.log("Invalid choice");
    process.exit(1);
  }
  let [, baseUrl, model] = preset;
  if (choice === "7") {
    baseUrl = (await ask("│  Base URL (e.g. https://api.example.com/v1): ", "")).trim();
    model = (await ask("│  Model name: ", "")).trim();
  } else {
    baseUrl = String(await ask(`│  Base URL [${baseUrl}]: `, baseUrl)).replace(/\/+$/, "");
    model = String(await ask(`│  Model [${model}]: `, model));
  }
  const key = (await ask("│  API Key (留空则从环境变量 DEAD_SEC_API_KEY 读取): ", "")).trim();
  const cfg = { provider: preset[0], baseUrl, model };
  if (key) cfg.apiKey = key;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
  console.log(`└  Saved to ${CONFIG_PATH}`);
}

export function load() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }
  cfg.apiKey = process.env.DEAD_SEC_API_KEY || cfg.apiKey || "";
  cfg.baseUrl = process.env.DEAD_SEC_BASE_URL || cfg.baseUrl || "";
  cfg.model = process.env.DEAD_SEC_MODEL || cfg.model || "";
  const missing = [];
  if (!cfg.baseUrl) missing.push("base_url");
  if (!cfg.model) missing.push("model");
  if (!cfg.apiKey) missing.push("api_key (或设置 DEAD_SEC_API_KEY)");
  if (missing.length) {
    console.error("配置缺失: " + missing.join(", "));
    console.error("请先运行: dead-sec setup");
    process.exit(1);
  }
  return cfg;
}
