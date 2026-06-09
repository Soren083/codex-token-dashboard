#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const label = process.env.CODEX_TOKEN_DASHBOARD_LAUNCHD_LABEL || "io.github.soren083.codex-token-dashboard";
const labels = [label, "com.wepie.codex-token-dashboard"].filter((item, index, all) => all.indexOf(item) === index);

for (const item of labels) {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${item}.plist`);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" });
  } catch {
    // Already stopped.
  }
  await rm(plistPath, { force: true });
}
console.log(`Uninstalled ${label}`);
