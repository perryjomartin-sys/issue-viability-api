/**
 * x402 boundary hardening (Base Sepolia testnet only, no real funds).
 *
 * The existing `test/payments.test.ts` "malformed X-PAYMENT" / "invalid
 * X-PAYMENT" cases send their payload under the header name `x-payment`,
 * which is the x402 **v1** header. This server's `extractPayment` (via
 * `@x402/core`) only reads `PAYMENT-SIGNATURE` for v2 (the version this repo
 * advertises everywhere else: `x402Version: 2`). Sending `x-payment` is
 * therefore indistinguishable from sending *no* payment header at all — those
 * two existing tests exercise the "no payment supplied" path, not the
 * "payment supplied but rejected" path.
 *
 * This file drives payloads through the header the server actually reads
 * (`payment-signature`) so the facilitator `verify()` / structural-match code
 * is genuinely exercised, and adds explicit proof (per repo instructions)
 * that a rejected request never touches RATE_BUDGET or VIABILITY_CACHE and
 * never returns a recommendation.
 */
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { createApp } from "../src/app.ts";
import { makeSignals } from "./helpers.ts";
import { MemoryRateBudget } from "../src/rate-budget.ts";
import { MemoryCache } from "../src/cache.ts";

const TODAY = new Date("2026-08-30T12:00:00Z");
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const CACHE_KEY = "v1:cli/cli:14297:2026-08-30";

function readyBudget() {
  return new MemoryRateBudget({ remaining: 5_000, resetAtMs: 4_102_444_800_000, cost: 1 });
}

/** Offline facilitator stub. Defaults reject everything (no real network). */
function stubFacilitator(overrides: { verify?: any; settle?: any } = {}) {
  return {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" as const }],
        extensions: [] as string[],
        signers: {} as Record<string, string[]>,
      };
    },
    verify: overrides.verify ?? (async () => ({ isValid: false, invalidReason: "stub-reject" })),
    settle: overrides.settle ?? (async () => ({ success: false, errorReason: "stub-settle-reject" })),
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

/** Pull the server's own echoed payment requirement off a real 402 response,
 *  so "wrong network" / "wrong amount" tests mutate a genuinely correct base
 *  rather than a hand-guessed shape that could drift from the SDK. */
async function baseRequirement(app: ReturnType<typeof createApp>) {
  const res = await post(app, { repo: "cli/cli", issue: 14297 });
  const header = res.headers.get("payment-required")!;
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  return decoded.accepts[0];
}

function v2Header(accepted: unknown, payload: unknown = { signature: "0xdeadbeef", authorization: {} }) {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload }), "utf8").toString("base64");
}

/** Common assertions for every rejection case: 402/4xx or 5xx (never 200),
 *  no recommendation, GitHub never called, budget untouched, cache untouched. */
async function assertRejectedCleanly(
  res: Response,
  h: ReturnType<typeof harness>,
  budgetBefore: ReturnType<MemoryRateBudget["snapshot"]>,
) {
  expect(res.status).not.toBe(200);
  const body = (await res.json().catch(() => ({}))) as any;
  expect(body.recommendation).toBeUndefined();
  expect(h.githubCalls()).toBe(0);
  expect(await h.cache.get(CACHE_KEY)).toBeUndefined();
  const budgetAfter = h.budget.snapshot();
  expect(budgetAfter.authoritative?.remaining).toBe(budgetBefore.authoritative?.remaining);
  expect(budgetAfter.reservations.length).toBe(0);
}

describe("x402 boundary hardening", () => {
  it("a hung facilitator /supported call cannot delay an unpaid 402 or touch protected resources", async () => {
    let getSupportedCalls = 0;
    let verifyCalls = 0;
    let settleCalls = 0;
    let cacheGets = 0;
    let cacheSets = 0;
    let githubCalls = 0;
    let budgetCalls = 0;
    const backingBudget = readyBudget();
    const cache = {
      async get() {
        cacheGets++;
        return undefined;
      },
      async set() {
        cacheSets++;
      },
    };
    const budget = {
      async reserveLiveCall(nowMs: number) {
        budgetCalls++;
        return backingBudget.reserveLiveCall(nowMs);
      },
      async reconcile(...args: Parameters<MemoryRateBudget["reconcile"]>) {
        budgetCalls++;
        return backingBudget.reconcile(...args);
      },
      async recover(...args: Parameters<MemoryRateBudget["recover"]>) {
        budgetCalls++;
        return backingBudget.recover(...args);
      },
    };
    const facilitator = {
      getSupported() {
        getSupportedCalls++;
        return new Promise<never>(() => {}); // deterministic hung /supported
      },
      async verify() {
        verifyCalls++;
        return { isValid: false, invalidReason: "unreachable" };
      },
      async settle() {
        settleCalls++;
        return { success: false, errorReason: "unreachable" };
      },
    } as any;
    const app = createApp(
      { X402_ENABLED: "true", X402_PAY_TO: PAY_TO, X402_RESOURCE_URL: "https://example.com/v1/check" },
      {
        now: () => TODAY,
        facilitatorClient: facilitator,
        rateBudget: budget,
        cache,
        signalSource: async () => {
          githubCalls++;
          return makeSignals();
        },
      },
    );
    const budgetBefore = backingBudget.snapshot();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const responseOrTimeout = await Promise.race([
      post(app, { repo: "cli/cli", issue: 14297 }),
      new Promise<"timed_out">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timed_out"), 100);
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    expect(responseOrTimeout).not.toBe("timed_out");
    const res = responseOrTimeout as Response;
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.network).toBe("eip155:84532");
    expect(body.price).toBe("$0.005");
    expect(body.recommendation).toBeUndefined();
    expect(getSupportedCalls).toBe(0);
    expect(verifyCalls).toBe(0);
    expect(settleCalls).toBe(0);
    expect(githubCalls).toBe(0);
    expect(cacheGets).toBe(0);
    expect(cacheSets).toBe(0);
    expect(budgetCalls).toBe(0);
    expect(backingBudget.snapshot()).toEqual(budgetBefore);
  });

  it("no payment header => 402, budget and cache untouched", async () => {
    const h = harness();
    const before = h.budget.snapshot();
    const res = await post(h.app, { repo: "cli/cli", issue: 14297 });
    expect(res.status).toBe(402);
    await assertRejectedCleanly(res, h, before);
  });

  it("empty payment-signature header => rejected, not treated as valid", async () => {
    const h = harness();
    const before = h.budget.snapshot();
    const res = await post(h.app, { repo: "cli/cli", issue: 14297 }, { "payment-signature": "" });
    await assertRejectedCleanly(res, h, before);
  });

  it("malformed base64 under the correct v2 header (payment-signature) => rejected", async () => {
    const h = harness();
    const before = h.budget.snapshot();
    const res = await post(
      h.app,
      { repo: "cli/cli", issue: 14297 },
      { "payment-signature": "not-base64-json!!!" },
    );
    await assertRejectedCleanly(res, h, before);
  });

  it("valid base64 but structurally invalid JSON payload => rejected", async () => {
    const h = harness();
    const before = h.budget.snapshot();
    const garbage = Buffer.from("this is not json", "utf8").toString("base64");
    const res = await post(h.app, { repo: "cli/cli", issue: 14297 }, { "payment-signature": garbage });
    await assertRejectedCleanly(res, h, before);
  });

  it("well-formed v2 payload, wrong network => no matching requirement, rejected", async () => {
    const h = harness();
    const before = h.budget.snapshot();
    const real = await baseRequirement(h.app);
    const wrongNetwork = { ...real, network: "eip155:8453" }; // Base MAINNET, not Sepolia
    const res = await post(
      h.app,
      { repo: "cli/cli", issue: 14297 },
      { "payment-signature": v2Header(wrongNetwork) },
    );
    await assertRejectedCleanly(res, h, before);
  });

  it("well-formed v2 payload, wrong amount => no matching requirement, rejected", async () => {
    const h = harness();
    const before = h.budget.snapshot();
    const real = await baseRequirement(h.app);
    const wrongAmount = { ...real, amount: "1" }; // claims to pay far less than $0.005
    const res = await post(
      h.app,
      { repo: "cli/cli", issue: 14297 },
      { "payment-signature": v2Header(wrongAmount) },
    );
    await assertRejectedCleanly(res, h, before);
  });

  it("structurally valid payload matching real requirements, facilitator.verify() rejects it => rejected", async () => {
    const h = harness(); // default stub: verify() -> isValid:false
    const before = h.budget.snapshot();
    const real = await baseRequirement(h.app);
    const res = await post(
      h.app,
      { repo: "cli/cli", issue: 14297 },
      { "payment-signature": v2Header(real) },
    );
    await assertRejectedCleanly(res, h, before);
  });

  it("facilitator.verify() throws (network/internal error) => fails closed, never reaches the handler", async () => {
    const throwingFacilitator = stubFacilitator({
      verify: async () => {
        throw new Error("facilitator unreachable");
      },
    });
    const h = harness(throwingFacilitator);
    const before = h.budget.snapshot();
    const real = await baseRequirement(harness(throwingFacilitator).app); // separate app instance just to fetch a real requirement shape
    const res = await post(
      h.app,
      { repo: "cli/cli", issue: 14297 },
      { "payment-signature": v2Header(real) },
    );
    // A thrown verify() must never become a 200 with a recommendation.
    await assertRejectedCleanly(res, h, before);
  });

  it("GET / and GET /health remain unaffected by any of the above rejection paths", async () => {
    const h = harness();
    await post(h.app, { repo: "cli/cli", issue: 14297 }, { "payment-signature": "garbage" });
    const root = await h.app.fetch(new Request("http://x/"));
    expect(root.status).toBe(200);
    const health = await h.app.fetch(new Request("http://x/health"));
    expect(health.status).toBe(200);
    expect(((await health.json()) as any).payments).toBe("x402:eip155:84532");
  });
});
