#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectDir = path.dirname(path.dirname(__filename));
const nodePath = process.execPath;
const home = os.homedir();
const label = process.env.CODEX_TOKEN_DASHBOARD_LAUNCHD_LABEL || "io.github.soren083.codex-token-dashboard";
const legacyLabels = ["com.wepie.codex-token-dashboard"].filter((item) => item !== label);
const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
const logDir = path.join(home, "Library", "Logs", "codex-token-dashboard");

const host = process.env.CODEX_TOKEN_DASHBOARD_HOST || "127.0.0.1";
const port = process.env.CODEX_TOKEN_DASHBOARD_PORT || "8766";
const sessionsRoot =
  process.env.CODEX_TOKEN_DASHBOARD_SESSIONS_ROOT || path.join(home, ".codex", "sessions");

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(path.join(projectDir, "server.mjs"))}</string>
    <string>--host</string>
    <string>${xmlEscape(host)}</string>
    <string>--port</string>
    <string>${xmlEscape(port)}</string>
    <string>--sessions-root</string>
    <string>${xmlEscape(sessionsRoot)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, "stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, "stderr.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_TOKEN_DASHBOARD_HOST</key>
    <string>${xmlEscape(host)}</string>
    <key>CODEX_TOKEN_DASHBOARD_PORT</key>
    <string>${xmlEscape(port)}</string>
    <key>CODEX_TOKEN_DASHBOARD_SESSIONS_ROOT</key>
    <string>${xmlEscape(sessionsRoot)}</string>
  </dict>
</dict>
</plist>
`;

await mkdir(path.dirname(plistPath), { recursive: true });
await mkdir(logDir, { recursive: true });
await writeFile(plistPath, plist, "utf8");

const guiTarget = `gui/${process.getuid()}/${label}`;
for (const legacyLabel of legacyLabels) {
  const legacyPath = path.join(home, "Library", "LaunchAgents", `${legacyLabel}.plist`);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, legacyPath], { stdio: "ignore" });
  } catch {
    // Not loaded.
  }
  await rm(legacyPath, { force: true });
}
try {
  execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore" });
} catch {
  // Not loaded yet.
}
execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" });
execFileSync("launchctl", ["kickstart", "-k", guiTarget], { stdio: "inherit" });

console.log(`Installed ${label}`);
console.log(`Dashboard: http://${host}:${port}/`);
console.log(`Plist: ${plistPath}`);
console.log(`Logs: ${logDir}`);
