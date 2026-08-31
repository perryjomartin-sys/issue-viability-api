import { CONFIG } from "./config.ts";
import type { Assessment } from "./types.ts";

export interface CacheEntry {
  body: Assessment;
  storedAtMs: number;
}

export interface ViabilityCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, body: Assessment, nowMs: number): void;
}

/**
 * Process-local cache used for local runs (step E). In production this is
 * replaced by a Workers KV namespace with the same fresh/stale contract:
 *   - 0 .. CACHE_FRESH_SECONDS   -> served as fresh
 *   - CACHE_FRESH .. CACHE_STALE -> served only as a fallback when GitHub fails
 *   - > CACHE_STALE_SECONDS      -> discarded
 */
export class MemoryCache implements ViabilityCache {
  #map = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.#map.get(key);
  }

  set(key: string, body: Assessment, nowMs: number): void {
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
