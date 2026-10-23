// Runs the node tests by explicit file list and fails when none ran (a bad glob would otherwise pass silently).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] ?? dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".node.mjs")).map((f) => join(dir, f));
const r = files.length ? spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { encoding: "utf8" }) : null;
process.stdout.write(r?.stdout ?? "");
const ran = Number(/^# tests (\d+)/m.exec(r?.stdout ?? "")?.[1] ?? 0);
if (ran === 0) console.error(`No node tests ran in ${dir}.`);
process.exitCode = ran > 0 && r.status === 0 ? 0 : 1;
