// Schedules the weekly backup (Sunday 10:00): a LaunchAgent on macOS, a crontab line on Linux.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realIo } from "./io.mjs";

const LABEL = "com.healthtracker.backup";
const EXPORT = ["run", "--directory", "py", "python", "src/health_tracker/export.py"];
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function where(io, tool) {
  const r = await io.run(["which", tool]);
  const path = r.stdout.trim();
  if (r.code !== 0 || !path) throw new Error(`Could not find ${tool}. Install it (README, prerequisites), then run npm run backup:schedule again.`);
  return path;
}

function plist({ uv, root, path, account, log }) {
  const env = { PATH: path, ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}) };
  const strings = (list) => list.map((s) => `    <string>${xml(s)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([uv, ...EXPORT])}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>10</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

export async function main(_argv, io) {
  try {
    const { root, worker } = io.paths;
    const uv = await where(io, "uv");
    const dirs = [...new Set([uv, await where(io, "node"), await where(io, "npx")].map(dirname))];
    const path = [...dirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
    const saved = JSON.parse((await io.readFile(join(worker, "setup.local.json"))) ?? "{}");
    const account = saved.accountId;
    const logDir = join(io.home, "health-tracker-backups");
    const log = join(logDir, "backup.log");
    await io.mkdir(logDir);
    if (io.platform === "darwin") {
      const file = join(io.home, "Library", "LaunchAgents", `${LABEL}.plist`);
      await io.writeFile(file, plist({ uv, root, path, account, log }));
      await io.run(["launchctl", "bootout", `gui/${io.uid}/${LABEL}`]); // fails harmlessly when not loaded yet
      const r = await io.run(["launchctl", "bootstrap", `gui/${io.uid}`, file]);
      if (r.code !== 0) throw new Error(`The schedule file was written but macOS would not load it. Run: launchctl bootstrap gui/${io.uid} ${file}`);
      io.log(`Backups will run every Sunday at 10:00. Log: ${log}`);
    } else {
      const env = [`PATH=${quote(path)}`, ...(account ? [`CLOUDFLARE_ACCOUNT_ID=${quote(account)}`] : [])].join(" ");
      const line = `0 10 * * 0 cd ${quote(root)} && env ${env} ${quote(uv)} ${EXPORT.join(" ")} >> ${quote(log)} 2>&1`;
      io.log("Add this line with `crontab -e` to back up every Sunday at 10:00:");
      io.log(line.replaceAll("%", "\\%"));
    }
    return 0;
  } catch (e) {
    io.error(e.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const io = realIo();
  process.exitCode = await main(process.argv.slice(2), io);
  io.close();
}
