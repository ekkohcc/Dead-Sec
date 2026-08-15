// Feishu (Lark) connector:
//  - 发送: 群机器人 incoming webhook
//  - 接收: 事件订阅回调 (im.message.receive_v1), 按 open_chat_id 区分会话,
//    单聊/群聊/多人共用同一机器人互不影响 (每个 chat 独立上下文)
import http from "node:http";

export async function initFeishu(cfg, onMessage) {
  const { webhookUrl = "", listen = 8787, path = "/feishu" } = cfg;

  const send = async (chatId, text) => {
    if (!webhookUrl) return "feishu.webhookUrl 未配置";
    const body = { msg_type: "text", content: JSON.stringify({ text: String(text).slice(0, 2000) }) };
    try {
      const r = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return r.ok ? `sent to ${chatId || "group"}` : "ERROR: " + (await r.text()).slice(0, 300);
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
      if (data.challenge != null) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: data.challenge }));
        return;
      }
      res.writeHead(200);
      res.end("ok");
      try {
        const ev = data.event;
        const chatId = ev?.message?.chat_id;
        const raw = ev?.message?.content;
        if (!chatId || !raw) return;
        const text = (JSON.parse(raw)?.text ?? "").trim();
        if (!text) return;
        onMessage({
          channel: "feishu",
          chatId: String(chatId),
          text,
          from: ev.sender?.sender_id?.open_id || "feishu-user",
        });
      } catch {
        /* ignore malformed events */
      }
    });
    server.listen(listen, () => {
      console.log(`  [feishu] 接收端: http://0.0.0.0:${listen}${path} (在飞书开放平台配置为事件订阅回调地址)`);
    });
  }

  return {
    id: "feishu",
    send,
    dispose: () => {
      try {
        server?.close();
      } catch {}
    },
  };
}
