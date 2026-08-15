import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initTelegram } from "./telegram.js";
import { initFeishu } from "./feishu.js";
import { initWebhook } from "./webhook.js";

export const CONFIG_PATH = path.join(os.homedir(), ".dead-sec", "connectors.json");

export function loadConnectorsConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeConnectorsConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`已写入 ${CONFIG_PATH}`);
}

const TEMPLATE = {
  telegram: { enabled: false, token: "" },
  feishu: { enabled: false, webhookUrl: "", listen: 8787, path: "/feishu" },
  webhook: { enabled: false, listen: 8788, path: "/in", sendUrl: "" },
};

export function initConnectorsConfig() {
  writeConnectorsConfig(TEMPLATE);
}

// onMessage: ({channel, chatId, text, from}) => void
export async function initConnectors(onMessage) {
  const cfg = loadConnectorsConfig();
  const active = [];
  if (cfg.telegram?.enabled) {
    try {
      active.push(await initTelegram(cfg.telegram, onMessage));
      console.log("  [telegram] 已连接 (long polling)");
    } catch (e) {
      console.error("  [telegram] 初始化失败: " + e.message);
    }
  }
  if (cfg.feishu?.enabled) {
    try {
      active.push(await initFeishu(cfg.feishu, onMessage));
      console.log("  [feishu] 已启用 (webhook 发送 + 事件订阅接收)");
    } catch (e) {
      console.error("  [feishu] 初始化失败: " + e.message);
    }
  }
  if (cfg.webhook?.enabled) {
    try {
      active.push(await initWebhook(cfg.webhook, onMessage));
      console.log("  [webhook] 已启用 (微信/QQ 桥接)");
    } catch (e) {
      console.error("  [webhook] 初始化失败: " + e.message);
    }
  }
  return active;
}
