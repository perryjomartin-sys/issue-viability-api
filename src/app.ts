import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono, type Context } from "hono";

import { MemoryCache, freshness, toStale, type CacheEntry, type ViabilityCache } from "./cache.ts";
import { assess } from "./decision.ts";
import { ymd } from "./dates.ts";
import {
  fetchRateLimit,
  fetchSignals,
  parseRepoSlug,
  type FetchLike,
  type RateLimitSnapshot,
} from "./github.ts";
import { parseGraphQL } from "./parse.ts";
import {
  installPaymentGate,
  logX402,
  paymentGateActive,
  readPaymentConfig,
  requestCorrelationId,
} from "./payments.ts";
import {
  FALLBACK_RETRY_MS,
  MemoryRateBudget,
  RESERVATION_COST_FLOOR,
  type RateBudget,
  type Reconciliation,
  type ReserveDecision,
} from "./rate-budget.ts";
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
  /**
   * Injectable shared rate-budget store. Defaults to a process-local
   * `MemoryRateBudget`; a Worker passes a Durable-Object-backed implementation.
   */
  rateBudget?: RateBudget;
  /**
   * Injectable authoritative-recovery source (tests). Defaults to a real
   * `GET /rate_limit` call with the configured token. Used only when the rate
   * budget elects this request to recover an unknown GraphQL points budget.
   */
  rateLimitSource?: () => Promise<RateLimitSnapshot>;
}

/** "Never resets" — used for the synthetic budget in offline fixture-replay mode. */
const OFFLINE_RESET_MS = 4_102_444_800_000; // 2100-01-01T00:00:00Z

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
  // Only log the protected-handler lifecycle (below) when x402 is actually
  // gating the route — observability scoped to the thing being observed.
  const x402Active = paymentGateActive(paymentCfg);

  // CONFIG.RATE_LIMIT_FLOOR enforcement, behind the shared RateBudget abstraction
  // (atomic reserve -> fetch -> reconcile; see src/rate-budget.ts). The default
  // MemoryRateBudget is per process; a Worker injects a Durable-Object-backed
  // implementation that coordinates the one GitHub credential fleet-wide.
  // Offline fixture-replay mode never calls GitHub, so start with a synthetic
  // known budget (no cold-start recovery ceremony); otherwise start UNKNOWN so
  // the first live request performs a GET /rate_limit recovery.
  const rateBudget: RateBudget =
    deps.rateBudget ??
    (env.IVA_DEV_FIXTURES
      ? new MemoryRateBudget({ remaining: 5_000, resetAtMs: OFFLINE_RESET_MS, cost: 1 })
      : new MemoryRateBudget());

  /** Settle a reservation. Never throws: a failed reconcile leaves the
   *  reservation in place, held to the reset window (over-block, never a bypass). */
  const settle = async (id: string, result: Reconciliation, nowMs: number): Promise<void> => {
    try {
      await rateBudget.reconcile(id, result, nowMs);
    } catch {
      /* fail closed: do not retry here, do not release */
    }
  };

  /** Authoritative GraphQL points budget via GitHub's non-chargeable
   *  `GET /rate_limit`. Only called when the rate budget elects this request.
   *  (In offline fixture-replay mode the budget is pre-seeded, so this is never
   *  reached — see `rateBudget` above.) */
  const getRateLimit: () => Promise<RateLimitSnapshot> =
    deps.rateLimitSource ??
    (() => {
      if (!env.GITHUB_TOKEN) throw new GitHubUpstreamError("no GitHub token configured");
      return fetchRateLimit({ token: env.GITHUB_TOKEN, fetchImpl: deps.fetchImpl });
    });

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

    const correlationId = x402Active ? requestCorrelationId((name) => c.req.header(name)) : "";
    if (x402Active) {
      // Only reachable once the x402 gate has called `next()` (payment
      // verified or gate inactive) — see src/payments.ts.
      logX402("protected_handler_entered", { correlationId, repo, issue });
    }

    const today = now();
    const nowMs = today.getTime();
    const key = `v1:${repo}:${issue}:${ymd(today)}`;
    const cached = await cache.get(key);

    if (freshness(cached, nowMs) === "fresh") {
      c.header("x-cache", "fresh");
      return c.json(cached!.body, 200);
    }

    // Atomically reserve headroom for a live call. A thrown error from the store
    // is treated as "blocked" (fail closed), never bypassed.
    let reservation: ReserveDecision;
    try {
      reservation = await rateBudget.reserveLiveCall(nowMs);
    } catch {
      reservation = { ok: false, retryAfterMs: FALLBACK_RETRY_MS };
    }
    if (x402Active) {
      logX402("rate_budget_reservation", {
        correlationId,
        outcome: reservation.ok ? "admitted" : "recover" in reservation ? "recovery_elected" : "blocked",
      });
    }

    // Budget unknown and we were elected to recover it: run the authoritative,
    // non-chargeable GET /rate_limit, persist it, and bounce this request so it
    // retries against a known budget. A chargeable assessment is NEVER used to
    // discover the budget; a failed recovery admits ZERO assessments.
    if (!reservation.ok && "recover" in reservation) {
      const recoveryToken = reservation.recoveryToken;
      let recovered = false;
      let backoffMs = FALLBACK_RETRY_MS;
      try {
        const rl = await getRateLimit();
        await rateBudget.recover(
          recoveryToken,
          {
            outcome: "observed",
            rateLimit: {
              remaining: rl.graphqlRemaining,
              resetAtMs: rl.graphqlResetAtMs,
              cost: RESERVATION_COST_FLOOR,
            },
          },
          nowMs,
        );
        recovered = true;
      } catch (err) {
        const secondaryMs =
          err instanceof GitHubRateLimitedError ? err.retryAfterSeconds * 1000 : undefined;
        if (secondaryMs !== undefined) backoffMs = secondaryMs;
        try {
          // Persist a recovery backoff so a non-compliant client cannot drive
          // repeated serial GET /rate_limit calls. Only the current lease owner
          // (this token) can set it.
          await rateBudget.recover(recoveryToken, { outcome: "failed", retryAfterMs: secondaryMs }, nowMs);
        } catch {
          /* recovery lease will TTL-clear on its own; a fresh caller retries */
        }
      }
      if (freshness(cached, nowMs) === "stale") {
        c.header("x-cache", "stale");
        return c.json(toStale(cached!.body), 200);
      }
      const retryMs = recovered ? reservation.retryAfterMs : backoffMs;
      c.header("retry-after", String(Math.min(3600, Math.max(1, Math.ceil(retryMs / 1000)))));
      return c.json(
        {
          error: "rate_limited",
          detail: recovered
            ? "learning GitHub API budget; retry shortly"
            : "GitHub API budget unavailable; retry after backoff",
        },
        503,
      );
    }

    if (!reservation.ok) {
      if (freshness(cached, nowMs) === "stale") {
        c.header("x-cache", "stale");
        return c.json(toStale(cached!.body), 200);
      }
      c.header(
        "retry-after",
        String(Math.min(3600, Math.max(1, Math.ceil(reservation.retryAfterMs / 1000)))),
      );
      return c.json(
        { error: "rate_limited", detail: "GitHub API budget below the safe floor; retry after reset" },
        503,
      );
    }

    const reservationId = reservation.reservationId;
    if (x402Active) logX402("github_assessment_started", { correlationId, repo, issue });
    let signals: Signals;
    try {
      signals = await getSignals(repo!, issue!);
    } catch (err) {
      // A GraphQL request may have been dispatched and charged even though we
      // got no response. Keep the reserved cost debited (fail closed).
      await settle(reservationId, { outcome: "indeterminate" }, nowMs);
      return handleError(c, err, cached, nowMs);
    }

    const body = assess(signals, today);
    if (x402Active) logX402("assessment_completed", { correlationId, recommendation: body.recommendation });
    // `ViabilityCache.set` never throws (implementations swallow their own
    // write failures), so awaiting it here cannot turn this successful
    // assessment into an error response.
    await cache.set(key, body, nowMs);
    // GraphQL success -> authoritative rateLimit. A REST fallback (rateLimit
    // null) means the GraphQL attempt failed at transport *after being sent*,
    // so it may still have been charged: indeterminate, not "not-sent".
    const result: Reconciliation = signals.rateLimit
      ? {
          outcome: "observed",
          rateLimit: {
            remaining: signals.rateLimit.remaining,
            resetAtMs: parseResetAt(signals.rateLimit.resetAt, nowMs),
            cost: signals.rateLimit.cost > 0 ? signals.rateLimit.cost : 1,
          },
        }
      : { outcome: "indeterminate" };
    await settle(reservationId, result, nowMs);
    c.header("x-cache", "miss");
    return c.json(body, 200);
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

/** GitHub `rateLimit.resetAt` (ISO) -> epoch ms; falls back to now + 1h. */
function parseResetAt(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : nowMs + 3_600_000;
}

function handleError(
  c: Context,
  err: unknown,
  cached: CacheEntry | undefined,
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
