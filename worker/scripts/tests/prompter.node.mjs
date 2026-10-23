import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { childEnv, createPrompter, run } from "../io.mjs";

test("one stream with several piped lines answers every question", async () => {
  const input = new PassThrough();
  const { ask, close } = createPrompter(input, new PassThrough());
  input.end("health.example.com\nme@example.com\nclient-id\nlast\n");
  assert.equal(await ask("Domain:"), "health.example.com");
  assert.equal(await ask("Email:"), "me@example.com");
  assert.equal(await ask("Client ID:"), "client-id");
  assert.equal(await ask("Last:"), "last");
  assert.equal(await ask("After the end:"), "");
  close();
});

test("during a handoff the parent reads nothing; the next question opens a fresh reader", async () => {
  const input = new PassThrough();
  const { ask, handoff, close } = createPrompter(input, new PassThrough());
  input.write("first\n");
  assert.equal(await ask("One:"), "first");
  await handoff(async () => {
    input.write("typed-into-the-child\n"); // the child owns the terminal now
    await new Promise((r) => setImmediate(r));
    assert.equal(String(input.read()), "typed-into-the-child\n"); // still unread by the parent
    assert.equal(input.isPaused(), true);
  });
  input.write("after\n");
  assert.equal(await ask("Two:"), "after");
  close();
});

test("child processes get no wrangler disk logs and forced log redaction", async () => {
  assert.equal(childEnv({ WRANGLER_LOG_SANITIZE: "false" }).WRANGLER_LOG_SANITIZE, "true");
  assert.equal(childEnv({ WRANGLER_WRITE_LOGS: "true" }).WRANGLER_WRITE_LOGS, "false");
  const r = await run([process.execPath, "-e", "console.log(process.env.WRANGLER_WRITE_LOGS, process.env.WRANGLER_LOG_SANITIZE, process.env.X)"], { env: { WRANGLER_LOG_SANITIZE: "false", X: "1" } });
  assert.equal(r.stdout.trim(), "false true 1");
});
