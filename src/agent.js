import { chat } from "./llm.js";
import { TOOLS, dispatch } from "./tools.js";
import { catalogText, matchSkills } from "./skills.js";
import { findTool, callTool as mcpCall, qualifiedToolName } from "./mcp.js";

const SKILLS_MARKER = "\n\n[ACTIVE_SKILLS]";
const ACTIVE_LIMIT = 3;

const BASE_PROMPT = `You are Dead Sec, an AI security assistant in a chat interface (like Claude Code).

Identity and mission:
- You help with authorized security testing: web/API pentesting, vulnerability analysis, exploit PoC development, and code review. You may also answer general security questions conversationally.
- Users bring their own model API key and run you on machines they own or are authorized to test. Still, never attack or scan a target unless it is the one the session is scoped to (or one the user explicitly authorizes).

Operating principles:
- When the user asks a conversational question, just answer it directly with text.
- When a task needs action or data, reason step by step and call tools (run_command, fetch_url, read_file, search_files, save_deliverable, save_poc, use_skill).
- No Exploit, No Report: never claim a vulnerability is confirmed without practical evidence against the live target.
- Keep answers concise and technical. Use markdown for structure.

${catalogText()}

Response protocol — output a single JSON object:
{"thought": "your reasoning", "tool": "tool_name or null", "tool_input": {"arg": "value"} or null, "final": "your reply text or null"}
Rules:
- To call a tool: set tool and tool_input, leave final null.
- To answer the user: set final to your reply, set tool null.
- If you call a tool, you will receive the result and must continue until you can answer.
- It is also acceptable to reply with plain text (no JSON) for simple conversational answers.`;

const TOOL_LIST = JSON.stringify(TOOLS, null, 2);

export function extractJson(content) {
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

function looksLikeProtocol(content) {
  const c = String(content).trim();
  return (
    c.startsWith("{") ||
    c.startsWith("```json") ||
    /^\s*\{?\s*"(thought|tool|tool_input|final)"\s*:/.test(c)
  );
}

/**
 * Auto-activate skills: given the latest user message, match the most relevant
 * custom skills and append their full bodies to the system prompt.
 * Returns the (possibly updated) system string with a stable marker so it is
 * only injected once per turn.
 */
function injectRelevantSkills(system, query) {
  const stripped = system.split(SKILLS_MARKER)[0];
  const matched = matchSkills(query, ACTIVE_LIMIT);
  if (!matched.length) return stripped;
  const block =
    stripped +
    SKILLS_MARKER +
    "\nAuto-activated skills (follow these workflows for the current request):\n" +
    matched
      .map(
        (s, i) =>
          `\n--- skill ${i + 1}/${matched.length}: ${s.name} ---\n${s.body.slice(0, 12000)}`,
      );
  return block;
}

/**
 * Conversational turn: user message -> tool loop -> assistant reply.
 * `messages` is a shared array (system + history + new user message). Mutated in place.
 * `onTool(name, input, result)` optional callback for UI logging.
 * `mcpServers` optional list of connected MCP servers; their tools are exposed as mcp_<server>_<tool>.
 * `onPermission(toolName, input)` optional async hook: return true to allow a sensitive tool call
 *   (run_command or any mcp_* tool), false to deny.
 * Returns the assistant reply text.
 */
export async function chatTurn(cfg, messages, { maxIters = 15, onTool, onUsage, mcpServers = [], onPermission } = {}) {
  const sensitive = (name) => name === "run_command" || name.startsWith("mcp_");
  const lastUser = [...messages].reverse().find(
    (m) =>
      m.role === "user" &&
      !/^\[(tool result|permission denied|user manually activates skill|skill activate)/.test(m.content),
  );
  if (messages[0] && messages[0].role === "system") {
    messages[0].content = injectRelevantSkills(messages[0].content, lastUser?.content || "");
  }
  if (mcpServers.length && messages[0] && messages[0].role === "system" && !messages[0].content.includes("MCP_TOOLS_MARKER")) {
    const lines = mcpServers.flatMap((s) =>
      s.error
        ? [`- ${s.name}: unavailable (${s.error})`]
        : s.tools.map((t) => `- ${qualifiedToolName(t.server, t.name)}: ${t.description}`)
    );
    messages[0].content +=
      `\n\nMCP tools (external tools via Model Context Protocol; the user confirms each call):\n${lines.join("\n")}\nMCP_TOOLS_MARKER`;
  }
  for (let i = 0; i < maxIters; i++) {
    const { content, usage } = await chat(cfg, messages, { jsonMode: false, temperature: 0.3 });
    if (usage && onUsage) onUsage(usage);
    const isProtocol = looksLikeProtocol(content);
    const obj = isProtocol ? extractJson(content) : null;
    if (!obj) {
      messages.push({ role: "assistant", content });
      return content;
    }
    const tool = obj.tool && obj.tool !== "null" ? obj.tool : null;
    const final = obj.final && obj.final !== "null" ? obj.final : null;
    messages.push({ role: "assistant", content });
    if (tool) {
      const input = obj.tool_input || {};
      if (sensitive(tool) && onPermission) {
        const allowed = await onPermission(tool, input);
        if (!allowed) {
          const denial = `[permission denied for ${tool}]`;
          if (onTool) onTool(tool, input, denial);
          messages.push({ role: "user", content: denial });
          continue;
        }
      }
      let result;
      if (tool.startsWith("mcp_")) {
        const found = findTool(mcpServers, tool);
        if (!found) result = `UNKNOWN MCP TOOL: ${tool}`;
        else {
          try {
            result = await mcpCall(found, input);
          } catch (e) {
            result = "ERROR: " + (e.message || e);
          }
        }
      } else {
        result = await dispatch(tool, input);
      }
      if (onTool) onTool(tool, input, result);
      messages.push({
        role: "user",
        content: `[tool result for ${tool}]\n${String(result).slice(0, 12000)}`,
      });
      continue;
    }
    if (final) return final;
    messages.push({
      role: "user",
      content: "You set neither tool nor final. Set final to your reply, or call a tool.",
    });
  }
  return "MAX ITERATIONS reached without a reply";
}

/**
 * Legacy single-phase runner, kept for `dead-sec scan` (automatic pipeline).
 */
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
    const { content } = await chat(cfg, messages, { jsonMode: true });
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
