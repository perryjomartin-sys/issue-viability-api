/**
 * Step G — x402 V2 payment gate (Base Sepolia testnet only).
 *
 * All local: an offline `FacilitatorClient` stub advertises `exact` on
 * `eip155:84532` so the middleware can build a 402 without touching the network.
 * No mainnet, no real USDC, no deployment.
 */
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { createApp } from "../src/app.ts";
import { buildRoutes, readPaymentConfig } from "../src/payments.ts";
import { checkIfBazaarNeeded } from "@x402/core/server";
import { makeSignals } from "./helpers.ts";

const TODAY = new Date("2026-08-30T12:00:00Z");
const PAY_TO = "0x000000000000000000000000000000000000dEaD";

/** Offline facilitator: advertises exact/eip155:84532 (x402 v2), verifies nothing. */
const stubFacilitator = {
  async getSupported() {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" as const }],
      extensions: [] as string[],
      signers: {} as Record<string, string[]>,
    };
  },
  async verify() {
    return { isValid: false, invalidReason: "stub" };
  },
  async settle() {
    return { success: false, errorReason: "stub" };
  },
} as any;

function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://x/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function enabledApp(overrides: Record<string, string> = {}, signalSource?: () => Promise<any>) {
  let calls = 0;
  const app = createApp(
    { X402_ENABLED: "true", X402_PAY_TO: PAY_TO, X402_RESOURCE_URL: "https://example.com/v1/check", ...overrides },
    {
      now: () => TODAY,
      facilitatorClient: stubFacilitator,
      signalSource:
        signalSource ??
        (async () => {
          calls++;
          return makeSignals();
        }),
    },
  );
  return { app, calls: () => calls };
}

describe("x402 payment gate", () => {
  it("is OFF by default — POST /v1/check works with no payment", async () => {
    let calls = 0;
    const app = createApp({}, { now: () => TODAY, signalSource: async () => { calls++; return makeSignals(); } });
    const res = await post(app, { repo: "cli/cli", issue: 1 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).recommendation).toBe("GO");
    expect(calls).toBe(1);
  });

  it("GET /health reports payments disabled by default", async () => {
    const res = await createApp({}, { now: () => TODAY }).fetch(new Request("http://x/health"));
    expect(((await res.json()) as any).payments).toBe("disabled");
  });

  it("enabled + unpaid POST /v1/check => 402 with payment requirements, GitHub untouched", async () => {
    const { app, calls } = enabledApp();
    const res = await post(app, { repo: "cli/cli", issue: 1 });

    expect(res.status).toBe(402);
    expect(calls()).toBe(0); // unpaid request never reaches the signal source

    const header = res.headers.get("payment-required");
    expect(typeof header).toBe("string");
    const decoded = JSON.parse(Buffer.from(header as string, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].scheme).toBe("exact");
    expect(decoded.accepts[0].network).toBe("eip155:84532");
    expect(decoded.accepts[0].payTo).toBe(PAY_TO);
    // $0.005 USDC (6 decimals) == "5000"
    expect(decoded.accepts[0].amount).toBe("5000");

    const body = (await res.json()) as any;
    expect(body.error).toBe("payment_required");
    expect(body.network).toBe("eip155:84532");
  });

  it("enabled: GET /health and GET / are not gated", async () => {
    const { app } = enabledApp();
    const health = await app.fetch(new Request("http://x/health"));
    expect(health.status).toBe(200);
    expect(((await health.json()) as any).payments).toBe("x402:eip155:84532");
    const root = await app.fetch(new Request("http://x/"));
    expect(root.status).toBe(200);
  });

  it("enabled without a valid X402_PAY_TO => createApp throws", () => {
    expect(() => createApp({ X402_ENABLED: "true", X402_PAY_TO: "not-an-address" })).toThrow();
    expect(() => createApp({ X402_ENABLED: "true" })).toThrow();
  });

  it("X402_BAZAAR=false drops the discovery extension but still gates the route", async () => {
    const cfgOn = readPaymentConfig({ X402_ENABLED: "true", X402_PAY_TO: PAY_TO });
    const cfgOff = readPaymentConfig({ X402_ENABLED: "true", X402_PAY_TO: PAY_TO, X402_BAZAAR: "false" });
    expect(checkIfBazaarNeeded(buildRoutes(cfgOn))).toBe(true);
    expect(checkIfBazaarNeeded(buildRoutes(cfgOff))).toBe(false);

    const { app } = enabledApp({ X402_BAZAAR: "false" });
    const res = await post(app, { repo: "cli/cli", issue: 1 });
    expect(res.status).toBe(402);
  });

  it("buildRoutes: Base Sepolia only, $0.005, payTo echoed", () => {
    const cfg = readPaymentConfig({ X402_ENABLED: "true", X402_PAY_TO: PAY_TO, X402_PRICE: "$0.005" });
    const routes = buildRoutes(cfg) as Record<string, any>;
    const accepts = routes["POST /v1/check"].accepts;
    expect(accepts.network).toBe("eip155:84532");
    expect(accepts.price).toBe("$0.005");
    expect(accepts.payTo).toBe(PAY_TO);
    expect(accepts.scheme).toBe("exact");
  });
});
