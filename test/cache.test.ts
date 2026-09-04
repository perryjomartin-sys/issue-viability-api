import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { MemoryCache, freshness, toStale } from "../src/cache.ts";
import { KVCache, type KVNamespace } from "../src/worker/kv-cache.ts";
import { makeSignals } from "./helpers.ts";
import { assess } from "../src/decision.ts";

const TODAY = new Date("2026-08-30T12:00:00Z");
const NOW_MS = TODAY.getTime();

/** In-memory stand-in for a Workers KV namespace, good enough to exercise KVCache. */
class FakeKV implements KVNamespace {
  #store = new Map<string, string>();
  #failGet = false;
  #failPut = false;

  async get(key: string): Promise<string | null> {
    if (this.#failGet) throw new Error("simulated KV get failure");
    return this.#store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    if (this.#failPut) throw new Error("simulated KV put failure");
    this.#store.set(key, value);
  }

  /** Bypasses put() to inject a raw (possibly malformed) value directly. */
  setRaw(key: string, raw: string): void {
    this.#store.set(key, raw);
  }

  setFailGet(v: boolean): void {
    this.#failGet = v;
  }

  setFailPut(v: boolean): void {
    this.#failPut = v;
  }
}

function makeGoAssessment() {
  return assess(makeSignals(), TODAY); // clean signals -> GO
}

describe("MemoryCache (async local/unit cache)", () => {
  it("is a miss before any write", async () => {
    const cache = new MemoryCache();
    expect(await cache.get("k")).toBeUndefined();
  });

  it("round-trips a written entry through the async get/set path", async () => {
    const cache = new MemoryCache();
    const body = makeGoAssessment();
    await cache.set("k", body, NOW_MS);
    const entry = await cache.get("k");
    expect(entry?.storedAtMs).toBe(NOW_MS);
    expect(entry?.body.recommendation).toBe("GO");
  });

  it("a fresh entry bypasses re-computation (freshness contract)", async () => {
    const cache = new MemoryCache();
    const body = makeGoAssessment();
    await cache.set("k", body, NOW_MS);
    const entry = await cache.get("k");
    expect(freshness(entry, NOW_MS + 5 * 60_000)).toBe("fresh"); // +5min, <= 600s
  });

  it("ages into stale, then expired, per CACHE_FRESH/STALE_SECONDS", async () => {
    const cache = new MemoryCache();
    await cache.set("k", makeGoAssessment(), NOW_MS);
    const entry = await cache.get("k");
    expect(freshness(entry, NOW_MS + 700_000)).toBe("stale"); // 700s: >600, <=3600
    expect(freshness(entry, NOW_MS + 3_700_000)).toBe("expired"); // >3600s
  });

  it("stale GO is downgraded to CAUTION by toStale()", async () => {
    const cache = new MemoryCache();
    await cache.set("k", makeGoAssessment(), NOW_MS);
    const entry = await cache.get("k");
    const staleBody = toStale(entry!.body);
    expect(staleBody.recommendation).toBe("CAUTION");
    expect(staleBody.data_quality).toBe("stale");
  });
});

describe("KVCache (Workers KV-backed cache)", () => {
  it("is a miss before any write", async () => {
    const cache = new KVCache(new FakeKV());
    expect(await cache.get("k")).toBeUndefined();
  });

  it("serializes and deserializes a CacheEntry through KV get/put", async () => {
    const kv = new FakeKV();
    const cache = new KVCache(kv);
    const body = makeGoAssessment();
    await cache.set("k", body, NOW_MS);
    const entry = await cache.get("k");
    expect(entry?.storedAtMs).toBe(NOW_MS);
    expect(entry?.body).toEqual(body);
  });

  it("a fresh KV-backed entry is honored by freshness()", async () => {
    const kv = new FakeKV();
    const cache = new KVCache(kv);
    await cache.set("k", makeGoAssessment(), NOW_MS);
    const entry = await cache.get("k");
    expect(freshness(entry, NOW_MS + 5 * 60_000)).toBe("fresh");
  });

  it("a stale KV-backed GO is downgraded to CAUTION, never served as GO", async () => {
    const kv = new FakeKV();
    const cache = new KVCache(kv);
    await cache.set("k", makeGoAssessment(), NOW_MS);
    const entry = await cache.get("k");
    expect(freshness(entry, NOW_MS + 700_000)).toBe("stale");
    const staleBody = toStale(entry!.body);
    expect(staleBody.recommendation).toBe("CAUTION");
  });

  it("malformed JSON in KV is treated as a miss, never a decision input", async () => {
    const kv = new FakeKV();
    kv.setRaw("k", "not json{{{");
    const cache = new KVCache(kv);
    expect(await cache.get("k")).toBeUndefined();
  });

  it("well-formed JSON with the wrong shape is treated as a miss", async () => {
    const kv = new FakeKV();
    kv.setRaw("k", JSON.stringify({ recommendation: "GO" })); // missing storedAtMs/body
    const cache = new KVCache(kv);
    expect(await cache.get("k")).toBeUndefined();
  });

  it("a KV get() failure is a miss, not a thrown error", async () => {
    const kv = new FakeKV();
    kv.setFailGet(true);
    const cache = new KVCache(kv);
    expect(await cache.get("k")).toBeUndefined();
  });

  it("a KV put() failure does not throw — the write is swallowed", async () => {
    const kv = new FakeKV();
    kv.setFailPut(true);
    const cache = new KVCache(kv);
    await cache.set("k", makeGoAssessment(), NOW_MS); // must not reject
    expect(await cache.get("k")).toBeUndefined(); // and the write did not happen
  });
});
