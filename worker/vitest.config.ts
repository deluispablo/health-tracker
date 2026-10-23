import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("migrations") // npm scripts run with cwd = worker/;

// No Node types in this project; vitest runs this file in Node.
const ci = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.CI ?? "";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, CI: ci } },
    }),
  ],
});
