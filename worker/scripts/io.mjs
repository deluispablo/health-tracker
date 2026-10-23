// Real side effects for the setup scripts. Tests replace this whole object with fakes.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// wrangler must not write disk logs, and must keep redacting what it logs.
export const childEnv = (extra) => ({ ...process.env, ...extra, WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_SANITIZE: "true" });

export function run(cmd, { cwd, env, input, inherit } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env: childEnv(env),
      stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => done({ code: 127, stdout, stderr: e.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

// One readline for the questions; piped answers arrive together, so a line iterator keeps them all.
// It is closed while a child owns the terminal (handoff) and reopened by the next question.
export function createPrompter(input, output) {
  let rl;
  let lines;
  const close = () => {
    rl?.close();
    rl = lines = undefined;
  };
  const ask = async (question) => {
    rl ??= createInterface({ input, output, terminal: Boolean(input.isTTY) });
    lines ??= rl[Symbol.asyncIterator]();
    output.write(`${question} `);
    const { value } = await lines.next();
    if (!input.isTTY) output.write("\n");
    return (value ?? "").trim();
  };
  const handoff = (fn) => {
    close();
    return fn();
  };
  return { ask, close, handoff };
}

export function realIo() {
  const prompter = createPrompter(process.stdin, process.stdout);
  const { ask } = prompter;
  return {
    close: prompter.close,
    // A child with inherited stdio (wrangler asking for a secret) reads the terminal itself.
    run: (cmd, opts) => (opts?.inherit ? prompter.handoff(() => run(cmd, opts)) : run(cmd, opts)),
    fetch: (url, init) => fetch(url, init),
    readFile: (path) => readFile(path, "utf8").catch(() => null),
    writeFile: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    },
    openBrowser: (url) => run([process.platform === "darwin" ? "open" : "xdg-open", url]),
    ask,
    confirm: async (question) => /^(y|yes|s|si)$/i.test(await ask(`${question} [y/N]`)),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    mkdir: (path) => mkdir(path, { recursive: true }),
    uid: process.getuid?.(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    random: (n) => randomBytes(n),
    env: process.env,
    platform: process.platform,
    home: homedir(),
    nodeVersion: process.versions.node,
    paths: { root, worker: resolve(root, "worker"), wear: resolve(root, "wear") },
  };
}
