export async function chat(cfg, messages, { jsonMode = false, temperature = 0.2, timeout = 180 } = {}) {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const payload = { model: cfg.model, messages, temperature };
  if (jsonMode) payload.response_format = { type: "json_object" };
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (e) {
    throw new Error("LLM request failed: " + e.message);
  }
  if (resp.status === 400 && jsonMode) {
    return chat(cfg, messages, { jsonMode: false, temperature, timeout });
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`LLM API error ${resp.status}: ${body.slice(0, 500)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (content == null) {
    throw new Error("Unexpected LLM response: " + JSON.stringify(data).slice(0, 500));
  }
  return { content, usage: data.usage || null };
}
