/**
 * Paid-request accounting / retry-safety / idempotency audit (see the
 * accompanying report for the full analysis). This file adds proof only for
 * claims the existing suite did not already establish precisely:
 *
 *  - a cache HIT still requires payment (settlement still happens) but never
 *    touches RATE_BUDGET or GitHub — `test/payments-observability.test.ts`
 *    proved the cache-miss lifecycle in full; this proves the cache-hit one;
 *  - the same valid-looking payment authorization reused across two DIFFERENT
 *    logical requests is stopped by facilitator-side nonce rejection (the
 *    application layer has no dedup of its own — none is needed, verify()
 *    is the control point, and this proves the second GitHub call never
 *    happens even though the cache key differs so caching can't be what
 *    stopped it);
 *  - settlement failing AFTER the handler already ran does NOT roll back the
 *    RATE_BUDGET reservation or the cache write — the known, inherent
 *    trade-off of the exact-EVM "authorization" flow (verify-then-settle),
 *    proved here directly against budget/cache state rather than inferred;
 *  - a cached viability entry never carries any payment/authorization field,
 *    however the entry got there.
 *
 * No production code changed as a result of this audit — see the report for
 * why (EIP-3009 on-chain nonce enforcement makes a single authorization
 * settle at most once; VIABILITY_CACHE already dedupes repeat GitHub work for
 * the same repo/issue/day; accounting is already answerable from the
 * structured logs added previously; receipt semantics are already correct —
 * the SDK only lets a 200 reach the client after settlement has actually
 * succeeded).
 */
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { createApp } from "../src/app.ts";
import { assess } from "../src/decision.ts";
import { makeSignals } from "./helpers.ts";
import { MemoryRateBudget } from "../src/rate-budget.ts";
import { MemoryCache } from "../src/cache.ts";

const TODAY = new Date("2026-08-30T12:00:00Z");
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const FAKE_SIGNATURE = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function readyBudget() {
  return new MemoryRateBudget({ remaining: 5_000, resetAtMs: 4_102_444_800_000, cost: 1 });
}

function stubFacilitator(overrides: { verify?: any; settle?: any } = {}) {
  return {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" as const }],
        extensions: [] as string[],
        signers: {} as Record<string, string[]>,
      };
    },
    verify: overrides.verify ?? (async () => ({ isValid: true })),
    settle:
      overrides.settle ??
      (async () => ({ success: true, transaction: "0xsettled", network: "eip155:84532" })),
  } as any;
}

function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://x/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function harness(facilitator?: any) {
  let githubCalls = 0;
  const budget = readyBudget();
  const cache = new MemoryCache();
  const app = createApp(
    { X402_ENABLED: "true", X402_PAY_TO: PAY_TO, X402_RESOURCE_URL: "https://example.com/v1/check" },
    {
      now: () => TODAY,
      facilitatorClient: facilitator ?? stubFacilitator(),
      rateBudget: budget,
      cache,
      signalSource: async () => {
        githubCalls++;
        return makeSignals();
      },
    },
  );
  return { app, budget, cache, githubCalls: () => githubCalls };
}

async function baseRequirement(app: ReturnType<typeof createApp>) {
  const res = await post(app, { repo: "cli/cli", issue: 14297 });
  const header = res.headers.get("payment-required")!;
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  return decoded.accepts[0];
}

function v2Header(accepted: unknown) {
  const payload = { signature: FAKE_SIGNATURE, authorization: { from: "0xpayer", to: PAY_TO, value: "5000", nonce: "0xnonce1" } };
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload }), "utf8").toString("base64");
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const raw: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    raw.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return raw;
}

function eventsOf(raw: string[]): any[] {
  return raw
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((e) => e && e.scope === "x402");
}

describe("x402 paid-request accounting", () => {
  it("verified payment + fresh cache hit: settlement still happens, RATE_BUDGET and GitHub are never touched", async () => {
    const h = harness();
    // Warm the cache directly — no payment involved in seeding it, exactly as
    // a prior *paid* request would have left it (CacheEntry only ever holds
    // an Assessment body, never payment data — see the cache-shape test below).
    await h.cache.set("v1:cli/cli:14297:2026-08-30", assess(makeSignals(), TODAY), TODAY.getTime());
    const before = h.budget.snapshot();

    const real = await baseRequirement(harness().app);
    const raw = await captureLogs(async () => {
      const res = await post(h.app, { repo: "cli/cli", issue: 14297 }, { "payment-signature": v2Header(real) });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-cache")).toBe("fresh");
    });

    expect(h.githubCalls()).toBe(0); // cache hit — GitHub was never called
    const after = h.budget.snapshot();
    expect(after.authoritative?.remaining).toBe(before.authoritative?.remaining);
    expect(after.reservations.length).toBe(0); // RATE_BUDGET never reserved

    const names = eventsOf(raw).map((e) => e.event);
    expect(names).toContain("facilitator_settlement_attempted"); // payment still required
    expect(names).toContain("settlement_succeeded");
    expect(names).toContain("protected_handler_entered"); // handler DID run...
    expect(names.includes("rate_budget_reservation")).toBe(false); // ...but short-circuited before reserving
    expect(names.includes("github_assessment_started")).toBe(false);
  });

  it("the same authorization reused for a different (cache-miss) request is stopped by facilitator verify() rejection, not by caching", async () => {
    let verifyCalls = 0;
    const facilitator = stubFacilitator({
      verify: async () => {
        verifyCalls++;
        // A correct facilitator rejects a nonce it has already settled —
        // this is the actual control point; the Worker adds no dedup of its own.
        return verifyCalls === 1 ? { isValid: true } : { isValid: false, invalidReason: "nonce_already_used" };
      },
    });
    const h = harness(facilitator);
    const real = await baseRequirement(harness(facilitator).app);
    const reusedHeader = v2Header(real); // identical payload both times

    const first = await post(h.app, { repo: "cli/cli", issue: 14297 }, { "payment-signature": reusedHeader });
    expect(first.status).toBe(200);
    expect(h.githubCalls()).toBe(1);

    // A DIFFERENT logical request (different repo/issue => guaranteed cache
    // miss) reusing the SAME authorization. If anything let it through, this
    // would show up as a second GitHub call.
    const second = await post(h.app, { repo: "octocat/hello-world", issue: 1 }, { "payment-signature": reusedHeader });
    expect(second.status).not.toBe(200);
    const body = (await second.json()) as any;
    expect(body.recommendation).toBeUndefined();
    expect(h.githubCalls()).toBe(1); // still 1 — the reused authorization never reached the handler again
  });

  it("settlement failing AFTER the handler ran does not roll back RATE_BUDGET or the cache write (known authorization-flow trade-off, proved directly)", async () => {
    const facilitator = stubFacilitator({
      settle: async () => ({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" }),
    });
    const h = harness(facilitator);
    const before = h.budget.snapshot();
    const real = await baseRequirement(harness(facilitator).app);

    const res = await post(h.app, { repo: "cli/cli", issue: 14297 }, { "payment-signature": v2Header(real) });
    expect(res.status).not.toBe(200); // the client is denied the result...
    expect(h.githubCalls()).toBe(1); // ...but GitHub was already called...

    const cached = await h.cache.get("v1:cli/cli:14297:2026-08-30");
    expect(cached).not.toBe(undefined); // ...and the cache WAS written...
    expect((cached as any).body.recommendation).toBe("GO");

    const after = h.budget.snapshot();
    expect(after.reservations.length).toBe(0); // ...and the RATE_BUDGET debit was reconciled (not left dangling)
    expect(after.authoritative?.remaining).toBe((before.authoritative?.remaining ?? 0) - 1); // ...and genuinely spent, not refunded
  });

  it("a cached viability entry never carries any payment/authorization field, regardless of how it was populated", async () => {
    const h = harness();
    const real = await baseRequirement(harness().app);
    const res = await post(h.app, { repo: "cli/cli", issue: 14297 }, { "payment-signature": v2Header(real) });
    expect(res.status).toBe(200);

    const cached = await h.cache.get("v1:cli/cli:14297:2026-08-30");
    const expected = assess(makeSignals(), TODAY);
    // Exactly the Assessment shape produced by the pure decision engine — no
    // "payment", "signature", "nonce", "payer", or any other x402 field ever
    // rides along, however the cache entry was populated.
    expect((cached as any).body).toEqual(expected);
    const entryKeys = Object.keys(cached as any).sort();
    expect(entryKeys).toEqual(["body", "storedAtMs"]);
  });
});
