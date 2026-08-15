// Generic webhook connector (WeChat / QQ / any IM bridge):
//  - 接收: 第三方桥 (如 wechaty / onebot / 企业微信机器人等) POST {chat_id, text}
//  - 发送: POST 到配置的 sendUrl {chat_id, text}
import http from "node:http";

export async function initWebhook(cfg, onMessage) {
  const { listen = 8788, path = "/in", sendUrl = "" } = cfg;

  const send = async (chatId, text) => {
    if (!sendUrl) return "webhook.sendUrl 未配置";
    try {
      const r = await fetch(sendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) }),
        signal: AbortSignal.timeout(15000),
      });
      return r.ok ? `sent to ${chatId}` : "ERROR: " + (await r.text()).slice(0, 300);
    } catch (e) {
      return "ERROR: " + e.message;
    }
  };

  let server = null;
  if (listen > 0) {
    server = http.createServer(async (req, res) => {
      if (req.url !== path) {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = "";
      for await (const c of req) body += c;
      let data = {};
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      res.writeHead(200);
      res.end("ok");
      const chatId = data.chat_id || data.chatId || "default";
      const text = data.text || data.message || "";
      if (text) {
        onMessage({ channel: "webhook", chatId: String(chatId), text, from: data.from || "bridge-user" });
      }
    });
    server.listen(listen, () => {
      console.log(`  [webhook] 接收端: http://0.0.0.0:${listen}${path} (供微信/QQ 等桥接器转发)`);
    });
  }

  return {
    id: "webhook",
    send,
    dispose: () => {
      try {
        server?.close();
      } catch {}
    },
  };
}
