import { setup } from "./config.js";
import { run } from "./pipeline.js";
import { chat } from "./chat.js";
import { displaySkills, scaffoldSkill } from "./skills.js";
import { initConnectorsConfig, loadConnectorsConfig } from "./connectors/index.js";
import { listPlans, addJob, removeJob, writePlans } from "./plan.js";

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "setup") {
    await setup();
    return;
  }
  if (cmd === "scan") {
    let url = "";
    let repo = "";
    let verbose = true;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "-u" || a === "--url") url = rest[++i] || "";
      else if (a === "-r" || a === "--repo") repo = rest[++i] || "";
      else if (a === "--quiet") verbose = false;
    }
    if (!url) {
      console.error("ERROR: --url is required");
      console.error("Usage: dead-sec scan -u <url> [-r <repo>]");
      process.exit(1);
    }
    await run(url, repo, verbose);
    return;
  }
  if (cmd === "skills") {
    console.log(displaySkills());
    return;
  }
  if (cmd === "skill") {
    const sub = rest[0];
    if (sub === "new") {
      const name = rest[1];
      if (!name) {
        console.error("Usage: dead-sec skill new <name>");
        process.exit(1);
      }
      const r = scaffoldSkill(name);
      if (!r.ok) {
        console.error("ERROR: " + r.error);
        process.exit(1);
      }
      console.log(`Created ${r.file}\n编辑后运行 dead-sec，输入 /skills 查看`);
      return;
    }
    console.error("Usage: dead-sec skill new <name> | dead-sec skills");
    process.exit(1);
  }
  if (cmd === "-u" || cmd === "--url" || cmd === "-r" || cmd === "--repo" || cmd === "-p" || cmd === "--prompt") {
    // shorthand: dead-sec -u <url> [-p "<initial prompt>"] enters chat with target
    let url = "";
    let prompt = "";
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-u" || a === "--url") url = argv[++i] || "";
      else if (a === "-p" || a === "--prompt") prompt = argv[++i] || "";
    }
    await chat({ target: url, startPrompt: prompt, quiet: false });
    return;
  }
  if (cmd === "connectors") {
    const sub = rest[0];
    if (sub === "init") {
      initConnectorsConfig();
      console.log("编辑 ~/.dead-sec/connectors.json 填入 token / webhook 后重启 dead-sec 生效");
      console.log("  - telegram: 创建 @BotFather 机器人, 填入 token");
      console.log("  - feishu: 群机器人 webhook (发送) + 事件订阅回调地址 http://<公网>:8787/feishu (接收)");
      console.log("  - webhook: 供微信/QQ 桥接器 POST {chat_id, text} 到 http://<公网>:8788/in");
      return;
    }
    console.log(JSON.stringify(loadConnectorsConfig(), null, 2));
    console.log("用法: dead-sec connectors init 生成模板配置");
    return;
  }
  if (cmd === "plan") {
    const sub = rest[0];
    if (sub === "add") {
      const cron = rest[1];
      const name = rest[2];
      const prompt = rest.slice(3).filter((x) => !x.startsWith("-")).join(" ") || "执行默认任务";
      const channelIdx = rest.findIndex((x) => x === "-c" || x === "--channel");
      const channel = channelIdx >= 0 ? rest[channelIdx + 1] || "" : "";
      if (!cron || !name) {
        console.error('用法: dead-sec plan add "<cron>" "<名称>" "<prompt>" [-c telegram:123456]');
        console.error('cron 格式: 分 时 日 月 周 (如 "30 9 * * *" 每天 9:30, "*/5 * * * *" 每 5 分钟)');
        process.exit(1);
      }
      addJob({ name, cron, prompt, channel });
      console.log(`已添加计划任务: ${name}  cron="${cron}"  channel=${channel || "cli"}`);
      console.log("提示: plans.json 中 enabled 需为 true (默认 true)");
      return;
    }
    if (sub === "remove" || sub === "rm") {
      const name = rest[1];
      if (!name) {
        console.error("用法: dead-sec plan remove <名称>");
        process.exit(1);
      }
      removeJob(name);
      console.log(`已移除计划任务: ${name}`);
      return;
    }
    if (sub === "on" || sub === "off") {
      const plans = listPlans();
      plans.enabled = sub === "on";
      writePlans(plans);
      console.log(`计划模式: ${sub === "on" ? "开启" : "关闭"}`);
      return;
    }
    if (sub === "list") {
      const plans = listPlans();
      if (!plans.jobs.length) {
        console.log("暂无计划任务。用 dead-sec plan add 添加");
        return;
      }
      console.log(`计划模式: ${plans.enabled ? "开启" : "关闭"}`);
      for (const j of plans.jobs) {
        console.log(`  ${j.enabled === false ? "[off] " : ""}${j.name}  cron="${j.cron}"  channel=${j.channel || "cli"}  ${j.prompt}`);
      }
      return;
    }
    console.log("用法:");
    console.log("  dead-sec plan add <cron> <名称> <prompt> [-c <channel>]  添加计划任务");
    console.log("  dead-sec plan remove <名称>                             移除计划任务");
    console.log("  dead-sec plan on / off                                 开启/关闭计划模式");
    console.log("  dead-sec plan list                                     列出计划任务");
    return;
  }
  if (cmd && cmd !== "help" && cmd !== "-h" && cmd !== "--help") {
    console.error(`unknown command: ${cmd}`);
  }
  await chat({ quiet: false });
}
