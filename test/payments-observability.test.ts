/**
 * x402 payment-lifecycle observability.
 *
 * Audit finding (see the accompanying report): before this change, the only
 * production logging anywhere near the x402 path was ad hoc `console.error`
 * calls in the KV cache and rate-budget Durable Object failure branches —
 * nothing distinguished "no payment supplied" from "malformed payment" from
 * "facilitator rejected it", nothing marked when the protected handler was
 * entered, and settlement outcomes were invisible. This file proves the fix
 * (structured `console.log` lines from `src/payments.ts` / `src/app.ts`,
 * wired through the `@x402/core` resource-server hooks and a thin
 * observe-only wrapper around `POST /v1/check`) without altering behaviour:
 * every test below still asserts the same status/body/side-effect contract
 * as `test/payments.test.ts` and `test/payments-hardening.test.ts`, plus new
 * assertions on which log events fired and that none of them leak payment
 * material.
 */
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { createApp } from "../src/app.ts";
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
    verify: overrides.verify ?? (async () => ({ isValid: false, invalidReason: "stub-reject" })),
    settle:
      overrides.settle ??
      (async () => ({ success: false, errorReason: "stub-settle-reject", transaction: "", network: "eip155:84532" })),
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

/** Captures every `console.log` call made during `fn`, parsed as JSON where
 *  possible (our structured lines) alongside the raw string (for the
 *  no-leak assertion, which must see anything logged, parseable or not). */
async function captureLogs(fn: () => Promise<void>): Promise<{ raw: string[]; events: any[] }> {
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
  const events = raw
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((e) => e && e.scope === "x402");
  return { raw, events };
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
  const payload = { signature: FAKE_SIGNATURE, authorization: { from: "0xpayer", to: PAY_TO, value: "5000" } };
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload }), "utf8").toString("base64");
}

function eventNames(events: any[]): string[] {
  return events.map((e) => e.event);
}

/** No captured log line — structured or not — may contain the fake secret
 *  material this test suite uses to stand in for a real signature/payload. */
function assertNoPaymentMaterialLeaked(raw: string[]) {
  for (const line of raw) {
    expect(line).not.toContain(FAKE_SIGNATURE);
    expect(line).not.toContain("0xpayer");
    expect(line).not.toContain("authorization");
  }
}

describe("x402 payment observability", () => {
  it("unpaid request: still 402, logs request_received + request_completed(402), no verify/settle hooks fire", async () => {
    const h = harness();
    const { raw, events } = await captureLogs(async () => {
      const res = await post(h.app, { repo: "cli/cli", issue: 14297 });
      expect(res.status).toBe(402);
    });
    const names = eventNames(events);
    expect(names).toContain("request_received");
    expect(names).toContain("request_completed");
    const completed = events.find((e) => e.event === "request_completed");
    expect(completed.status).toBe(402);
    expect(names.includes("facilitator_verification_attempted")).toBe(false);
    assertNoPaymentMaterialLeaked(raw);
  });

  it("malformed payment header: still rejected, logs malformed_payment distinctly", async () => {
    const h = harness();
    const { raw, events } = await captureLogs(async () => {
      const res = await post(h.app, { repo: "cli/cli", issue: 14297 }, { "payment-signature": "not-base64!!!" });
      expect(res.status).not.toBe(200);
    });
    const names = eventNames(events);
    expect(names).toContain("malformed_payment");
    const received = events.find((e) => e.event === "request_received");
    expect(received.paymentHeader).toBe("malformed");
    assertNoPaymentMaterialLeaked(raw);
  });

  it("verified payment: still reaches the handler (200 + recommendation), full lifecycle logged, settlement succeeds", async () => {
    const facilitator = stubFacilitator({
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: "0xsettled", network: "eip155:84532" }),
    });
    const h = harness(facilitator);
    const real = await baseRequirement(harness(facilitator).app); // separate instance just for the requirement shape
    const { raw, events } = await captureLogs(async () => {
      const res = await post(
        h.app,
        { repo: "cli/cli", issue: 14297 },
        { "payment-signature": v2Header(real) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.recommendation).toBe("GO");
    });
    expect(h.githubCalls()).toBe(1);
    const names = eventNames(events);
    for (const expected of [
      "request_received",
      "facilitator_verification_attempted",
      "payment_verified",
      "protected_handler_entered",
      "rate_budget_reservation",
      "github_assessment_started",
      "assessment_completed",
      "facilitator_settlement_attempted",
      "settlement_succeeded",
      "request_completed",
    ]) {
      expect(names).toContain(expected);
    }
    assertNoPaymentMaterialLeaked(raw);
  });

  it("verification failure: fails closed (no handler, no recommendation), logs payment_rejected — never payment_verified", async () => {
    const h = harness(); // default stub: verify() -> isValid:false
    const real = await baseRequirement(harness().app);
    const { raw, events } = await captureLogs(async () => {
      const res = await post(
        h.app,
        { repo: "cli/cli", issue: 14297 },
        { "payment-signature": v2Header(real) },
      );
      expect(res.status).not.toBe(200);
      const body = (await res.json()) as any;
      expect(body.recommendation).toBeUndefined();
    });
    expect(h.githubCalls()).toBe(0);
    const names = eventNames(events);
    expect(names).toContain("payment_rejected");
    expect(names.includes("payment_verified")).toBe(false);
    expect(names.includes("protected_handler_entered")).toBe(false);
    assertNoPaymentMaterialLeaked(raw);
  });

  it("facilitator.verify() throws: fails closed, logs verification_errored (not payment_verified)", async () => {
    const facilitator = stubFacilitator({
      verify: async () => {
        throw new Error("facilitator unreachable");
      },
    });
    const h = harness(facilitator);
    const real = await baseRequirement(harness(facilitator).app);
    const { raw, events } = await captureLogs(async () => {
      const res = await post(
        h.app,
        { repo: "cli/cli", issue: 14297 },
        { "payment-signature": v2Header(real) },
      );
      expect(res.status).not.toBe(200);
    });
    expect(h.githubCalls()).toBe(0);
    const names = eventNames(events);
    expect(names).toContain("verification_errored");
    expect(names.includes("payment_verified")).toBe(false);
    assertNoPaymentMaterialLeaked(raw);
  });

  it("settlement failure: verified payment still fails closed to the client, logs settlement_failed", async () => {
    const facilitator = stubFacilitator({
      verify: async () => ({ isValid: true }),
      settle: async () => ({
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: "eip155:84532",
      }),
    });
    const h = harness(facilitator);
    const real = await baseRequirement(harness(facilitator).app);
    const { raw, events } = await captureLogs(async () => {
      const res = await post(
        h.app,
        { repo: "cli/cli", issue: 14297 },
        { "payment-signature": v2Header(real) },
      );
      // The client must never receive the paid result once settlement fails.
      expect(res.status).not.toBe(200);
    });
    const names = eventNames(events);
    expect(names).toContain("settlement_failed");
    expect(names.includes("settlement_succeeded")).toBe(false);
    // The handler DID run (this is the documented settle-after-handler
    // trade-off of the exact-EVM "authorization" flow — see the hardening
    // report) — assessment_completed still fires even though the client
    // response is denied.
    expect(names).toContain("assessment_completed");
    assertNoPaymentMaterialLeaked(raw);
  });

  it("GET / and GET /health remain unaffected and unlogged by x402 observability", async () => {
    const h = harness();
    const { events } = await captureLogs(async () => {
      const root = await h.app.fetch(new Request("http://x/"));
      expect(root.status).toBe(200);
      const health = await h.app.fetch(new Request("http://x/health"));
      expect(health.status).toBe(200);
      expect(((await health.json()) as any).payments).toBe("x402:eip155:84532");
    });
    expect(events.length).toBe(0);
  });
});
