/**
 * x402 V2 payment gate for `POST /v1/check`.
 *
 * Base Sepolia is the default. Base mainnet is an explicitly approved, separate
 * deployment configuration only; no other network, asset, facilitator, or
 * price combination is accepted.
 *
 * The middleware fetches the facilitator's supported payment kinds on first use
 * (`syncFacilitatorOnStart` default), so a live unpaid request needs one call to
 * the facilitator `/supported` endpoint; verify/settle are called only on a paid
 * request. Tests inject a local `FacilitatorClient` stub to stay offline.
 *
 * This is an agent-first API: the optional `@x402/paywall` browser wallet UI is
 * deliberately NOT installed. Non-browser clients get a JSON 402; a browser hit
 * falls back to the middleware's built-in plain-HTML payment-instructions page.
 *
 * Uses the current x402 V2 packages: `@x402/hono`, `@x402/core`, `@x402/evm`,
 * `@x402/extensions` (Bazaar discovery).
 */
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { Context, Hono } from "hono";

/** The ONLY network this build will price on (CAIP-2 for Base Sepolia). */
export const BASE_SEPOLIA = "eip155:84532" as const;
export const BASE_MAINNET = "eip155:8453" as const;
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const X402_ORG_FACILITATOR = "https://x402.org/facilitator" as const;
export const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402" as const;
export const X402_PRICE = "$0.005" as const;

export type SupportedNetwork = typeof BASE_SEPOLIA | typeof BASE_MAINNET;

export const NETWORK_CONFIG: Record<SupportedNetwork, { asset: string; facilitatorUrl: string; mainnet: boolean }> = {
  [BASE_SEPOLIA]: { asset: BASE_SEPOLIA_USDC, facilitatorUrl: X402_ORG_FACILITATOR, mainnet: false },
  [BASE_MAINNET]: { asset: BASE_MAINNET_USDC, facilitatorUrl: CDP_FACILITATOR, mainnet: true },
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const truthy = (v: string | undefined): boolean => v === "true" || v === "1" || v === "yes";

/**
 * Structured, secrets-free logging for the x402 payment lifecycle. Plain
 * `console.log` is deliberate: Cloudflare Workers ships every `console.*` call
 * to the dashboard log stream / `wrangler tail` / Logpush with no extra
 * wiring, so this needs no new dependency and sends nothing to a new third
 * party. NEVER pass a header value, signature, or authorization payload here —
 * only short enum/boolean/id fields.
 */
export function logX402(event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  console.log(JSON.stringify({ scope: "x402", event, ...fields }));
}

/**
 * Correlation id for tying one request's log lines together: Cloudflare's own
 * per-request edge id (`cf-ray`), already present on every response this
 * Worker sends (see production `curl` smoke tests) and safe to log verbatim —
 * it identifies a request, not a person or a secret. Falls back to "local"
 * outside Cloudflare (dev / tests), where cross-log correlation isn't needed.
 */
export function requestCorrelationId(getHeader: (name: string) => string | undefined): string {
  return getHeader("cf-ray") ?? "local";
}

/** Same correlation id, recovered from an `@x402/core` hook's `transportContext`
 *  (typed `unknown` by the SDK). Defensive optional-chaining only — never throws. */
function correlationIdFromTransport(transportContext: unknown): string {
  const request = (
    transportContext as { request?: { adapter?: { getHeader?: (name: string) => string | undefined } } } | undefined
  )?.request;
  return requestCorrelationId((name) => request?.adapter?.getHeader?.(name));
}

/**
 * Classify the raw `payment-signature` header for logging ONLY — mirrors the
 * SDK's own base64-then-JSON decode (`@x402/core`'s `safeBase64Decode`) but
 * discards the decoded value immediately; the header's actual content is
 * never logged, only whether it was absent, present-but-unparseable
 * ("malformed"), or parseable JSON.
 */
function classifyPaymentHeader(raw: string | undefined): "absent" | "malformed" | "parseable" {
  if (!raw) return "absent";
  try {
    const binary = globalThis.atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    JSON.parse(new TextDecoder().decode(bytes));
    return "parseable";
  } catch {
    return "malformed";
  }
}

export interface PaymentConfig {
  enabled: boolean;
  network: SupportedNetwork;
  /** Native USDC contract for the selected Base network. */
  asset: string;
  /** EVM address that receives USDC. Required when enabled. */
  payTo: string;
  facilitatorUrl: string;
  price: string;
  mainnetApproved: boolean;
  /** Runtime-only CDP secrets. Never expose or log these. */
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  /** Public URL of this resource, for discovery metadata. */
  resourceUrl?: string;
  /** Emit the x402 Bazaar discovery extension on the route (default on). */
  bazaar: boolean;
}

export function readPaymentConfig(env: Record<string, string | undefined>): PaymentConfig {
  const selectedNetwork = (env.X402_NETWORK ?? BASE_SEPOLIA).trim();
  if (selectedNetwork !== BASE_SEPOLIA && selectedNetwork !== BASE_MAINNET) {
    throw new Error("x402 network is not an approved Base network");
  }
  const network = selectedNetwork as SupportedNetwork;
  const expected = NETWORK_CONFIG[network];
  const cfg: PaymentConfig = {
    enabled: truthy(env.X402_ENABLED),
    network,
    asset: (env.X402_ASSET ?? expected.asset).trim(),
    payTo: (env.X402_PAY_TO ?? "").trim(),
    facilitatorUrl: (env.X402_FACILITATOR_URL ?? expected.facilitatorUrl).trim(),
    price: (env.X402_PRICE ?? X402_PRICE).trim(),
    mainnetApproved: env.X402_MAINNET_APPROVED === "true",
    cdpApiKeyId: env.CDP_API_KEY_ID,
    cdpApiKeySecret: env.CDP_API_KEY_SECRET,
    resourceUrl: env.X402_RESOURCE_URL?.trim() || undefined,
    bazaar: env.X402_BAZAAR === undefined ? true : truthy(env.X402_BAZAAR),
  };
  validatePaymentConfig(cfg);
  return cfg;
}

/** Fail closed before any request can use an incoherent payment configuration. */
export function validatePaymentConfig(cfg: PaymentConfig): void {
  const expected = NETWORK_CONFIG[cfg.network];
  if (!expected || cfg.asset !== expected.asset || cfg.facilitatorUrl !== expected.facilitatorUrl || cfg.price !== X402_PRICE) {
    throw new Error("x402 configuration does not match an approved network profile");
  }
  if (expected.mainnet) {
    if (!cfg.mainnetApproved) throw new Error("Base mainnet requires explicit runtime approval");
    if (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret) throw new Error("Base mainnet CDP facilitator credentials are required");
  }
}

/** True once the config is enabled and internally consistent. */
export function paymentGateActive(cfg: PaymentConfig): boolean {
  return cfg.enabled && EVM_ADDRESS.test(cfg.payTo);
}

/**
 * x402 Bazaar discovery extension for the POST /v1/check body endpoint (G5).
 * The HTTP method is filled in from the route pattern during enrichment, so it
 * is not passed here.
 */
function discoveryExtensions(): Record<string, unknown> {
  return declareDiscoveryExtension({
    bodyType: "json",
    input: { repo: "owner/name", issue: 123 },
    inputSchema: {
      properties: {
        repo: { type: "string", description: 'GitHub repository as "owner/name"' },
        issue: { type: "integer", minimum: 1, description: "Issue number" },
      },
      required: ["repo", "issue"],
    },
    output: {
      example: {
        issue_state: "open",
        recommendation: "GO",
        risk: "low",
        reasons: ["issue is open, unassigned, has no competing PRs, and the repository is active"],
        data_quality: "ok",
      },
    },
  }) as unknown as Record<string, unknown>;
}

/**
 * Build the x402 route config for `POST /v1/check`. Exported for tests and for
 * discovery tooling (`checkIfBazaarNeeded`).
 */
export function buildRoutes(cfg: PaymentConfig): RoutesConfig {
  return {
    "POST /v1/check": {
      accepts: {
        scheme: "exact",
        network: cfg.network,
        payTo: cfg.payTo,
        // Pin the native USDC contract instead of relying solely on the SDK's
        // default-asset table. This makes asset drift a startup failure.
        price: { amount: "5000", asset: cfg.asset },
        maxTimeoutSeconds: 60,
      },
      description:
        "One assessment of whether a public GitHub issue is still rational to work on (GO / CAUTION / REJECT).",
      mimeType: "application/json",
      serviceName: "Issue Viability API",
      tags: ["github", "issues", "coding-agents", "developer-tools"],
      ...(cfg.resourceUrl ? { resource: cfg.resourceUrl } : {}),
      ...(cfg.bazaar ? { extensions: discoveryExtensions() } : {}),
      // API clients (non-browser) that hit the route unpaid get this body with
      // the 402, alongside the standard x402 payment-requirements headers.
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          error: "payment_required",
          detail: "POST /v1/check requires an x402 payment.",
          price: cfg.price,
          network: cfg.network,
        },
      }),
    },
  };
}

/**
 * Register x402 lifecycle observability on `resourceServer` via its public
 * hook API (`onBeforeVerify` / `onAfterVerify` / `onVerifyFailure` /
 * `onBeforeSettle` / `onAfterSettle` / `onSettleFailure`). These are the
 * SDK's own designed-for-this extension points: every hook here only logs and
 * returns nothing, so none of them can change verification/settlement outcome
 * (an `abort` / `skip` / `recovered` directive would; these never return one).
 */
function installPaymentObservability(resourceServer: x402ResourceServer): void {
  resourceServer
    .onBeforeVerify(async (ctx) => {
      logX402("facilitator_verification_attempted", {
        correlationId: correlationIdFromTransport(ctx.transportContext),
        network: ctx.requirements.network,
        scheme: ctx.requirements.scheme,
      });
    })
    .onAfterVerify(async (ctx) => {
      logX402(ctx.result.isValid ? "payment_verified" : "payment_rejected", {
        correlationId: correlationIdFromTransport(ctx.transportContext),
        reason: ctx.result.isValid ? undefined : String(ctx.result.invalidReason ?? "unspecified"),
      });
    })
    .onVerifyFailure(async (ctx) => {
      logX402("verification_errored", {
        correlationId: correlationIdFromTransport(ctx.transportContext),
        error: ctx.error.message,
      });
    })
    .onBeforeSettle(async (ctx) => {
      logX402("facilitator_settlement_attempted", {
        correlationId: correlationIdFromTransport(ctx.transportContext),
      });
    })
    .onAfterSettle(async (ctx) => {
      logX402("settlement_succeeded", {
        correlationId: correlationIdFromTransport(ctx.transportContext),
      });
    })
    .onSettleFailure(async (ctx) => {
      logX402("settlement_failed", {
        correlationId: correlationIdFromTransport(ctx.transportContext),
        error: ctx.error.message,
      });
    });
}

/**
 * Install the payment gate on `app`. No-op when disabled. Call before the route
 * handlers so the middleware runs first.
 *
 * @param facilitatorClient  optional injected client (tests); defaults to an
 *                            `HTTPFacilitatorClient` pointed at `cfg.facilitatorUrl`.
 * @throws if `X402_ENABLED` is set but `X402_PAY_TO` is not a valid 0x address.
 */
export function installPaymentGate(
  app: Hono,
  cfg: PaymentConfig,
  facilitatorClient?: FacilitatorClient,
): void {
  if (!cfg.enabled) return;
  if (!EVM_ADDRESS.test(cfg.payTo)) {
    throw new Error(
      "x402 is enabled (X402_ENABLED) but X402_PAY_TO is not a valid 0x EVM address",
    );
  }

  const facilitator = facilitatorClient ?? (cfg.network === BASE_MAINNET
    ? new HTTPFacilitatorClient(createFacilitatorConfig(cfg.cdpApiKeyId, cfg.cdpApiKeySecret))
    : new HTTPFacilitatorClient({ url: cfg.facilitatorUrl }));
  const resourceServer = new x402ResourceServer(facilitator).register(
    cfg.network,
    new ExactEvmScheme(),
  );
  installPaymentObservability(resourceServer);

  // Observability-only wrapper around the gated route: logs request receipt,
  // a pre-classification of the payment header (never its content — see
  // `classifyPaymentHeader`), and the final response status. Always calls
  // `next()` unconditionally and never inspects/mutates the response body, so
  // it cannot change what the gate or handler decide.
  app.use("/v1/check", async (c: Context, next) => {
    const correlationId = requestCorrelationId((name) => c.req.header(name));
    const paymentHeader = classifyPaymentHeader(c.req.header("payment-signature"));
    logX402("request_received", { correlationId, method: c.req.method, paymentHeader });
    if (paymentHeader === "malformed") {
      logX402("malformed_payment", { correlationId });
    }
    await next();
    logX402("request_completed", { correlationId, status: c.res.status });
  });

  // No paywallConfig / custom paywall provider — agent-first, no browser wallet UI.
  app.use(paymentMiddleware(buildRoutes(cfg), resourceServer));
}
