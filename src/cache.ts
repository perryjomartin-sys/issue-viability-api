import { CONFIG } from "./config.ts";
import type { Assessment } from "./types.ts";

export interface CacheEntry {
  body: Assessment;
  storedAtMs: number;
}

/**
 * Async so a Workers KV-backed implementation (`KVCache`, see
 * `src/worker/kv-cache.ts`) and the process-local `MemoryCache` share one
 * interface. `set` must never throw: cache writes are an optimization and a
 * stale-fallback convenience, not a correctness dependency — an implementation
 * that fails to persist an entry swallows the error internally rather than
 * turning a valid assessment into a failed request.
 */
export interface ViabilityCache {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, body: Assessment, nowMs: number): Promise<void>;
}

/**
 * Process-local cache. Used directly for local runs and tests; in production
 * (Cloudflare Workers) it is replaced by `KVCache`, a Workers KV-backed
 * implementation sharing the same fresh/stale contract:
 *   - 0 .. CACHE_FRESH_SECONDS   -> served as fresh
 *   - CACHE_FRESH .. CACHE_STALE -> served only as a fallback when GitHub fails
 *   - > CACHE_STALE_SECONDS      -> discarded
 * Isolate-local: a Worker's in-memory cache is NOT shared across isolates
 * (see `KVCache` for the fleet-wide layer).
 */
export class MemoryCache implements ViabilityCache {
  #map = new Map<string, CacheEntry>();

  async get(key: string): Promise<CacheEntry | undefined> {
    return this.#map.get(key);
  }

  async set(key: string, body: Assessment, nowMs: number): Promise<void> {
    this.#map.set(key, { body, storedAtMs: nowMs });
    // opportunistic prune
    const cutoff = nowMs - CONFIG.CACHE_STALE_SECONDS * 1000;
    for (const [k, v] of this.#map) {
      if (v.storedAtMs < cutoff) this.#map.delete(k);
    }
  }
}

export type CacheFreshness = "fresh" | "stale" | "expired";

export function freshness(entry: CacheEntry | undefined, nowMs: number): CacheFreshness {
  if (!entry) return "expired";
  const ageSec = (nowMs - entry.storedAtMs) / 1000;
  if (ageSec <= CONFIG.CACHE_FRESH_SECONDS) return "fresh";
  if (ageSec <= CONFIG.CACHE_STALE_SECONDS) return "stale";
  return "expired";
}

/** Downgrade a cached body for stale delivery: never serve GO from stale data. */
export function toStale(body: Assessment): Assessment {
  const downgraded = body.recommendation === "GO";
  return {
    ...body,
    data_quality: "stale",
    recommendation: downgraded ? "CAUTION" : body.recommendation,
    risk: downgraded ? "medium" : body.risk,
    reasons: downgraded
      ? [...body.reasons, "served from stale cache because GitHub was unavailable"]
      : body.reasons,
  };
}
