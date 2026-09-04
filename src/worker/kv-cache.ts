/**
 * Workers KV-backed `ViabilityCache` — the fleet-wide layer that replaces
 * `MemoryCache` in production. `MemoryCache` is isolate-local (see
 * `src/worker/index.ts`: `createApp` runs once per isolate), so different
 * isolates never observed each other's writes; this is the fix.
 *
 * Minimal Cloudflare KV ambient type declared locally (only the two methods
 * this file touches), matching this repo's deliberate choice not to depend on
 * `@cloudflare/workers-types` (see the note in `rate-budget-do.ts`).
 *
 * Consistency: Workers KV is EVENTUALLY consistent. A write in one isolate is
 * not guaranteed to be immediately visible to a read in another (or even the
 * same edge location) — this code makes no strong-consistency claim. That is
 * safe here because the fresh/stale/expired contract (`freshness()` in
 * `../cache.ts`) already tolerates a stale or missing read: a request that
 * misses a very recent write just falls through to a live GitHub call (same
 * as any other cache miss), and a stale GO is downgraded by `toStale()`
 * regardless of which cache layer served it.
 */
import { CONFIG } from "../config.ts";
import type { CacheEntry, ViabilityCache } from "../cache.ts";
import type { Assessment } from "../types.ts";

/** Minimal Workers KV surface this file touches. */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Fail-safe shape check: anything else is treated as a cache miss, never a decision input. */
function isCacheEntry(v: unknown): v is CacheEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.storedAtMs === "number" && Number.isFinite(e.storedAtMs) &&
    typeof e.body === "object" && e.body !== null;
}

export class KVCache implements ViabilityCache {
  #kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.#kv = kv;
  }

  /** Malformed JSON, wrong shape, or a KV read error are all treated as a plain miss. */
  async get(key: string): Promise<CacheEntry | undefined> {
    let raw: string | null;
    try {
      raw = await this.#kv.get(key);
    } catch (err) {
      console.error(`[VIABILITY_CACHE] get(${key}) failed; treating as a miss:`, err);
      return undefined;
    }
    if (raw === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`[VIABILITY_CACHE] get(${key}) returned malformed JSON; treating as a miss:`, err);
      return undefined;
    }
    if (!isCacheEntry(parsed)) {
      console.error(`[VIABILITY_CACHE] get(${key}) returned an unexpected shape; treating as a miss`);
      return undefined;
    }
    return parsed;
  }

  /**
   * Never throws: a KV write failure must not turn a valid GitHub-backed
   * assessment into an error response (the assessment already succeeded and
   * is being returned regardless — see call site in `app.ts`). Persisted with
   * `expirationTtl` so KV itself reclaims entries; the app's own
   * `freshness()` check makes anything past `CACHE_STALE_SECONDS` unusable
   * well before Cloudflare's TTL housekeeping runs.
   */
  async set(key: string, body: Assessment, nowMs: number): Promise<void> {
    const entry: CacheEntry = { body, storedAtMs: nowMs };
    try {
      await this.#kv.put(key, JSON.stringify(entry), {
        expirationTtl: CONFIG.CACHE_STALE_SECONDS,
      });
    } catch (err) {
      console.error(`[VIABILITY_CACHE] put(${key}) failed; continuing without a cached copy:`, err);
    }
  }
}
