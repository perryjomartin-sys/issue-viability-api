/**
 * Deterministic configuration constants for the decision engine.
 *
 * Every value here is part of the API's public contract: the assessment output
 * is a pure function of (repo, issue, GitHub state, UTC date, THIS object).
 * Changing a number here changes published behaviour and must be deliberate.
 */
export const CONFIG = {
  /** An open competing PR updated within this many days => "recent competitor". */
  COMPET_DAYS: 14,
  /** Repo counts as active if its last push/commit is within this many days. */
  REPO_DAYS: 90,
  /** An assignment older than this many days is treated as stale. */
  ASSIGN_STALE_DAYS: 45,
  /** An issue older than this (and quiet) is flagged as possibly stale. */
  ISSUE_STALE_DAYS: 365,
  /** Timeline items requested from GitHub in one page. */
  TIMELINE_PAGE_SIZE: 100,
  /** Cache: seconds a cached success response is served as fresh. */
  CACHE_FRESH_SECONDS: 600,
  /** Cache: total seconds retained; 600..3600 is stale-fallback only. */
  CACHE_STALE_SECONDS: 3600,
  /**
   * Floor on the GitHub credential's projected remaining GraphQL points. A live
   * call is admitted only if reserving it keeps the projection at/above this;
   * otherwise serve a valid stale cache, else 503 + `Retry-After`, until the
   * window resets (`rateLimit.resetAt`).
   *
   * ENFORCED via the atomic-reservation `RateBudget` (`src/rate-budget.ts`,
   * wired in `src/app.ts`): reserve -> fetch -> reconcile, so concurrent cache
   * misses subtract each other's projected cost before any response returns. A
   * fetch that fails/times out is reconciled as `indeterminate` — the GraphQL
   * request may have been charged, so its reserved cost stays debited until the
   * window resets (fail closed). The budget itself is learned ONLY from GitHub's
   * non-chargeable `GET /rate_limit` (`resources.graphql`): while it is unknown
   * (cold start / post-reset) NO assessment is admitted — one caller is elected,
   * under a single-use owner token, to recover it, the rest wait. Only that
   * token's holder may fold the result in (monotonically), and a failed recovery
   * persists a backoff (server `Retry-After`, else 60 s) during which no
   * election and no assessment occur — zero chargeable assessments either way.
   * Governs GitHub's GraphQL *points* bucket only; the REST fallback draws the
   * separate REST request bucket. The default `MemoryRateBudget` is per process
   * (fine for `npm run dev`); a Worker injects `RateBudgetDO`
   * (`src/worker/rate-budget-do.ts`, a SQLite Durable Object).
   */
  RATE_LIMIT_FLOOR: 150,
} as const;

export type Config = typeof CONFIG;
