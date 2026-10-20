declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    OAUTH_KV: KVNamespace;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
