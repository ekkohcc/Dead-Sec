import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";

const CONFIG_DIR = path.join(os.homedir(), ".dead-sec");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const KEY_FILE = path.join(CONFIG_DIR, ".key");

const PRESETS = {
  "1": ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
  "2": ["Gemini 免费版", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-3.6-flash"],
  "3": ["Groq 免费版", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
  "4": ["xAI", "https://api.x.ai/v1", "grok-3-mini"],
  "5": ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
  "6": ["Ollama 本机", "http://localhost:11434/v1", "qwen3:32b"],
  "7": ["Agnes", "https://apihub.agnes-ai.com/v1", "agnes-2.5-flash"],
  "8": ["Custom Base URL", null, null],
};

function getMasterKey() {
  try {
    if (!fs.existsSync(KEY_FILE)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    }
    const k = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (k.length >= 32) return Buffer.from(k.slice(0, 64), "hex");
    throw new Error("bad key");
  } catch {
    return crypto.createHash("sha256").update(os.hostname() + "dead-sec-fallback").digest();
  }
}

export function encryptSecret(plain) {
  if (!plain) return "";
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return "enc:" + [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(payload) {
  if (!payload) return "";
  if (typeof payload !== "string" || !payload.startsWith("enc:")) return payload; // 旧版明文
  try {
    const [ivB, tagB, ctB] = payload.slice(4).split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getMasterKey(), Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

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
  // 掩码输入: API Key 逐字符回显为 *，Enter 确认，Backspace 删除，Ctrl+C 中止
  const askSecret = (q) =>
    new Promise((resolve) => {
      if (!isTTY) {
        const a = queue[idx++] ?? "";
        console.log(q + " " + (a ? "********" : ""));
        resolve(a || "");
        return;
      }
      process.stdout.write(q);
      try {
        process.stdin.pause();
        process.stdin.removeAllListeners("keypress");
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();
      } catch {
        /* fall through to plain read */
      }
      let buf = "";
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        try {
          process.stdin.setRawMode(false);
        } catch {}
        process.stdin.removeListener("keypress", onKey);
        process.stdout.write("\n");
        resolve(val);
      };
      const onKey = (ch, key) => {
        if (!key) return;
        if (key.name === "return") return finish(buf);
        if (key.ctrl && key.name === "c") return finish("");
        if (key.name === "backspace") {
          buf = buf.slice(0, -1);
          process.stdout.write("\r\x1b[K" + q + "*".repeat(buf.length));
          return;
        }
        if (ch && typeof ch === "string" && !key.ctrl && !key.meta && ch !== "\r" && ch !== "\n") {
          buf += ch;
          process.stdout.write("*");
        }
      };
      process.stdin.on("keypress", onKey);
    });
  console.log("┌  Dead Sec Setup");
  for (const [k, [name]] of Object.entries(PRESETS)) {
    console.log(`│  ${k}. ${name}`);
  }
  const choice = String((await ask("│  Select provider (1-8): "))).trim();
  const preset = PRESETS[choice];
  if (!preset) {
    console.log("Invalid choice");
    process.exit(1);
  }
  let [, baseUrl, model] = preset;
  if (choice === "8") {
    baseUrl = (await ask("│  Base URL (e.g. https://api.example.com/v1): ", "")).trim();
    model = (await ask("│  Model name: ", "")).trim();
  } else {
    baseUrl = String(await ask(`│  Base URL [${baseUrl}]: `, baseUrl)).replace(/\/+$/, "");
    model = String(await ask(`│  Model [${model}]: `, model));
  }
  const key = await askSecret("│  API Key (留空则从环境变量 DEAD_SEC_API_KEY 读取): ");
  const cfg = { provider: preset[0], baseUrl, model };
  if (key) cfg.apiKey = encryptSecret(key); // 加密落盘，密钥在 ~/.dead-sec/.key
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
  console.log(`└  Saved to ${CONFIG_PATH} (API key encrypted)`);
}

export function load() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }
  if (!cfg.apiKeyEnc && cfg.apiKey?.startsWith?.("enc:")) cfg.apiKeyEnc = cfg.apiKey;
  cfg.apiKey = process.env.DEAD_SEC_API_KEY || decryptSecret(cfg.apiKeyEnc || cfg.apiKey) || "";
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
