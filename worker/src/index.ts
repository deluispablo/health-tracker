import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { handleScheduled, route } from "./app";
import { withStoredTz } from "./lib/time";
import type { AppDeps, ConnectorEnv } from "./app";
import { login } from "./auth/login";

const deps: AppDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Math.floor(Date.now() / 1000),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let provider: OAuthProvider<ConnectorEnv> | undefined;

export default {
  fetch(request, env, ctx): Promise<Response> {
    provider ??= new OAuthProvider<ConnectorEnv>({
      apiRoute: "/mcp", apiHandler: { fetch: async (request, env, ctx) => (await import("./mcp/server")).mcp(request, await withStoredTz(env), ctx) },
      authorizeEndpoint: `${env.PUBLIC_ORIGIN}/authorize`, tokenEndpoint: `${env.PUBLIC_ORIGIN}/oauth/token`,
      clientRegistrationEndpoint: `${env.PUBLIC_ORIGIN}/oauth/register`,
      scopesSupported: ["health:read"], requiredScopes: ["health:read"], clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, authorization_servers: [env.PUBLIC_ORIGIN] },
      defaultHandler: {
        fetch(request, env, ctx) {
          const path = new URL(request.url).pathname;
          return path === "/authorize" || path === "/oauth/google/callback"
            ? login(request, env, deps, ctx) : route(request, env, deps);
        },
      },
    });
    return provider.fetch(request, env, ctx);
  },
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(handleScheduled(controller.cron, env, deps));
  },
} satisfies ExportedHandler<ConnectorEnv>;
