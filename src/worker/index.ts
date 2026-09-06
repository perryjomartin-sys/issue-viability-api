/**
 * Cloudflare Worker entrypoint — deployed at
 * https://issue-viability-api.agentactiongateway.workers.dev.
 *
 * Runs the existing Hono app (`createApp`) with:
 *   - `GITHUB_TOKEN`      (secret)  GitHub read token
 *   - `X402_*`            (vars/secret) x402 V2 settings; Base Sepolia by default
 *   - `RATE_BUDGET`       (Durable Object) shared rate-limit-floor coordination
 *   - `VIABILITY_CACHE`   (Workers KV, optional) shared fresh/stale cache
 *
 * See `wrangler.jsonc`. `VIABILITY_CACHE` is optional: when the binding is
 * absent (e.g. a `wrangler dev` run without it configured), `createApp` falls
 * back to its default isolate-local `MemoryCache` rather than failing.
 */
import { createApp } from "../app.ts";
import { durableObjectRateBudget, type DurableObjectNamespace } from "./rate-budget-do.ts";
import { KVCache, type KVNamespace } from "./kv-cache.ts";

export { RateBudgetDO } from "./rate-budget-do.ts";

interface Env {
  GITHUB_TOKEN?: string;
  X402_ENABLED?: string;
  X402_NETWORK?: string;
  X402_ASSET?: string;
  X402_PAY_TO?: string;
  X402_FACILITATOR_URL?: string;
  X402_PRICE?: string;
  X402_RESOURCE_URL?: string;
  X402_BAZAAR?: string;
  X402_MAINNET_APPROVED?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  RATE_BUDGET: DurableObjectNamespace;
  VIABILITY_CACHE?: KVNamespace;
}

/** Minimal Cloudflare `ExecutionContext` shape (avoids `@cloudflare/workers-types`). */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** Built once per isolate, reused across requests. */
let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (!app) {
      app = createApp(
        {
          GITHUB_TOKEN: env.GITHUB_TOKEN,
          X402_ENABLED: env.X402_ENABLED,
          X402_NETWORK: env.X402_NETWORK,
          X402_ASSET: env.X402_ASSET,
          X402_PAY_TO: env.X402_PAY_TO,
          X402_FACILITATOR_URL: env.X402_FACILITATOR_URL,
          X402_PRICE: env.X402_PRICE,
          X402_RESOURCE_URL: env.X402_RESOURCE_URL,
          X402_BAZAAR: env.X402_BAZAAR,
          X402_MAINNET_APPROVED: env.X402_MAINNET_APPROVED,
          CDP_API_KEY_ID: env.CDP_API_KEY_ID,
          CDP_API_KEY_SECRET: env.CDP_API_KEY_SECRET,
        },
        {
          rateBudget: durableObjectRateBudget(env.RATE_BUDGET),
          cache: env.VIABILITY_CACHE ? new KVCache(env.VIABILITY_CACHE) : undefined,
        },
      );
    }
    // `ctx` (waitUntil / passThroughOnException) is unused by our handlers.
    void ctx;
    return app.fetch(request, env as unknown as Record<string, unknown>);
  },
};
