import { chat } from "./llm.js";
import { TOOLS, dispatch } from "./tools.js";

const BASE_PROMPT = `You are Dead Sec, an autonomous AI penetration tester for web applications and APIs.

Operating principles:
- No Exploit, No Report: never report a vulnerability you have not practically exploited or validated against the live target.
- You have access to tools. Reason step by step and call tools until the phase objective is complete.
- Only interact with the assigned target. Never scan or attack anything else.
- At the end of a phase, persist your findings with the save_deliverable tool, then reply with your final output.

Output ONLY a single JSON object with exactly this schema:
{"thought": "your reasoning", "tool": "tool_name or null", "tool_input": {"arg": "value"} or null, "final": "final phase output or null"}

Rules:
- If you want to call a tool: set tool and tool_input, leave final as null.
- If the phase is done: set final to the complete phase output, set tool to null.
- If you called save_deliverable and the phase is done, set final too.
- Never output anything other than the JSON object.`;

const TOOL_LIST = JSON.stringify(TOOLS, null, 2);

function extractJson(content) {
  content = String(content).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = content.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < content.length; i++) {
    const c = content[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(content.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function runAgent(cfg, phaseName, phaseTask, target, repo, maxIters = 25, verbose = false) {
  const system =
    BASE_PROMPT +
    `\n\nPhase: ${phaseName}\nPhase instruction:\n${phaseTask}\n\nAvailable tools:\n${TOOL_LIST}`;
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: `Target URL: ${target}\nRepo path: ${repo || "(none - blackbox)"}\nBegin phase ${phaseName} now.`,
    },
  ];
  for (let i = 0; i < maxIters; i++) {
    if (verbose) console.log(`[agent] iteration ${i + 1}/${maxIters}`);
    const content = await chat(cfg, messages, { jsonMode: true });
    const obj = extractJson(content);
    if (!obj) {
      messages.push({
        role: "user",
        content: "ERROR: your response was not valid JSON. Reply with the exact JSON schema only.",
      });
      continue;
    }
    const tool = obj.tool && obj.tool !== "null" ? obj.tool : null;
    const final = obj.final && obj.final !== "null" ? obj.final : null;
    messages.push({ role: "assistant", content });
    if (tool) {
      if (verbose) console.log(`[agent] tool: ${tool} ${JSON.stringify(obj.tool_input || {}).slice(0, 200)}`);
      const result = await dispatch(tool, obj.tool_input);
      messages.push({ role: "user", content: `[tool result for ${tool}]\n${String(result).slice(0, 12000)}` });
      continue;
    }
    if (final) return final;
    messages.push({ role: "user", content: "You set neither tool nor final. Set final to your phase output." });
  }
  return "MAX ITERATIONS reached without final output";
}
