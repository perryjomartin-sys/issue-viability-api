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
   * Intended floor: once the GitHub token's remaining GraphQL budget drops
   * below this, serve cache-only until the window resets.
   *
   * NOT ENFORCED in this build. Cross-request budget management needs shared,
   * durable state; the local `MemoryCache` stub is per-process and per-run.
   * Enforcement is a Step-G requirement in the production Worker/KV layer:
   * after each fetch, inspect `signals.rateLimit.remaining` and, below this
   * floor, refuse live calls (503 / stale cache) until `rateLimit.resetAt`.
   * `fetchSignals` already surfaces `rateLimit` on every GraphQL result.
   */
  RATE_LIMIT_FLOOR: 150,
} as const;

export type Config = typeof CONFIG;
