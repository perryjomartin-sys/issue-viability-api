import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono, type Context } from "hono";

import { MemoryCache, freshness, toStale, type ViabilityCache } from "./cache.ts";
import { CONFIG } from "./config.ts";
import { assess } from "./decision.ts";
import { ymd } from "./dates.ts";
import { fetchSignals, parseRepoSlug, type FetchLike } from "./github.ts";
import { parseGraphQL } from "./parse.ts";
import { installPaymentGate, paymentGateActive, readPaymentConfig } from "./payments.ts";
import type { FacilitatorClient } from "@x402/core/server";
import {
  GitHubNotAnIssueError,
  GitHubNotFoundError,
  GitHubRateLimitedError,
  GitHubUpstreamError,
  type Signals,
} from "./types.ts";

export interface AppEnv {
  /** GitHub token (repo:read is enough). */
  GITHUB_TOKEN?: string;
  /** If set, load raw GraphQL fixtures from this dir instead of calling GitHub. */
  IVA_DEV_FIXTURES?: string;
  /** Injectable clock for tests: ISO string. */
  IVA_NOW?: string;
  /** x402 V2 payment gate on POST /v1/check (Base Sepolia testnet only). OFF unless "true"/"1". */
  X402_ENABLED?: string;
  /** EVM address that receives Base Sepolia testnet USDC. Required when X402_ENABLED. */
  X402_PAY_TO?: string;
  /** Facilitator base URL. Defaults to the public testnet facilitator. */
  X402_FACILITATOR_URL?: string;
  /** Price string, e.g. "$0.005". */
  X402_PRICE?: string;
  /** Public URL of this resource, for x402 discovery metadata. */
  X402_RESOURCE_URL?: string;
  /** Emit the x402 Bazaar discovery extension (default on when enabled). */
  X402_BAZAAR?: string;
}

export interface AppDeps {
  cache?: ViabilityCache;
  fetchImpl?: FetchLike;
  /** Injectable signal source (tests). Overrides fixtures + live fetch. */
  signalSource?: (repo: string, issue: number) => Promise<Signals>;
  now?: () => Date;
  /** Injectable x402 facilitator client (tests) so the payment gate stays offline. */
  facilitatorClient?: FacilitatorClient;
}

const INFO = `Issue Viability API

POST /v1/check   { "repo": "owner/name", "issue": 123 }
GET  /health
GET  /

Tells an AI coding agent whether a public GitHub issue is still rational to work
on before spending tokens implementing it. No accounts, no dashboard.
x402 V2 payments (Base Sepolia testnet) gate POST /v1/check when X402_ENABLED.
`;

function fixtureLoader(dir: string) {
  return async (repo: string, issue: number): Promise<Signals> => {
    const { owner, name } = parseRepoSlug(repo);
    const file = join(dir, `${owner}__${name}__${issue}.json`);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      throw new GitHubNotFoundError(`no fixture ${owner}__${name}__${issue}.json`);
    }
    return parseGraphQL(JSON.parse(raw));
  };
}

export function createApp(env: AppEnv = {}, deps: AppDeps = {}): Hono {
  const app = new Hono();
  const cache = deps.cache ?? new MemoryCache();
  const now = deps.now ?? (() => (env.IVA_NOW ? new Date(env.IVA_NOW) : new Date()));

  // x402 V2 payment gate (Base Sepolia testnet only). Registered before the
  // route handlers so it runs first. Throws if enabled without a valid payTo.
  const paymentCfg = readPaymentConfig(env as Record<string, string | undefined>);
  installPaymentGate(app, paymentCfg, deps.facilitatorClient);

  // G4 — CONFIG.RATE_LIMIT_FLOOR enforcement in the runtime layer. Once the
  // GitHub token's remaining GraphQL budget is seen below the floor, stop making
  // live calls until the window resets: serve a valid stale cache if we have
  // one, else 503 + Retry-After. State is per app instance here; a production
  // Worker would hold it in KV / a Durable Object.
  let budget: { remaining: number; resetAtMs: number } | null = null;

  const budgetBlocks = (nowMs: number): boolean => {
    if (!budget) return false;
    if (nowMs >= budget.resetAtMs) {
      budget = null; // window reset — GitHub budget refills
      return false;
    }
    return budget.remaining < CONFIG.RATE_LIMIT_FLOOR;
  };

  const getSignals: (repo: string, issue: number) => Promise<Signals> =
    deps.signalSource ??
    (env.IVA_DEV_FIXTURES
      ? fixtureLoader(env.IVA_DEV_FIXTURES)
      : (repo, issue) => {
          if (!env.GITHUB_TOKEN) throw new GitHubUpstreamError("no GitHub token configured");
          const { owner, name } = parseRepoSlug(repo);
          return fetchSignals({
            owner,
            name,
            number: issue,
            token: env.GITHUB_TOKEN,
            fetchImpl: deps.fetchImpl,
          });
        });

  app.get("/", (c) => c.text(INFO));

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "issue-viability-api",
      version: "0.1.0",
      upstream: env.IVA_DEV_FIXTURES ? "fixtures" : env.GITHUB_TOKEN ? "github" : "unconfigured",
      payments: paymentGateActive(paymentCfg) ? "x402:eip155:84532" : "disabled",
      utc_date: ymd(now()),
    }),
  );

  app.post("/v1/check", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", detail: "body must be JSON" }, 400);
    }

    const { repo, issue, error } = validate(payload);
    if (error) return c.json({ error: "invalid_request", detail: error }, 400);

    const today = now();
    const nowMs = today.getTime();
    const key = `v1:${repo}:${issue}:${ymd(today)}`;
    const cached = cache.get(key);

    if (freshness(cached, nowMs) === "fresh") {
      c.header("x-cache", "fresh");
      return c.json(cached!.body, 200);
    }

    // G4 — below the rate-limit floor: never make another live call.
    if (budgetBlocks(nowMs)) {
      if (freshness(cached, nowMs) === "stale") {
        c.header("x-cache", "stale");
        return c.json(toStale(cached!.body), 200);
      }
      const retry = Math.max(1, Math.ceil((budget!.resetAtMs - nowMs) / 1000));
      c.header("retry-after", String(retry));
      return c.json(
        { error: "rate_limited", detail: "GitHub API budget below the safe floor; retry after reset" },
        503,
      );
    }

    try {
      const signals = await getSignals(repo!, issue!);
      const body = assess(signals, today);
      cache.set(key, body, nowMs);
      if (signals.rateLimit) {
        const resetAtMs = Date.parse(signals.rateLimit.resetAt);
        budget = {
          remaining: signals.rateLimit.remaining,
          resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : nowMs + 3_600_000,
        };
      }
      c.header("x-cache", "miss");
      return c.json(body, 200);
    } catch (err) {
      return handleError(c, err, cached, nowMs);
    }
  });

  return app;
}

function validate(payload: unknown): { repo?: string; issue?: number; error?: string } {
  if (typeof payload !== "object" || payload === null) return { error: "expected a JSON object" };
  const p = payload as Record<string, unknown>;
  const repo = p.repo;
  const issue = p.issue;
  // `parseRepoSlug` is the single source of truth for what a valid slug is, so
  // the HTTP layer rejects exactly what the GitHub client would reject. A slug
  // that only looks plausible (e.g. "owner/name!") is a 400 here, never an
  // untyped throw further down that surfaces as a misleading 502.
  if (typeof repo !== "string" || !isValidRepoSlug(repo)) {
    return { error: '"repo" must be "owner/name"' };
  }
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) {
    return { error: '"issue" must be a positive integer' };
  }
  return { repo, issue };
}

function isValidRepoSlug(repo: string): boolean {
  try {
    parseRepoSlug(repo);
    return true;
  } catch {
    return false;
  }
}

function handleError(
  c: Context,
  err: unknown,
  cached: ReturnType<ViabilityCache["get"]>,
  nowMs: number,
) {
  if (err instanceof GitHubNotFoundError) {
    return c.json({ error: "not_found", detail: "repository or issue not found" }, 404);
  }
  if (err instanceof GitHubNotAnIssueError) {
    return c.json({ error: "not_an_issue", detail: "that number is a pull request" }, 422);
  }

  const canServeStale = freshness(cached, nowMs) === "stale";

  if (err instanceof GitHubRateLimitedError) {
    if (canServeStale) {
      c.header("x-cache", "stale");
      return c.json(toStale(cached!.body), 200);
    }
    c.header("retry-after", String(err.retryAfterSeconds));
    return c.json({ error: "rate_limited", detail: "GitHub rate limit exhausted" }, 503);
  }

  if (canServeStale) {
    c.header("x-cache", "stale");
    return c.json(toStale(cached!.body), 200);
  }
  return c.json({ error: "upstream_unavailable", detail: "GitHub could not be reached" }, 502);
}
