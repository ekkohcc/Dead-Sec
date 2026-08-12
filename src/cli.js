import { setup } from "./config.js";
import { run } from "./pipeline.js";

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "setup") {
    await setup();
    return;
  }
  if (cmd === "start") {
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
      console.error("Usage: dead-sec start -u <url> [-r <repo>]");
      process.exit(1);
    }
    await run(url, repo, verbose);
    return;
  }
  console.log("Dead Sec - AI pentester agent (Shannon-style). No Exploit, No Report.");
  console.log("");
  console.log("Usage:");
  console.log("  dead-sec setup                          configure your own model API key / base URL / model");
  console.log("  dead-sec start -u <url> [-r <repo>]     run the pentest pipeline against a target");
}
