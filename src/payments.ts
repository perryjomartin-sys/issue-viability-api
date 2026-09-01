/**
 * x402 V2 payment gate for `POST /v1/check` — Base Sepolia testnet ONLY.
 *
 * This build hard-codes the network to `eip155:84532` (Base Sepolia) and will
 * not price on anything else: no mainnet, no real USDC. The gate is OFF unless
 * `X402_ENABLED` is set.
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
import type { Hono } from "hono";

/** The ONLY network this build will price on (CAIP-2 for Base Sepolia). */
export const BASE_SEPOLIA = "eip155:84532" as const;

/** Public testnet facilitator — keyless verify/settle for base-sepolia. */
const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

/** Default price per call (G3). */
const DEFAULT_PRICE = "$0.005";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const truthy = (v: string | undefined): boolean => v === "true" || v === "1" || v === "yes";

export interface PaymentConfig {
  enabled: boolean;
  /** EVM address that receives Base Sepolia testnet USDC. Required when enabled. */
  payTo: string;
  facilitatorUrl: string;
  price: string;
  /** Public URL of this resource, for discovery metadata. */
  resourceUrl?: string;
  /** Emit the x402 Bazaar discovery extension on the route (default on). */
  bazaar: boolean;
}

export function readPaymentConfig(env: Record<string, string | undefined>): PaymentConfig {
  return {
    enabled: truthy(env.X402_ENABLED),
    payTo: (env.X402_PAY_TO ?? "").trim(),
    facilitatorUrl: (env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL).trim(),
    price: (env.X402_PRICE ?? DEFAULT_PRICE).trim(),
    resourceUrl: env.X402_RESOURCE_URL?.trim() || undefined,
    bazaar: env.X402_BAZAAR === undefined ? true : truthy(env.X402_BAZAAR),
  };
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
        price: cfg.price,
        network: BASE_SEPOLIA,
        payTo: cfg.payTo,
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
          detail: "POST /v1/check requires an x402 payment (Base Sepolia testnet USDC).",
          price: cfg.price,
          network: BASE_SEPOLIA,
        },
      }),
    },
  };
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

  const facilitator =
    facilitatorClient ?? new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(
    BASE_SEPOLIA,
    new ExactEvmScheme(),
  );

  // No paywallConfig / custom paywall provider — agent-first, no browser wallet UI.
  app.use(paymentMiddleware(buildRoutes(cfg), resourceServer));
}
