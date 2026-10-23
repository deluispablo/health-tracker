import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../setup.mjs";
import { CLIENT_SECRET, CONFIG, DOMAIN, LOCAL, PROPS, WORKER, leaks, makeWorld, mutating, readOnly } from "./world.mjs";

const go = (s, ...flags) => main(flags, s.io);
const reset = (s) => { for (const k of ["calls", "mut", "writes", "out", "asked", "fetches"]) s[k].length = 0; };
const saved = (s) => JSON.parse(s.files.get(LOCAL));
const puts = (s) => s.mut.filter((m) => m.startsWith("secret put")).map((m) => m.slice(11));
const text = (s) => s.out.join("\n");
const hash = (email, id) => createHash("sha256").update(`${email}\n${id}`).digest("hex");
// The client secret is never read by the script: wrangler asks for it itself, with inherited stdio and no input.
function throughWrangler(s) {
  const calls = s.calls.filter((c) => c.cmd.includes("put") && c.cmd.includes("GOOGLE_CLIENT_SECRET"));
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.ok(c.inherit === true && c.input === undefined);
}
const FULL =["TOKEN_ENC_KEY", "WEBHOOK_SECRET", "ALLOWED_EMAIL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];

async function installed(opts) {
  const s = makeWorld(opts);
  assert.equal(await go(s), 0, text(s));
  reset(s);
  return s;
}

test("fresh install creates everything once and leaks no secret", async () => {
  const s = makeWorld();
  assert.equal(await go(s), 0, text(s));
  assert.deepEqual(s.mut.filter((m) => !m.startsWith("secret put")), [
    "d1 create", "kv create", "migrations", "deploy", `open https://${DOMAIN}/google/connect`, "POST subscriber",
  ]);
  assert.deepEqual(puts(s).sort(), [...FULL].sort());
  const config = s.files.get(CONFIG);
  assert.match(config, /"database_id": "d1-uuid"/);
  assert.match(config, /"id": "kv-id"/);
  assert.match(config, new RegExp(`"pattern": "${DOMAIN}"`));
  assert.match(config, /"USER_TZ": "Europe\/Madrid"/);
  assert.deepEqual(s.w.posted, {
    endpointUri: `https://${DOMAIN}/webhooks/google`,
    subscriberConfigs: [{ dataTypes: ["heart-rate", "steps", "sleep"], subscriptionCreatePolicy: "AUTOMATIC" }],
    endpointAuthorization: { secret: s.w.secretValues.WEBHOOK_SECRET },
  });
  assert.match(s.w.secretValues.WEBHOOK_SECRET, /^Bearer [0-9a-f]{64}$/);
  assert.equal(Buffer.from(s.w.secretValues.TOKEN_ENC_KEY, "base64").length, 32);
  assert.equal(saved(s).credentialsHash, hash("me@example.com", "client-id-1"));
  assert.equal(saved(s).pendingCredentials, undefined);
  assert.equal(s.files.has(PROPS), false);
  assert.deepEqual(leaks(s), []);
  assert.ok(text(s).includes(`https://${DOMAIN}/mcp`));
});

test("production wrangler calls pass the config and --remote", async () => {
  const s = makeWorld();
  await go(s);
  for (const { cmd } of s.calls.filter((c) => c.cmd[0] === "npx")) {
    const line = cmd.join(" ");
    if (/whoami|login|d1 list|d1 create|kv namespace/.test(line)) continue;
    assert.ok(cmd.includes("--config") && cmd.includes("wrangler.production.jsonc"), line);
    if (/d1 (migrations|execute)/.test(line)) assert.ok(cmd.includes("--remote"), line);
  }
});

test("re-run after a complete install only redeploys and verifies, asking one confirmation", async () => {
  const s = await installed();
  assert.equal(await go(s), 0, text(s));
  assert.deepEqual(s.mut, ["migrations", "deploy"]);
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].confirm, true);
  assert.deepEqual(s.writes, []);
});

test("multi-account install saves the account and re-runs without asking again", async () => {
  const s = makeWorld({ accounts: [{ id: "acc1", name: "A" }, { id: "acc2", name: "B" }] });
  assert.equal(await go(s), 0, text(s));
  assert.equal(saved(s).accountId, "acc2");
  for (const c of s.calls.filter((c) => c.cmd[0] === "npx" && !/whoami|login/.test(c.cmd.join(" ")))) assert.equal(c.env.CLOUDFLARE_ACCOUNT_ID, "acc2");
  reset(s);
  assert.equal(await go(s), 0, text(s));
  assert.deepEqual(s.mut, ["migrations", "deploy"]);
  assert.equal(s.asked.length, 1);
  assert.equal(s.calls.at(-1).env.CLOUDFLARE_ACCOUNT_ID, "acc2");
});

test("a failed subscriber POST exits 1 and the next run only finishes the subscriber", async () => {
  const s = makeWorld({ postFails: 1 });
  assert.equal(await go(s), 1);
  assert.match(text(s), /subscriber/i);
  assert.match(text(s), /npm run setup/);
  reset(s);
  assert.equal(await go(s), 0, text(s));
  assert.deepEqual(s.mut, ["migrations", "deploy", "secret put WEBHOOK_SECRET", "POST subscriber"]);
  assert.deepEqual(leaks(s), []);
});

test("dry-run runs only read-only commands, writes nothing and asks no secret", async () => {
  const s = makeWorld();
  assert.equal(await go(s, "--dry-run"), 0, text(s));
  assert.deepEqual(s.calls.filter((c) => !readOnly(c)).map((c) => c.cmd.join(" ")), []);
  assert.deepEqual(s.mut, []);
  assert.deepEqual(s.writes, []);
  assert.equal(s.fetches.filter((f) => f.method !== "GET").length, 0);
  assert.equal(s.asked.some((a) => a.hidden), false);
  assert.match(text(s), /Would/);
});

test("fresh dry-run with --watch writes no file and does not log in", async () => {
  const s = makeWorld({ loggedIn: false });
  assert.equal(await go(s, "--dry-run", "--watch"), 0, text(s));
  assert.deepEqual(s.mut, []);
  assert.deepEqual(s.writes, []);
  assert.equal(s.files.has(PROPS), false);
});

test("--watch generates the token, puts it and writes local.properties", async () => {
  const s = makeWorld();
  assert.equal(await go(s, "--watch"), 0, text(s));
  const token = s.w.secretValues.WATCH_TOKEN;
  assert.ok(token.length >= 32);
  assert.equal(s.files.get(PROPS), `sdk.dir=/sdk\nwatchToken=${token}\nwatchBaseUrl=https://${DOMAIN}\n`);
  assert.deepEqual(leaks(s, { except: [PROPS, "WATCH_TOKEN"] }), []);
  assert.ok(!text(s).includes(token));
  reset(s);
  assert.equal(await go(s, "--watch"), 0, text(s));
  assert.deepEqual(s.mut, ["migrations", "deploy"]);
});

test("--watch rotates the token when the file is missing and says the watch must be rebuilt", async () => {
  const s = await installed();
  s.w.secrets.push("WATCH_TOKEN");
  assert.equal(await go(s, "--watch"), 0, text(s));
  assert.ok(puts(s).includes("WATCH_TOKEN"));
  assert.match(s.files.get(PROPS), /watchToken=\S+/);
  assert.match(text(s), /rebuilt and reinstalled/);
});

test("--watch keeps other keys in an existing local.properties", async () => {
  const s = makeWorld({ files: { [PROPS]: "org.gradle.jvmargs=-Xmx2g\nsdk.dir=/old\nwatchToken=\n" } });
  assert.equal(await go(s, "--watch"), 0, text(s));
  const token = s.w.secretValues.WATCH_TOKEN;
  assert.equal(s.files.get(PROPS), `org.gradle.jvmargs=-Xmx2g\nsdk.dir=/sdk\nwatchToken=${token}\nwatchBaseUrl=https://${DOMAIN}\n`);
});

test("--watch without an Android SDK folder stops before changing anything", async () => {
  const s = makeWorld({ env: {} });
  assert.equal(await go(s, "--watch"), 1);
  assert.match(text(s), /ANDROID_HOME/);
  assert.deepEqual(s.mut, []);
});

test("saved answers that are not valid JSON or miss fields are refused before any change", async () => {
  for (const content of ["{not json", JSON.stringify({ domain: DOMAIN })]) {
    const s = makeWorld({ files: { [LOCAL]: content } });
    assert.equal(await go(s), 1);
    assert.match(text(s), /setup\.local\.json/);
    assert.deepEqual(s.mut, []);
    assert.deepEqual(s.writes, []);
  }
});

test("a saved domain that differs from the existing config is refused", async () => {
  const s = await installed();
  s.files.set(CONFIG, s.files.get(CONFIG).replace(DOMAIN, "other.example.com"));
  assert.equal(await go(s), 1);
  assert.match(text(s), /other\.example\.com/);
  assert.deepEqual(s.mut, []);
});

test("invalid domain or email is refused", async () => {
  for (const answers of [{ domain: "https://health.example.com/x" }, { email: "nobody" }]) {
    const s = makeWorld();
    s.w.answers = { ...s.w.answers, ...answers };
    assert.equal(await go(s), 1);
    assert.deepEqual(s.mut, []);
  }
});

test("a changed client ID re-puts only the three credentials", async () => {
  const s = await installed();
  s.w.answers.clientId = "client-id-2";
  s.w.confirms = [false, true];
  assert.equal(await go(s), 0, text(s));
  assert.deepEqual(puts(s).sort(), ["ALLOWED_EMAIL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  assert.equal(saved(s).credentialsHash, hash("me@example.com", "client-id-2"));
});

test("a manual edit of the saved client ID triggers a re-put", async () => {
  const s = await installed();
  s.files.set(LOCAL, JSON.stringify({ ...saved(s), clientId: "edited" }));
  assert.equal(await go(s), 0, text(s));
  assert.deepEqual(puts(s).sort(), ["ALLOWED_EMAIL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  throughWrangler(s);
});

test("a failed credential upload stays pending and the re-run puts all three again", async () => {
  const s = makeWorld({ putFails: { GOOGLE_CLIENT_ID: 1 } });
  assert.equal(await go(s), 1);
  assert.equal(saved(s).pendingCredentials, true);
  assert.equal(saved(s).credentialsHash, undefined);
  reset(s);
  assert.equal(await go(s), 0, text(s));
  assert.deepEqual(puts(s).filter((n) => n.startsWith("G") || n === "ALLOWED_EMAIL").sort(), ["ALLOWED_EMAIL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  assert.equal(saved(s).pendingCredentials, undefined);
});

test("resources are looked up by name: an existing D1 is reused and only KV is created", async () => {
  const s = makeWorld({ d1: [{ uuid: "old-d1", name: "health-tracker" }] });
  await go(s);
  assert.deepEqual(s.mut.filter((m) => m.endsWith("create")), ["kv create"]);
  assert.match(s.files.get(CONFIG), /"database_id": "old-d1"/);
});

test("the site is retried while the new domain gets its certificate, then gives up with advice", async () => {
  const s = makeWorld({ siteFailures: 3 });
  assert.equal(await go(s), 0, text(s));
  const t = makeWorld({ siteFailures: 1000 });
  assert.equal(await go(t), 1);
  assert.match(text(t), /run npm run setup again/i);
  assert.ok(t.clock - 1_700_000_000_000 <= 130_000);
});

test("connect gives up after 10 minutes with a next action", async () => {
  const s = makeWorld({ connectOnOpen: false });
  assert.equal(await go(s), 1);
  assert.match(text(s), /10 minutes/);
});

test("verify fails with a next action only when 5 or more items are stuck", async () => {
  const s = await installed({ attempts: 4 });
  assert.equal(await go(s), 0, text(s));
  s.w.attempts = 5;
  assert.equal(await go(s), 1);
  assert.match(text(s), /health_status/);
});

test("an existing subscriber is reused, but needs its WEBHOOK_SECRET", async () => {
  const sub = { name: "projects/123456/subscribers/health-tracker", endpointUri: `https://${DOMAIN}/webhooks/google` };
  const s = makeWorld({ subs: [sub], pageSize: 1 });
  s.w.subs.unshift({ name: "projects/123456/subscribers/other", endpointUri: "https://other.example/x" });
  assert.equal(await go(s), 1);
  assert.match(text(s), /docs\/operations\.md/);
  assert.deepEqual(s.mut, []);
  const t = await installed();
  assert.equal(await go(t), 0, text(t));
  assert.ok(!t.mut.includes("POST subscriber"));
  assert.ok(!puts(t).includes("WEBHOOK_SECRET"));
});

test("a health-tracker subscriber with another endpoint is refused untouched", async () => {
  const s = makeWorld({ subs: [{ name: "projects/123456/subscribers/health-tracker", endpointUri: "https://elsewhere.example/hook" }] });
  assert.equal(await go(s), 1);
  assert.match(text(s), /elsewhere\.example/);
  assert.deepEqual(s.mut, []);
});

test("a lost TOKEN_ENC_KEY gets a new key and the Google connection is redone", async () => {
  const s = await installed();
  s.w.secrets = s.w.secrets.filter((n) => n !== "TOKEN_ENC_KEY");
  s.w.token = Math.floor(s.clock / 1000) - 1000;
  assert.equal(await go(s), 0, text(s));
  assert.ok(puts(s).includes("TOKEN_ENC_KEY"));
  assert.ok(s.mut.includes(`open https://${DOMAIN}/google/connect`));
  assert.ok(s.w.token >= Math.floor(s.clock / 1000) - 1);
});

test("a timed-out reconnect after a lost key is remembered, so the next run opens Google again", async () => {
  const s = await installed();
  s.w.secrets = s.w.secrets.filter((n) => n !== "TOKEN_ENC_KEY");
  s.w.token = Math.floor(s.clock / 1000) - 1000;
  s.w.connectOnOpen = false;
  assert.equal(await go(s), 1);
  assert.ok(saved(s).reconnectSince > 0);
  reset(s);
  s.w.connectOnOpen = true;
  assert.equal(await go(s), 0, text(s));
  assert.ok(s.mut.includes(`open https://${DOMAIN}/google/connect`));
  assert.equal(saved(s).reconnectSince, undefined);
});

test("rejecting the saved answers and typing the same ones still re-puts the three credentials", async () => {
  const s = await installed();
  s.w.confirms = [false, true];
  assert.equal(await go(s), 0, text(s));
  assert.deepEqual(puts(s).sort(), ["ALLOWED_EMAIL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  throughWrangler(s);
});

test("verify accepts only a non-negative integer stuck count", async () => {
  for (const queueResult of [null, "", -1, "abc", "3", 1.5, "none"]) {
    const s = makeWorld({ queueResult });
    assert.equal(await go(s), 1, String(queueResult));
    assert.match(text(s), /sync queue/);
    assert.ok(!text(s).includes("All set"));
  }
  const failed = makeWorld();
  failed.w.dbError = "D1 is down";
  assert.equal(await go(failed), 1);
  assert.ok(!text(failed).includes("All set"));
  const zero = makeWorld({ queueResult: 0 });
  assert.equal(await go(zero), 0, text(zero));
});

test("the client secret goes only through wrangler's own prompt", async () => {
  const s = makeWorld();
  await go(s);
  throughWrangler(s);
  assert.equal(s.calls.filter((c) => c.inherit).length, 1);
  assert.equal(s.asked.some((a) => /secret/i.test(a.question)), false);
});

test("an unmigrated database means not connected, but other database errors stop the run", async () => {
  const s = makeWorld();
  assert.equal(await go(s), 0, text(s)); // the first Google token lookup ran before the migrations
  const t = await installed();
  t.w.dbError = "D1 internal error";
  assert.equal(await go(t), 1);
  assert.match(text(t), /Could not read your database/);
});

test("a rerun reads the real JSONC template (comments, trailing commas) and keeps the owner's settings", async () => {
  const s = await installed();
  const template = s.files.get(`${WORKER}/wrangler.production.example.jsonc`)
    .replaceAll("<your-domain>", DOMAIN).replace("<your IANA time zone>", "Australia/Sydney")
    .replace("<d1-database-id>", "d1-uuid").replace("<kv-namespace-id>", "kv-id");
  assert.match(template, /\/\//);
  s.files.set(CONFIG, template);
  assert.equal(await go(s), 0, text(s));
  assert.equal(s.files.get(CONFIG), template);
  assert.deepEqual(s.writes, []);
});

test("a partly filled config gets only its missing id field rewritten", async () => {
  const s = makeWorld();
  const template = s.files.get(`${WORKER}/wrangler.production.example.jsonc`)
    .replaceAll("<your-domain>", DOMAIN).replace("<your IANA time zone>", "Australia/Sydney").replace("<d1-database-id>", "mine");
  s.files.set(CONFIG, template);
  assert.equal(await go(s), 0, text(s));
  assert.equal(s.files.get(CONFIG), template.replace("<kv-namespace-id>", "kv-id"));
});

test("a TOKEN_ENC_KEY upload cut off before the timestamp is uploaded again", async () => {
  const s = await installed();
  s.files.set(LOCAL, JSON.stringify({ ...saved(s), reconnectPending: true })); // key was in Cloudflare, timestamp never saved
  s.w.token = Math.floor(s.clock / 1000) - 100; // stored before the new key
  assert.equal(await go(s), 0, text(s));
  assert.ok(puts(s).includes("TOKEN_ENC_KEY"));
  assert.ok(s.mut.includes(`open https://${DOMAIN}/google/connect`));
  assert.equal(saved(s).reconnectPending, undefined);
});

test("a second recovery clears the old timestamp before it uploads", async () => {
  const s = await installed();
  s.w.secrets = s.w.secrets.filter((n) => n !== "TOKEN_ENC_KEY");
  s.files.set(LOCAL, JSON.stringify({ ...saved(s), reconnectPending: true, reconnectSince: 5 }));
  s.w.putFails.TOKEN_ENC_KEY = 1;
  assert.equal(await go(s), 1);
  assert.equal(saved(s).reconnectPending, true);
  assert.equal(saved(s).reconnectSince, undefined);
});

test("a token stored in the same second as the key upload does not count as reconnected", async () => {
  const s = await installed();
  const since = Math.floor(s.clock / 1000);
  s.files.set(LOCAL, JSON.stringify({ ...saved(s), reconnectPending: true, reconnectSince: since }));
  s.w.token = since;
  assert.equal(await go(s), 0, text(s));
  assert.ok(s.mut.includes(`open https://${DOMAIN}/google/connect`));
  assert.ok(s.w.token > since);
});

test("a failed key upload leaves the pending marker without a timestamp", async () => {
  const s = await installed();
  s.w.secrets = s.w.secrets.filter((n) => n !== "TOKEN_ENC_KEY");
  s.w.putFails.TOKEN_ENC_KEY = 1;
  assert.equal(await go(s), 1);
  assert.equal(saved(s).reconnectPending, true);
  assert.equal(saved(s).reconnectSince, undefined);
});

test("--watch repairs sdk.dir and watchBaseUrl but keeps the token and other keys, with no SDK variable set", async () => {
  const s = await installed({ env: {} });
  s.w.secrets.push("WATCH_TOKEN");
  s.files.set(PROPS, "# mine\nsdk.dir=/my/sdk\nwatchToken=keep-me\nwatchBaseUrl=https://wrong.example.com\nextra=1\n");
  assert.equal(await go(s, "--watch"), 0, text(s));
  assert.equal(s.files.get(PROPS), `# mine\nsdk.dir=/my/sdk\nwatchToken=keep-me\nwatchBaseUrl=https://${DOMAIN}\nextra=1\n`);
  assert.ok(!puts(s).includes("WATCH_TOKEN"));
});

test("a blank watchToken followed by another property is rotated, not read as the next line", async () => {
  const s = await installed();
  s.w.secrets.push("WATCH_TOKEN");
  s.files.set(PROPS, "sdk.dir=/sdk\nwatchToken=\nwatchBaseUrl=https://old.example.com\n");
  assert.equal(await go(s, "--watch"), 0, text(s));
  const token = s.w.secretValues.WATCH_TOKEN;
  assert.ok(puts(s).includes("WATCH_TOKEN"));
  assert.equal(s.files.get(PROPS), `sdk.dir=/sdk\nwatchToken=${token}\nwatchBaseUrl=https://${DOMAIN}\n`);
});

test("before the first deploy an unknown Worker means no secrets; any other list failure stops", async () => {
  const s = makeWorld();
  assert.equal(await go(s), 0, text(s)); // the list failed with wrangler's coloured "not found" message until deploy
  assert.ok(s.calls.some((c) => c.cmd.includes("list") && c.cmd.includes("--format")));
  const t = await installed();
  t.w.secretListError = "Authentication error [code: 10000]";
  assert.equal(await go(t), 1);
  assert.match(text(t), /Could not list the Worker secrets/);
  assert.deepEqual(t.mut, []);
});

test("the watch token is 43 URL-safe characters, long enough for the Worker", async () => {
  const s = makeWorld();
  await go(s, "--watch");
  assert.match(s.w.secretValues.WATCH_TOKEN, /^[A-Za-z0-9_-]{43}$/); // watch.ts needs at least 32
});

test("the node test runner fails when no test ran", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-"));
  const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "run.mjs"), dir], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No node tests ran/);
});

test("the Google client secret is never written to disk", async () => {
  const s = makeWorld();
  await go(s);
  for (const [path, content] of s.files) assert.ok(!content.includes(CLIENT_SECRET), path);
});
