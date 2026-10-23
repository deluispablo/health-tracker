// A fake Cloudflare, Google, file system and terminal for the setup tests.
import { readFileSync } from "node:fs";

const example = readFileSync(new URL("../../wrangler.production.example.jsonc", import.meta.url), "utf8");
export const ROOT = "/repo";
export const WORKER = `${ROOT}/worker`;
export const CONFIG = `${WORKER}/wrangler.production.jsonc`;
export const LOCAL = `${WORKER}/setup.local.json`;
export const PROPS = `${ROOT}/wear/local.properties`;
export const DOMAIN = "health.example.com";
export const CLIENT_SECRET = "client-secret-XYZ";
export const START = 1_700_000_000_000;
const SUBS = "https://health.googleapis.com/v4/projects/123456/subscribers";

export function makeWorld(opts = {}) {
  const w = {
    loggedIn: true,
    accounts: [{ id: "acc1", name: "Me" }],
    d1: [],
    kv: [],
    secrets: [],
    secretValues: {},
    token: null, // updated_at seconds of the stored Google token, or null
    migrated: false,
    deployed: false,
    attempts: 0, // attempts of the one queued sync item
    project: "my-project",
    subs: [],
    postFails: 0,
    putFails: {}, // secret name -> times its put fails
    siteFailures: 0,
    connectOnOpen: true,
    pageSize: 0,
    answers: { domain: DOMAIN, email: "me@example.com", clientId: "client-id-1", secret: CLIENT_SECRET, account: "2", project: "my-project" },
    confirms: [],
    env: { ANDROID_HOME: "/sdk" },
    ...opts,
  };
  const files = new Map([[`${WORKER}/wrangler.production.example.jsonc`, example], ...Object.entries(opts.files ?? {})]);
  const s = { w, files, calls: [], mut: [], writes: [], out: [], asked: [], fetches: [], clock: START, counter: 0 };

  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const bad = (stderr) => ({ code: 1, stdout: "", stderr });
  const json = (v) => ok(JSON.stringify(v));

  function wrangler(args, opt) {
    const [a, b, c] = args;
    const key = [a, b === "namespace" ? `${b} ${c}` : b].join(" ");
    if (a === "whoami") return w.loggedIn ? json({ loggedIn: true, accounts: w.accounts }) : ok(JSON.stringify({ loggedIn: false }));
    if (a === "login") { s.mut.push("login"); w.loggedIn = true; return ok(); }
    if (key === "d1 list") return json(w.d1);
    if (key === "d1 create") { s.mut.push("d1 create"); w.d1.push({ uuid: "d1-uuid", name: args[2] }); return ok(); }
    if (key === "kv namespace list") return json(w.kv);
    if (key === "kv namespace create") { s.mut.push("kv create"); w.kv.push({ id: "kv-id", title: args[3] }); return ok(); }
    if (key === "secret list" && w.secretListError) return bad(w.secretListError);
    if (key === "secret list" && !w.deployed) {
      return bad('\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mWorker "health-tracker" not found.\u001b[0m\n\nIf this is a new Worker, run `wrangler deploy` first to create it.');
    }
    if (key === "secret list") return json(w.secrets.map((name) => ({ name })));
    if (key === "secret put") {
      const name = args[2];
      if (w.putFails[name] > 0) { w.putFails[name] -= 1; return bad("network error"); }
      s.mut.push(`secret put ${name}`);
      w.secretValues[name] = opt.inherit ? CLIENT_SECRET : opt.input.trim(); // inherited stdio: wrangler's own prompt took the typed secret
      if (!w.secrets.includes(name)) w.secrets.push(name);
      return ok();
    }
    if (key === "d1 migrations") { s.mut.push("migrations"); w.migrated = true; return ok(); }
    if (a === "deploy") { s.mut.push("deploy"); w.deployed = true; return ok(); }
    if (key === "d1 execute") {
      const sql = args[args.indexOf("--command") + 1];
      if (w.dbError) return bad(w.dbError);
      if (!w.migrated) return bad("X [ERROR] no such table: secret_blob: SQLITE_ERROR");
      if (sql.includes("sync_pending") && "queueResult" in w) return json([{ results: w.queueResult === "none" ? [] : [{ n: w.queueResult }], success: true }]);
      if (sql.includes("google_refresh_token")) return json([{ results: w.token === null ? [] : [{ updated_at: w.token }], success: true }]);
      if (sql.includes("sync_pending") && sql.includes("attempts >= 5")) return json([{ results: [{ n: w.attempts >= 5 ? 1 : 0 }], success: true }]);
    }
    return bad(`fake: unknown wrangler command ${args.join(" ")}`);
  }

  const io = {
    async run(cmd, opt = {}) {
      s.calls.push({ cmd, env: opt.env ?? {}, input: opt.input, inherit: opt.inherit });
      if (cmd[0] === "npx") return wrangler(cmd.slice(2), opt);
      const line = cmd.join(" ");
      if (line === "gcloud auth print-access-token") return w.gcloudOut === false ? bad("not signed in") : ok("ya29.fake-token\n");
      if (line === "gcloud config get-value project") return ok(`${w.project}\n`);
      if (cmd[0] === "gcloud" && cmd[1] === "projects") return ok("123456\n");
      return bad(`fake: unknown command ${line}`);
    },
    async fetch(url, init = {}) {
      s.fetches.push({ url, method: init.method ?? "GET", body: init.body, headers: init.headers });
      if (url === `https://${DOMAIN}/`) {
        if (w.siteFailures-- > 0) throw new Error("no certificate yet");
        return new Response("ok");
      }
      if (url.startsWith(SUBS) && init.method === "POST") {
        if (w.postFails-- > 0) return new Response("{}", { status: 500 });
        s.mut.push("POST subscriber");
        const body = JSON.parse(init.body);
        w.subs.push({ name: "projects/123456/subscribers/health-tracker", endpointUri: body.endpointUri });
        w.posted = body;
        return new Response("{}");
      }
      if (url.startsWith(SUBS)) {
        const page = Number(new URL(url).searchParams.get("pageToken") ?? 0);
        const size = w.pageSize || w.subs.length || 1;
        const slice = w.subs.slice(page * size, page * size + size);
        return new Response(JSON.stringify({ subscribers: slice, ...((page + 1) * size < w.subs.length ? { nextPageToken: String(page + 1) } : {}) }));
      }
      return new Response("not found", { status: 404 });
    },
    readFile: async (path) => files.get(path) ?? null,
    writeFile: async (path, text) => { s.writes.push(path); files.set(path, text); },
    openBrowser: async (url) => {
      s.mut.push(`open ${url}`);
      if (w.connectOnOpen) w.token = Math.floor(s.clock / 1000) + 1;
    },
    ask: async (question, { hidden } = {}) => {
      s.asked.push({ question, hidden: Boolean(hidden) });
      const a = w.answers;
      if (/domain/i.test(question)) return a.domain;
      if (/email/i.test(question)) return a.email;
      if (/client id/i.test(question)) return a.clientId;
      if (/account/i.test(question)) return a.account;
      if (/project/i.test(question)) return a.project;
      throw new Error(`fake: unexpected question ${question}`);
    },
    confirm: async (question) => {
      s.asked.push({ question, confirm: true });
      return w.confirms.length ? w.confirms.shift() : true;
    },
    log: (line) => s.out.push(line),
    error: (line) => s.out.push(line),
    sleep: async (ms) => { s.clock += ms; },
    now: () => s.clock,
    random: (n) => Buffer.alloc(n, ++s.counter),
    env: w.env,
    platform: "darwin",
    home: "/home/me",
    nodeVersion: "22.1.0",
    paths: { root: ROOT, worker: WORKER, wear: `${ROOT}/wear` },
  };
  s.io = io;
  return s;
}

// Commands that cannot change anything.
export function readOnly({ cmd }) {
  const line = cmd.join(" ");
  if (cmd[0] !== "npx") return /^gcloud (auth print-access-token|config get-value project|projects describe)/.test(line);
  const args = cmd.slice(2);
  if (args[0] === "whoami" || line.includes("secret list") || line.includes("d1 list") || line.includes("namespace list")) return true;
  return args[0] === "d1" && args[1] === "execute" && /^select /i.test(args[args.indexOf("--command") + 1] ?? "");
}

export const mutating = (s) => s.mut.filter((m) => !m.startsWith("open "));

// Every secret value the run could have produced, for leak scans.
export function leaks(s, { except = [] } = {}) {
  const secret = ["TOKEN_ENC_KEY", "WEBHOOK_SECRET", "GOOGLE_CLIENT_SECRET", "WATCH_TOKEN"];
  const values = Object.entries(s.w.secretValues).filter(([name]) => secret.includes(name) && !except.includes(name)).map(([, v]) => v);
  values.push(CLIENT_SECRET);
  const text = [...s.out, ...[...s.files].filter(([p]) => !except.includes(p)).map(([, v]) => v)].join("\n");
  return values.filter((v) => text.includes(v));
}
