// Plan mode: cron-based daily scheduler (zero dependency cron matcher)
// plans.json: { enabled: true, jobs: [{ name, cron: "分 时 日 月 周", prompt, channel?, target? }] }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLAN_PATH = path.join(os.homedir(), ".dead-sec", "plans.json");

export function loadPlans() {
  try {
    return JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
  } catch {
    return { enabled: false, jobs: [] };
  }
}

export function writePlans(p) {
  fs.mkdirSync(path.dirname(PLAN_PATH), { recursive: true });
  fs.writeFileSync(PLAN_PATH, JSON.stringify(p, null, 2));
}

function parseField(field, min, max) {
  const out = new Set();
  for (const part of String(field).trim().split(",")) {
    if (part === "*") {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    const step = part.match(/^\*\/(\d+)$/);
    if (step) {
      for (let v = min; v <= max; v += +step[1]) out.add(v);
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let v = +range[1]; v <= +range[2]; v++) out.add(v);
      continue;
    }
    if (/^\d+$/.test(part)) out.add(+part);
  }
  return out;
}

// expr: "分 时 日 月 周" (0-59 0-23 1-31 1-12 0-6, 周日=0/6 均可)
export function matches(expr, d) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return (
    parseField(min, 0, 59).has(d.getMinutes()) &&
    parseField(hour, 0, 23).has(d.getHours()) &&
    parseField(dom, 1, 31).has(d.getDate()) &&
    parseField(mon, 1, 12).has(d.getMonth() + 1) &&
    parseField(dow, 0, 6).has(d.getDay())
  );
}

export function addJob({ name, cron, prompt, channel = "", target = "" }) {
  const plans = loadPlans();
  plans.jobs = plans.jobs.filter((j) => j.name !== name);
  plans.jobs.push({ name, cron, prompt, channel, target, enabled: true });
  writePlans(plans);
  return plans;
}

export function removeJob(name) {
  const plans = loadPlans();
  plans.jobs = plans.jobs.filter((j) => j.name !== name);
  writePlans(plans);
  return plans;
}

// startPlanner(onJob) -> stop()
// onJob: (job) => void, 在 cron 命中时调用 (每秒检查, 同一分钟只触发一次)
export function startPlanner(onJob) {
  const plans = loadPlans();
  if (!plans.enabled || !Array.isArray(plans.jobs) || plans.jobs.length === 0) return () => {};
  const lastFire = new Map();
  const timer = setInterval(() => {
    const now = new Date();
    const key =
      now.getMinutes() + ":" + now.getHours() + ":" + now.getDate() + ":" + now.getMonth() + ":" + now.getDay();
    for (const job of plans.jobs) {
      if (job.enabled === false) continue;
      if (lastFire.get(job.name) === key) continue;
      if (matches(job.cron, now)) {
        lastFire.set(job.name, key);
        onJob(job);
      }
    }
  }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

export function listPlans() {
  const plans = loadPlans();
  return plans;
}
