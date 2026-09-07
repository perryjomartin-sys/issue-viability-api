import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyConfig } from '../scripts/verify-config.mjs';
import {
  BASE_MAINNET,
  BASE_MAINNET_USDC,
  BASE_SEPOLIA,
  BASE_SEPOLIA_USDC,
  CDP_FACILITATOR,
  X402_ORG_FACILITATOR,
  X402_PRICE,
  buildRoutes,
  readPaymentConfig,
} from '../src/payments.ts';

const PAY_TO = '0x000000000000000000000000000000000000dEaD';
const cdp = { CDP_API_KEY_ID: 'key-id', CDP_API_KEY_SECRET: 'secret-value' };
const mainnet = () => readPaymentConfig({
  X402_ENABLED: 'true', X402_NETWORK: BASE_MAINNET, X402_ASSET: BASE_MAINNET_USDC,
  X402_FACILITATOR_URL: CDP_FACILITATOR, X402_MAINNET_APPROVED: 'true',
  X402_PRICE, X402_PAY_TO: PAY_TO, ...cdp,
});

test('default payment configuration remains Base Sepolia with native test USDC and x402.org', () => {
  const cfg = readPaymentConfig({});
  assert.equal(cfg.network, BASE_SEPOLIA);
  assert.equal(cfg.asset, BASE_SEPOLIA_USDC);
  assert.equal(cfg.facilitatorUrl, X402_ORG_FACILITATOR);
  assert.equal(cfg.price, X402_PRICE);
});

test('Base mainnet maps exactly to native USDC and CDP, including a pinned route asset', () => {
  const cfg = mainnet();
  assert.equal(cfg.network, 'eip155:8453');
  assert.equal(cfg.asset, BASE_MAINNET_USDC);
  const accepts = (buildRoutes(cfg) as any)['POST /v1/check'].accepts;
  assert.equal(accepts.network, BASE_MAINNET);
  assert.deepEqual(accepts.price, { amount: '5000', asset: BASE_MAINNET_USDC });
});

test('mainnet fails closed without approval, CDP auth, or its exact facilitator', () => {
  const base = { X402_NETWORK: BASE_MAINNET, X402_PAY_TO: PAY_TO, X402_ASSET: BASE_MAINNET_USDC, X402_PRICE };
  assert.throws(() => readPaymentConfig({ ...base, ...cdp }));
  assert.throws(() => readPaymentConfig({ ...base, X402_MAINNET_APPROVED: 'true' }));
  assert.throws(() => readPaymentConfig({ ...base, ...cdp, X402_MAINNET_APPROVED: 'true', X402_FACILITATOR_URL: X402_ORG_FACILITATOR }));
});

test('unapproved combinations and price drift fail closed without leaking secret material', () => {
  const secret = 'do-not-log-this-cdp-secret';
  const cases = [
    { X402_NETWORK: 'eip155:1' },
    { X402_NETWORK: BASE_SEPOLIA, X402_ASSET: BASE_MAINNET_USDC },
    { X402_NETWORK: BASE_SEPOLIA, X402_FACILITATOR_URL: CDP_FACILITATOR },
    { X402_PRICE: '$0.01' },
  ];
  for (const change of cases) {
    assert.throws(() => readPaymentConfig({ ...change, CDP_API_KEY_SECRET: secret }), error => !String(error).includes(secret));
  }
});

test('facilitator support audit compares parsed network fields exactly', () => {
  const audit = readFileSync('scripts/audit-facilitator-support.mjs', 'utf8');
  assert.match(audit, /kind\.network === network/);
  assert.ok(!audit.includes('includes("eip155:8453")'));
});

test('ordinary and mainnet workflows preserve manual mainnet-only gates', () => {
  const sepolia = readFileSync('.github/workflows/deploy-production.yml', 'utf8');
  const mainnetWorkflow = readFileSync('.github/workflows/deploy-mainnet.yml', 'utf8');
  assert.ok(!sepolia.includes('--env mainnet'));
  assert.match(mainnetWorkflow, /workflow_dispatch:/);
  assert.ok(!/^\s*push:/m.test(mainnetWorkflow));
  assert.match(mainnetWorkflow, /ENABLE_BASE_MAINNET_8453/);
  assert.match(mainnetWorkflow, /issue-viability-mainnet/);
  assert.match(mainnetWorkflow, /test "\$CONFIRM_SHA" = "\$GITHUB_SHA"/);
  assert.match(mainnetWorkflow, /verify-config\.mjs mainnet/);
  assert.match(mainnetWorkflow, /wrangler-run\.mjs dry-run mainnet/);
  assert.match(mainnetWorkflow, /CDP_API_KEY_ID: \$\{\{ secrets\.CDP_API_KEY_ID \}\}/);
  assert.match(mainnetWorkflow, /CDP_API_KEY_SECRET: \$\{\{ secrets\.CDP_API_KEY_SECRET \}\}/);
  assert.match(mainnetWorkflow, /X402_PAY_TO: \$\{\{ secrets\.X402_PAY_TO \}\}/);
  assert.match(mainnetWorkflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(mainnetWorkflow, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.match(mainnetWorkflow, /umask 077/);
  assert.match(mainnetWorkflow, /IVA_MAINNET_SECRETS_FILE/);
  assert.match(mainnetWorkflow, /trap 'rm -f/);
  assert.match(mainnetWorkflow, /chmod 600/);
  assert.ok(!mainnetWorkflow.includes('wrangler secret bulk'));
  assert.ok(!/\b(?:cat|echo|debug)\b.*(?:CDP_API_KEY_ID|CDP_API_KEY_SECRET|X402_PAY_TO)/.test(mainnetWorkflow));
  const wrapper = readFileSync('scripts/wrangler-run.mjs', 'utf8');
  assert.match(wrapper, /--secrets-file/);
  assert.match(wrapper, /Mainnet deployment secrets file missing/);
});

test('mainnet config requires a real isolated KV namespace and its own Durable Object migration', () => {
  const config = readFileSync('wrangler.jsonc', 'utf8');
  const source = readFileSync('src/payments.ts', 'utf8');
  assert.doesNotThrow(() => verifyConfig(config, source, 'mainnet'));
  assert.throws(() => verifyConfig(config.replace('38a6dfdb562544bbb09ac45d5d03a074', '00000000000000000000000000000000'), source, 'mainnet'));
  assert.throws(() => verifyConfig(config.replace('38a6dfdb562544bbb09ac45d5d03a074', 'c40855d65e2b4a5c84620d791da34a9e'), source, 'mainnet'));
  assert.throws(() => verifyConfig(config.replace('"migrations": [{ "tag": "v1", "new_sqlite_classes": ["RateBudgetDO"] }],\n      "kv_namespaces"', '"kv_namespaces"'), source, 'mainnet'));
});
