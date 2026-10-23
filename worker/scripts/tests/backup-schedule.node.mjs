import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../backup-schedule.mjs";

const ROOT = "/Users/me/My Repo & Co";
const TOOLS = { uv: "/opt/my uv/bin/uv", node: "/usr/local/n 1/bin/node", npx: "/usr/local/n 1/bin/npx" };

function fake(platform, { account = "acc9" } = {}) {
  const s = { calls: [], files: new Map(), dirs: [], out: [] };
  s.files.set(`${ROOT}/worker/setup.local.json`, JSON.stringify(account ? { accountId: account } : {}));
  s.io = {
    platform, home: "/home/me", uid: 501, env: { PATH: "/bin" },
    paths: { root: ROOT, worker: `${ROOT}/worker` },
    run: async (cmd) => {
      s.calls.push(cmd.join(" "));
      if (cmd[0] === "which") return TOOLS[cmd[1]] ? { code: 0, stdout: `${TOOLS[cmd[1]]}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: async (p) => s.files.get(p) ?? null,
    writeFile: async (p, t) => s.files.set(p, t),
    mkdir: async (p) => s.dirs.push(p),
    log: (l) => s.out.push(l),
    error: (l) => s.out.push(l),
  };
  return s;
}

test("macOS writes a LaunchAgent with an argument array, absolute uv, explicit PATH and account, and loads it", async () => {
  const s = fake("darwin");
  assert.equal(await main([], s.io), 0, s.out.join("\n"));
  const plist = s.files.get("/home/me/Library/LaunchAgents/com.healthtracker.backup.plist");
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/my uv\/bin\/uv<\/string>\s*<string>run<\/string>/);
  assert.match(plist, /<string>src\/health_tracker\/export\.py<\/string>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/me\/My Repo &amp; Co<\/string>/);
  assert.match(plist, /<key>Weekday<\/key>\s*<integer>0<\/integer>\s*<key>Hour<\/key>\s*<integer>10<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/my uv\/bin:\/usr\/local\/n 1\/bin:/);
  assert.match(plist, /<key>CLOUDFLARE_ACCOUNT_ID<\/key>\s*<string>acc9<\/string>/);
  assert.match(plist, /<string>\/home\/me\/health-tracker-backups\/backup\.log<\/string>/);
  assert.deepEqual(s.dirs, ["/home/me/health-tracker-backups"]);
  assert.ok(s.calls.some((c) => c.startsWith("launchctl bootstrap gui/501 /home/me/Library/LaunchAgents/")));
});

test("Linux prints a crontab line with quoted paths, escaped percent signs, PATH and account", async () => {
  const s = fake("linux");
  s.io.home = "/home/me 100%";
  assert.equal(await main([], s.io), 0);
  const line = s.out.find((l) => l.startsWith("0 10 * * 0 "));
  assert.ok(line, s.out.join("\n"));
  assert.ok(line.includes(`cd '/Users/me/My Repo & Co' && env PATH='/opt/my uv/bin:/usr/local/n 1/bin:`));
  assert.ok(line.includes("CLOUDFLARE_ACCOUNT_ID='acc9' '/opt/my uv/bin/uv' run --directory py python src/health_tracker/export.py"));
  assert.ok(line.includes(">> '/home/me 100\\%/health-tracker-backups/backup.log' 2>&1"));
  assert.equal(/[^\\]%/.test(line), false);
  assert.equal(s.calls.some((c) => c.startsWith("launchctl")), false);
});

test("the crontab line runs the exact paths after cron's % handling and the shell's quoting", async () => {
  const base = mkdtempSync(join(tmpdir(), "cron-"));
  const root = join(base, "it's 50% a repo & more");
  const bin = join(base, "bin's 100%");
  const home = join(base, "home's 5%");
  for (const d of [root, bin, home]) mkdirSync(d, { recursive: true });
  const uv = join(bin, "uv");
  writeFileSync(uv, '#!/bin/sh\nprintf "%s\\n" "$(pwd)" "$PATH" "$CLOUDFLARE_ACCOUNT_ID" "$@"\n', { mode: 0o755 });
  const s = fake("linux");
  s.io.home = home;
  s.io.paths = { root, worker: join(root, "worker") };
  s.io.readFile = async () => JSON.stringify({ accountId: "acc9" });
  s.io.mkdir = async (p) => mkdirSync(p, { recursive: true });
  s.io.run = async (cmd) => ({ code: 0, stdout: `${cmd[1] === "uv" ? uv : join(bin, cmd[1])}\n`, stderr: "" });
  assert.equal(await main([], s.io), 0);
  const line = s.out.find((l) => l.startsWith("0 10 * * 0 "));
  const command = line.slice("0 10 * * 0 ".length).replaceAll("\\%", "%"); // cron turns \% into %
  assert.equal(/(^|[^\\])%/.test(line.replaceAll("\\%", "")), false);
  const r = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [pwd, path, account, ...args] = readFileSync(join(home, "health-tracker-backups", "backup.log"), "utf8").split("\n");
  assert.equal(realpathSync(pwd), realpathSync(root));
  assert.ok(path.startsWith(`${bin}:`));
  assert.equal(account, "acc9");
  assert.deepEqual(args.slice(0, 5), ["run", "--directory", "py", "python", "src/health_tracker/export.py"]);
});

test("a missing uv stops with a plain next action", async () => {
  const s = fake("darwin");
  delete TOOLS.uv;
  try {
    assert.equal(await main([], s.io), 1);
    assert.match(s.out.join("\n"), /uv/);
    assert.equal(s.files.size, 1);
  } finally {
    TOOLS.uv = "/opt/my uv/bin/uv";
  }
});
