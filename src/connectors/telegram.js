// Telegram connector: long-polling Bot API (real, works out of the box)
const API = "https://api.telegram.org/bot";

function apiCall(token, method, params) {
  return fetch(API + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(65000),
  }).then((r) => r.json());
}

export async function initTelegram(cfg, onMessage) {
  const token = cfg.token;
  if (!token) throw new Error("telegram.token 未配置");
  let offset = 0;
  let stopped = false;

  const send = async (chatId, text) => {
    const r = await apiCall(token, "sendMessage", {
      chat_id: chatId,
      text: String(text).slice(0, 4000),
      disable_web_page_preview: true,
    });
    return r.ok ? `sent to ${chatId}` : "ERROR: " + JSON.stringify(r).slice(0, 300);
  };

  const poll = async () => {
    while (!stopped) {
      try {
        const r = await apiCall(token, "getUpdates", { timeout: 30, offset });
        if (r.ok && Array.isArray(r.result)) {
          for (const u of r.result) {
            offset = u.update_id + 1;
            const text = u.message?.text || u.channel_post?.text;
            const chatId = u.message?.chat?.id ?? u.channel_post?.chat?.id;
            if (!text || !chatId) continue;
            onMessage({
              channel: "telegram",
              chatId: String(chatId),
              text,
              from: u.message?.from?.username || "tg-user",
            });
          }
        }
      } catch {
        /* transient */
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 500));
    }
  };

  poll();
  return {
    id: "telegram",
    send,
    dispose: () => {
      stopped = true;
    },
  };
}
