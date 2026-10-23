// One-command install: npm run setup [-- --watch] [-- --dry-run]. Safe to re-run: every step skips what is done.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { realIo } from "./io.mjs";

const D1_NAME = "health-tracker";
const KV_TITLE = "OAUTH_KV";
const CONFIG = "wrangler.production.jsonc";
const TIMEZONE = "Europe/Madrid";
const CREDENTIALS = ["ALLOWED_EMAIL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const HOSTNAME = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const TOKEN_SQL = "select updated_at from secret_blob where name='google_refresh_token'";
const API ="https://health.googleapis.com/v4/projects";
const AGAIN = "Fix that, then run npm run setup again; it continues where it stopped.";

class SetupError extends Error {}
const fail = (message) => { throw new SetupError(message); };
const tail = (text) => (text.trim().split("\n").at(-1) ?? "").slice(0, 200);
const hex = (c, n) => c.io.random(n).toString("hex");
const hashOf = (a) => createHash("sha256").update(`${a.email}\n${a.clientId}`).digest("hex");
const parse = (text, what) => {
  try { return JSON.parse(text.slice(Math.max(0, text.search(/[[{]/)))); } catch { return fail(`Could not understand the answer to ${what}. ${AGAIN}`); }
};

// Anything that changes something goes through act(), so --dry-run can skip it in one place.
async function act(c, description, fn) {
  if (c.flags.dryRun) { c.io.log(`Would ${description}.`); return undefined; }
  c.io.log(`${description[0].toUpperCase()}${description.slice(1)}...`);
  return fn();
}

function wrangler(c, args, { prod, input, inherit } = {}) {
  const env = c.accountId ? { CLOUDFLARE_ACCOUNT_ID: c.accountId } : {};
  return c.io.run(["npx", "wrangler", ...args, ...(prod ? ["--config", CONFIG] : [])], { cwd: c.io.paths.worker, env, input, inherit });
}

async function wr(c, args, what, opts) {
  const r = await wrangler(c, args, opts);
  const detail = opts?.input === undefined && !opts?.inherit ? tail(r.stderr) : ""; // never echo output of a secret upload
  if (r.code !== 0) fail(`${what} failed${detail ? `: ${detail}` : ""}. ${AGAIN}`);
  return r.stdout;
}

// Comments and trailing commas are valid in wrangler configs; strings are kept untouched.
const jsonc = (text) => JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(?=\s*[}\]])/g, (_, string) => string ?? ""));

const configPath = (c) => join(c.io.paths.worker, CONFIG);
const localPath = (c) => join(c.io.paths.worker, "setup.local.json");

// Read-only D1 query. No config yet or no table yet (before the migrations) means no rows; any other error stops.
async function query(c, sql) {
  if ((await c.io.readFile(configPath(c))) === null) return [];
  const r = await wrangler(c, ["d1", "execute", "DB", "--remote", "--json", "--command", sql], { prod: true });
  if (r.code === 0) return parse(r.stdout, "a database check")[0]?.results ?? [];
  if (/no such table/i.test(r.stderr + r.stdout)) return [];
  return fail(`Could not read your database: ${tail(r.stderr || r.stdout)}. ${AGAIN}`);
}

async function secretNames(c) {
  if ((await c.io.readFile(configPath(c))) === null) return [];
  const r = await wrangler(c, ["secret", "list", "--format", "json"], { prod: true });
  // Before the first deploy the Worker does not exist yet, so it has no secrets.
  const plain = (r.stderr + r.stdout).replace(/\u001b\[[0-9;]*m/g, "");
  if (r.code !== 0 && plain.includes('Worker "health-tracker" not found.')) return [];
  if (r.code !== 0) fail(`Could not list the Worker secrets: ${tail(r.stderr)}. ${AGAIN}`);
  return parse(r.stdout, "the secret list").map((s) => s.name);
}

// value undefined: wrangler asks for it itself in the terminal, so this script never sees it.
const putSecret = (c, name, value) =>
  act(c, `store the secret ${name}`, () => wr(c, ["secret", "put", name], `Storing ${name}`,
    value === undefined ? { prod: true, inherit: true } : { prod: true, input: `${value}\n` }));

async function saveLocal(c) {
  const text = `${JSON.stringify(c.file, null, 2)}\n`;
  if (c.flags.dryRun || text === c.savedText) return;
  await c.io.writeFile(localPath(c), text);
  c.savedText = text;
}

async function loadSaved(c) {
  const text = await c.io.readFile(localPath(c));
  if (text === null) return;
  let file;
  try { file = JSON.parse(text); } catch { file = null; }
  if (!file || !["domain", "email", "clientId"].every((k) => typeof file[k] === "string" && file[k])) {
    fail(`worker/setup.local.json is damaged or incomplete. Delete it and run npm run setup again to enter your answers once more.`);
  }
  c.file = file;
  c.savedText = text;
}

async function googleHeaders(c) {
  const r = await c.io.run(["gcloud", "auth", "print-access-token"]);
  if (r.code !== 0 || !r.stdout.trim()) fail("gcloud is not signed in. Run: gcloud auth login, then npm run setup again.");
  return { authorization: `Bearer ${r.stdout.trim()}`, "x-goog-user-project": c.file.projectId, "content-type": "application/json" };
}

// --- steps ---

const propsPath = (c) => join(c.io.paths.wear, "local.properties");

// ANDROID_HOME wins; otherwise the folder already written in local.properties.
async function androidSdk(c) {
  const saved = /^sdk\.dir=(.+)$/m.exec((await c.io.readFile(propsPath(c))) ?? "")?.[1];
  return c.io.env.ANDROID_HOME || c.io.env.ANDROID_SDK_ROOT || saved || fail("Set ANDROID_HOME to your Android SDK folder (see the watch guide), then run npm run setup -- --watch again.");
}

async function tools(c) {
  if (c.flags.watch) await androidSdk(c); // fail before anything is changed
  if (Number(c.io.nodeVersion.split(".")[0]) < 22) fail("Node.js 22 or newer is needed. Install the current LTS from nodejs.org, then run npm run setup again.");
  const whoami = async () => {
    const r = await wrangler(c, ["whoami", "--json"]);
    const who = r.code === 0 ? parse(r.stdout, "wrangler whoami") : null;
    return who && who.loggedIn !== false ? who : null;
  };
  let who = await whoami();
  if (!who) {
    if (c.flags.dryRun) c.io.log("Would log in to Cloudflare (wrangler login).");
    else {
      await wrangler(c, ["login"], { inherit: true });
      who = await whoami();
      if (!who) fail("Cloudflare login did not finish. Run: npx wrangler login (inside worker/), then npm run setup again.");
    }
  }
  c.accounts = who?.accounts ?? [];
  await googleHeaders({ ...c, file: {} });
  c.io.log("Tools are ready: Node, Cloudflare login and gcloud.");
}

async function promptValues(c) {
  const domain = (await c.io.ask("Your domain (for example health.example.com, no https://):")).toLowerCase();
  if (!HOSTNAME.test(domain)) fail(`"${domain}" is not a plain domain name like health.example.com (no https:// and no path). ${AGAIN}`);
  const email = await c.io.ask("Your Google email:");
  if (email.split("@").length !== 2 || email.startsWith("@") || email.endsWith("@")) fail(`"${email}" is not an email address. ${AGAIN}`);
  const clientId = await c.io.ask("Google OAuth client ID:");
  if (!clientId) fail(`The client ID is empty. ${AGAIN}`);
  return { domain, email, clientId };
}

async function pickAccount(c) {
  const known = c.file.accountId;
  if (known) return c.accounts.length && !c.accounts.some((a) => a.id === known) ? fail(`The saved Cloudflare account is not available to this login. Delete accountId in worker/setup.local.json. ${AGAIN}`) : known;
  if (c.accounts.length < 2) return c.accounts[0]?.id;
  const list = c.accounts.map((a, i) => `  ${i + 1}. ${a.name}`).join("\n");
  const pick = c.accounts[Number(await c.io.ask(`Which Cloudflare account?\n${list}\nNumber:`)) - 1];
  return pick?.id ?? fail(`That is not one of the listed Cloudflare accounts. ${AGAIN}`);
}

async function pickProject(c) {
  if (c.file.projectId) return c.file.projectId;
  const r = await c.io.run(["gcloud", "config", "get-value", "project"]);
  const current = r.stdout.trim();
  if (current && (await c.io.confirm(`Use Google Cloud project ${current}?`))) return current;
  return (await c.io.ask("Google Cloud project ID:")) || fail(`No Google Cloud project was given. ${AGAIN}`);
}

async function ask(c) {
  const show = (a) => c.io.log(`Domain: ${a.domain}\nGoogle email: ${a.email}\nClient ID: ${a.clientId}`);
  const plan = "This will create a database and storage in your Cloudflare account, store secrets, deploy the Worker and register a Google subscriber.";
  let answers = c.file;
  if (answers) {
    show(answers);
    if (!(await c.io.confirm("Use these saved values and continue?"))) { answers = undefined; c.reentered = true; }
  }
  if (!answers) {
    answers = await promptValues(c);
    show(answers);
    c.io.log(plan);
    if (!(await c.io.confirm("Continue with these values?"))) fail("Stopped. Nothing was changed.");
  }
  c.file = { ...c.file, ...answers };
  c.accountId = await pickAccount(c);
  c.file.accountId = c.accountId;
  c.file.projectId = await pickProject(c);
  await saveLocal(c);
  await discoverSubscriber(c);
}

// Read-only look at Google before any change, so a half-installed state is refused early.
async function discoverSubscriber(c) {
  const project = await c.io.run(["gcloud", "projects", "describe", c.file.projectId, "--format=value(projectNumber)"]);
  const number = project.stdout.trim();
  if (project.code !== 0 || !number) fail(`Could not read Google Cloud project ${c.file.projectId}. Check the project ID and that your gcloud account can see it. ${AGAIN}`);
  c.sub = { url: `${API}/${number}/subscribers`, found: false };
  const wanted = `https://${c.file.domain}/webhooks/google`;
  const headers = await googleHeaders(c);
  for (let page = ""; page !== undefined;) {
    const res = await c.io.fetch(`${c.sub.url}${page ? `?pageToken=${encodeURIComponent(page)}` : ""}`, { headers });
    if (!res.ok) fail(`Google would not list the subscribers (HTTP ${res.status}). Check that the Google Health API is enabled in project ${c.file.projectId}. ${AGAIN}`);
    const body = await res.json();
    for (const sub of body.subscribers ?? []) {
      if (sub.endpointUri === wanted) c.sub.found = true;
      else if (sub.name?.endsWith("/subscribers/health-tracker")) {
        fail(`A Google subscriber named health-tracker already points to ${sub.endpointUri}, not ${wanted}. Setup never changes it. Remove it yourself in Google Cloud or use that domain.`);
      }
    }
    page = body.nextPageToken || undefined;
  }
  if (c.sub.found && !(await secretNames(c)).includes("WEBHOOK_SECRET")) {
    fail("Google already has your subscriber but the Worker has no WEBHOOK_SECRET. Follow the webhook secret rotation in docs/operations.md, then run npm run setup again.");
  }
}

async function resources(c) {
  const path = configPath(c);
  const existing = await c.io.readFile(path);
  const { domain } = c.file;
  let text = existing ?? (await c.io.readFile(join(c.io.paths.worker, "wrangler.production.example.jsonc")))
    .replaceAll("<your-domain>", domain).replaceAll("<your IANA time zone>", TIMEZONE);
  let config;
  try { config = jsonc(text); } catch { fail(`worker/wrangler.production.jsonc is not valid JSON (comments are fine). Fix it or delete it, then run npm run setup again.`); }
  const route = config.routes?.[0]?.pattern;
  if (existing !== null && route !== domain) fail(`wrangler.production.jsonc is set up for ${route}, but you entered ${domain}. Setup will not rewrite a working config; use ${route} or delete the file yourself.`);
  const lookup = async (args, match, key) => (parse(await wr(c, args, "Listing your Cloudflare resources"), "the resource list").find(match) ?? {})[key];
  const lookups = [
    ["database", "database_id", config.d1_databases?.[0]?.database_id, ["d1", "list", "--json"], (d) => d.name === D1_NAME, "uuid", ["d1", "create", D1_NAME]],
    ["storage namespace", "id", config.kv_namespaces?.[0]?.id, ["kv", "namespace", "list"], (k) => k.title === KV_TITLE, "id", ["kv", "namespace", "create", KV_TITLE]],
  ];
  for (const [label, field, current, list, match, key, create] of lookups) {
    if (current && !current.includes("<")) continue;
    let id = await lookup(list, match, key);
    if (id) c.io.log(`Found your existing ${label}; reusing it.`);
    else {
      await act(c, `create the ${label}`, () => wr(c, create, `Creating the ${label}`));
      id = c.flags.dryRun ? "dry-run-id" : await lookup(list, match, key);
      if (!id) fail(`The ${label} was created but could not be found afterwards. ${AGAIN}`);
    }
    text = text.replace(new RegExp(`("${field}"\\s*:\\s*)"[^"]*"`), (_, head) => `${head}"${id}"`);
  }
  if (text !== existing) await act(c, "write worker/wrangler.production.jsonc", () => c.io.writeFile(path, text));
}

async function credentials(c, names) {
  const pending = c.reentered || c.file.pendingCredentials || c.file.credentialsHash !== hashOf(c.file) || CREDENTIALS.some((n) => !names.includes(n));
  if (!pending) return;
  c.file.pendingCredentials = true;
  await saveLocal(c);
  await putSecret(c, "ALLOWED_EMAIL", c.file.email);
  await putSecret(c, "GOOGLE_CLIENT_ID", c.file.clientId);
  if (!c.flags.dryRun) c.io.log("Wrangler will now ask for your Google client secret. Paste it there; typing is hidden.");
  await putSecret(c, "GOOGLE_CLIENT_SECRET");
  delete c.file.pendingCredentials;
  c.file.credentialsHash = hashOf(c.file);
  await saveLocal(c);
}

async function watch(c, names) {
  const current = (await c.io.readFile(propsPath(c))) ?? "";
  const exists = names.includes("WATCH_TOKEN");
  let token = /^watchToken=[ \t]*(\S+)/m.exec(current)?.[1];
  const rotate = !(exists && token);
  if (rotate) {
    token = c.io.random(32).toString("base64url");
    await putSecret(c, "WATCH_TOKEN", token);
  }
  // sdk.dir and watchBaseUrl are always brought up to date; other keys stay as they are.
  const text = setProps(current, { "sdk.dir": await androidSdk(c), watchToken: token, watchBaseUrl: `https://${c.file.domain}` });
  if (text !== current) await act(c, "write wear/local.properties", () => c.io.writeFile(propsPath(c), text));
  if (rotate && exists) c.io.log("The watch token was replaced. A watch that is already installed must be rebuilt and reinstalled with the new token.");
}

function setProps(text, set) {
  return Object.entries(set).reduce((t, [key, value]) => {
    const line = new RegExp(`^${key.replace(".", "\\.")}=.*$`, "m");
    if (line.test(t)) return t.replace(line, () => `${key}=${value}`);
    return `${t && !t.endsWith("\n") ? `${t}\n` : t}${key}=${value}\n`;
  }, text);
}

async function secrets(c) {
  const names = await secretNames(c);
  const keyMissing = !names.includes("TOKEN_ENC_KEY");
  // reconnectPending without reconnectSince means a key upload may have been cut off: upload again.
  if (keyMissing || (c.file.reconnectPending && c.file.reconnectSince === undefined)) {
    // A stored Google token cannot be decrypted with a new key, so Google must be connected again afterwards.
    if (keyMissing && (await query(c, TOKEN_SQL)).length) c.file.reconnectPending = true;
    delete c.file.reconnectSince;
    await saveLocal(c);
    await putSecret(c, "TOKEN_ENC_KEY", c.io.random(32).toString("base64"));
    if (c.file.reconnectPending) {
      c.file.reconnectSince = Math.floor(c.io.now() / 1000);
      await saveLocal(c);
    }
  }
  await credentials(c, names);
  if (c.flags.watch) await watch(c, names);
}

async function deploy(c) {
  await act(c, "update the database", () => wr(c, ["d1", "migrations", "apply", "DB", "--remote"], "Updating the database", { prod: true }));
  await act(c, "deploy the Worker", () => wr(c, ["deploy"], "Deploying the Worker", { prod: true }));
  if (c.flags.dryRun) return c.io.log(`Would wait for https://${c.file.domain}/ to answer.`);
  for (let i = 0; i < 24; i++) {
    const res = await c.io.fetch(`https://${c.file.domain}/`).catch(() => null);
    if (res?.status === 200) return c.io.log("The Worker answers.");
    if (i < 23) await c.io.sleep(5000);
  }
  fail(`https://${c.file.domain}/ is not answering yet. A new domain can take a few minutes to get its certificate. Wait a bit, then run npm run setup again.`);
}

async function connect(c) {
  const connected = async () => {
    const rows = await query(c, TOKEN_SQL);
    return rows.length > 0 && rows[0].updated_at > (c.file.reconnectSince ?? 0);
  };
  const done = async () => {
    delete c.file.reconnectPending;
    delete c.file.reconnectSince;
    await saveLocal(c);
  };
  if (await connected()) { await done(); return c.io.log("Google is already connected; skipping."); }
  const url = `https://${c.file.domain}/google/connect`;
  await act(c, `open ${url} in your browser to sign in with Google`, () => c.io.openBrowser(url));
  if (c.flags.dryRun) return;
  c.io.log(`If no browser opened, visit ${url} and allow access.`);
  for (let i = 0; i < 120; i++) {
    if (await connected()) { await done(); return c.io.log("Google is connected."); }
    await c.io.sleep(5000);
  }
  fail(`Google was not connected within 10 minutes. Run npm run setup again, then finish the sign-in at ${url}.`);
}

async function subscriber(c) {
  if (c.sub.found) return c.io.log("The Google subscriber already exists; skipping.");
  const secret = `Bearer ${hex(c, 32)}`;
  await putSecret(c, "WEBHOOK_SECRET", secret);
  await act(c, "register the Google subscriber", async () => {
    const body = {
      endpointUri: `https://${c.file.domain}/webhooks/google`,
      subscriberConfigs: [{ dataTypes: ["heart-rate", "steps", "sleep"], subscriptionCreatePolicy: "AUTOMATIC" }],
      endpointAuthorization: { secret },
    };
    const res = await c.io.fetch(`${c.sub.url}?subscriberId=${D1_NAME}`, { method: "POST", headers: await googleHeaders(c), body: JSON.stringify(body) }).catch(() => null);
    if (!res?.ok) fail(`Google would not create the subscriber (${res ? `HTTP ${res.status}` : "no answer"}). Check that the Google Health API is enabled and your gcloud account owns the project. ${AGAIN}`);
  });
}

async function verify(c) {
  if (c.flags.dryRun) return c.io.log("Would check the Google token and the sync queue.");
  if (!(await query(c, TOKEN_SQL)).length) fail(`Google is not connected yet. Run npm run setup again and finish the sign-in at https://${c.file.domain}/google/connect.`);
  const stuck = (await query(c, "select count(*) as n from sync_pending where attempts >= 5"))[0]?.n;
  if (!Number.isInteger(stuck) || stuck < 0) fail(`Could not check the sync queue. Run npm run setup again in a minute; if it keeps failing, run the health_status tool from your MCP client.`);
  if (stuck > 0) fail(`${stuck} sync items are stuck. Run the health_status tool, then health_refresh, from your MCP client, or run npm run setup again in a few minutes.`);
  c.io.log(`\nAll set. Add this MCP connector URL in your client: https://${c.file.domain}/mcp`);
  c.io.log("Optional next steps: npm run setup -- --watch (Pixel Watch), npm run backup:schedule (weekly backups), and the dashboard (see the README).");
}

const STEPS = [tools, ask, resources, secrets, deploy, connect, subscriber, verify];

export async function main(argv, io) {
  const flags = { dryRun: argv.includes("--dry-run"), watch: argv.includes("--watch") };
  const unknown = argv.find((a) => !["--dry-run", "--watch"].includes(a));
  const c = { io, flags };
  try {
    if (unknown) fail(`Unknown option ${unknown}. Use --watch or --dry-run.`);
    await loadSaved(c);
    for (const step of STEPS) {
      io.log(`\n== ${step.name}`);
      await step(c);
    }
    return 0;
  } catch (e) {
    io.error(e instanceof SetupError ? e.message : `Something unexpected went wrong: ${e.message}. ${AGAIN}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const io = realIo();
  process.exitCode = await main(process.argv.slice(2), io);
  io.close();
}
