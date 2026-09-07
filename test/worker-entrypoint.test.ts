import test from 'node:test';
import assert from 'node:assert/strict';
import { appEnvFromWorkerEnv, createWorkerHandler, type Env } from '../src/worker/index.ts';
import { BASE_MAINNET_USDC, CDP_FACILITATOR } from '../src/payments.ts';

const PAY_TO = '0xbe48f8be98892f37102A027240F9C4Fab952Dfb5';
const noOpRateBudget = {} as Env['RATE_BUDGET'];
const context = {} as Parameters<ReturnType<typeof createWorkerHandler>['fetch']>[2];
const offlineFacilitator = {
  async getSupported() {
    return { kinds: [
      { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
      { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
    ], extensions: [], signers: {} };
  },
  async verify() { return { isValid: false, invalidReason: 'test' }; },
  async settle() { return { success: false, errorReason: 'test' }; },
} as any;

function mainnetEnv(): Env {
  return {
    RATE_BUDGET: noOpRateBudget,
    X402_ENABLED: 'true',
    X402_NETWORK: 'eip155:8453',
    X402_ASSET: BASE_MAINNET_USDC,
    X402_MAINNET_APPROVED: 'true',
    X402_FACILITATOR_URL: CDP_FACILITATOR,
    X402_PRICE: '$0.005',
    X402_BAZAAR: 'true',
    X402_RESOURCE_URL: 'https://issue-viability-api-mainnet.agentactiongateway.workers.dev/v1/check',
    CDP_API_KEY_ID: 'test-cdp-id',
    CDP_API_KEY_SECRET: 'test-cdp-secret',
    X402_PAY_TO: PAY_TO,
  };
}

test('Worker entrypoint bridges explicit mainnet Env into createApp without logging secrets', async () => {
  const env = mainnetEnv();
  const bridged = appEnvFromWorkerEnv(env);
  assert.deepEqual(bridged, {
    GITHUB_TOKEN: undefined,
    X402_ENABLED: 'true', X402_NETWORK: 'eip155:8453', X402_ASSET: BASE_MAINNET_USDC,
    X402_MAINNET_APPROVED: 'true', X402_FACILITATOR_URL: CDP_FACILITATOR,
    X402_PRICE: '$0.005', X402_BAZAAR: 'true',
    X402_RESOURCE_URL: 'https://issue-viability-api-mainnet.agentactiongateway.workers.dev/v1/check',
    CDP_API_KEY_ID: 'test-cdp-id', CDP_API_KEY_SECRET: 'test-cdp-secret', X402_PAY_TO: PAY_TO,
  });
  const health = await createWorkerHandler({ facilitatorClient: offlineFacilitator }).fetch(new Request('https://worker.example/health'), env, context);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { payments: string }).payments, 'x402:eip155:8453');
});

test('Worker entrypoint retains explicit Base Sepolia default behavior', async () => {
  const env: Env = { RATE_BUDGET: noOpRateBudget, X402_ENABLED: 'true', X402_PAY_TO: PAY_TO };
  const health = await createWorkerHandler({ facilitatorClient: offlineFacilitator }).fetch(new Request('https://worker.example/health'), env, context);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { payments: string }).payments, 'x402:eip155:84532');
});
