/**
 * Cloudflare Worker entrypoint — LOCAL ONLY, not deployed.
 *
 * Runs the existing Hono app (`createApp`) with:
 *   - `GITHUB_TOKEN`      (secret)  GitHub read token
 *   - `X402_*`            (vars/secret) x402 V2 settings; Base Sepolia only
 *   - `RATE_BUDGET`       (Durable Object) shared rate-limit-floor coordination
 *
 * See `wrangler.jsonc`. No account, no login, no deploy has been performed.
 */
import { createApp } from "../app.ts";
import { durableObjectRateBudget, type DurableObjectNamespace } from "./rate-budget-do.ts";

export { RateBudgetDO } from "./rate-budget-do.ts";

interface Env {
  GITHUB_TOKEN?: string;
  X402_ENABLED?: string;
  X402_PAY_TO?: string;
  X402_FACILITATOR_URL?: string;
  X402_PRICE?: string;
  X402_RESOURCE_URL?: string;
  X402_BAZAAR?: string;
  RATE_BUDGET: DurableObjectNamespace;
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
          X402_PAY_TO: env.X402_PAY_TO,
          X402_FACILITATOR_URL: env.X402_FACILITATOR_URL,
          X402_PRICE: env.X402_PRICE,
          X402_RESOURCE_URL: env.X402_RESOURCE_URL,
          X402_BAZAAR: env.X402_BAZAAR,
        },
        { rateBudget: durableObjectRateBudget(env.RATE_BUDGET) },
      );
    }
    // `ctx` (waitUntil / passThroughOnException) is unused by our handlers.
    void ctx;
    return app.fetch(request, env as unknown as Record<string, unknown>);
  },
};
