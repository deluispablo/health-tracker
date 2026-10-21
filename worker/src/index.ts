import { handleScheduled, route } from "./app";
import type { AppDeps, AppEnv } from "./app";

const deps: AppDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Math.floor(Date.now() / 1000),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export default {
  fetch(request, env): Promise<Response> {
    return route(request, env, deps);
  },
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(handleScheduled(controller.cron, env, deps));
  },
} satisfies ExportedHandler<AppEnv>;
