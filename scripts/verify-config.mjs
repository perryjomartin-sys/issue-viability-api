import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import ts from 'typescript';

const SEPOLIA = 'eip155:84532';
const MAINNET = 'eip155:8453';
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const X402_ORG = 'https://x402.org/facilitator';
const CDP = 'https://api.cdp.coinbase.com/platform/v2/x402';
const PRICE = '$0.005';
const MAINNET_KV_PLACEHOLDER = '00000000000000000000000000000000';

function hasRateBudget(bindings) {
  return bindings?.some(b => b.name === 'RATE_BUDGET' && b.class_name === 'RateBudgetDO');
}
function hasKv(bindings, id) {
  return bindings?.some(b => b.binding === 'VIABILITY_CACHE' && b.id === id);
}
function sourceStrings(source) {
  const file = ts.createSourceFile('payments.ts', source, ts.ScriptTarget.Latest, true);
  const strings = new Set();
  const visit = node => {
    if (ts.isStringLiteral(node)) strings.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return strings;
}

// Deliberately returns no parsed config values: it is safe to run in CI where
// future config may contain sensitive runtime metadata.
export function verifyConfig(text, source, target = 'sepolia') {
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || !['sepolia', 'mainnet'].includes(target)) throw Error();
  const sourceValues = sourceStrings(source);
  for (const value of [SEPOLIA, MAINNET, SEPOLIA_USDC, MAINNET_USDC, X402_ORG, CDP, PRICE]) {
    if (!sourceValues.has(value)) throw Error();
  }
  if (config.name !== 'issue-viability-api' || config.main !== 'src/worker/index.ts' || !hasRateBudget(config.durable_objects?.bindings)) throw Error();
  const sepoliaVars = config.vars ?? {};
  if (sepoliaVars.X402_ENABLED !== 'true' || sepoliaVars.X402_NETWORK !== SEPOLIA || sepoliaVars.X402_ASSET !== SEPOLIA_USDC || sepoliaVars.X402_PRICE !== PRICE || sepoliaVars.X402_BAZAAR !== 'true' || sepoliaVars.X402_MAINNET_APPROVED !== undefined || sepoliaVars.X402_FACILITATOR_URL !== undefined || !hasKv(config.kv_namespaces, 'c40855d65e2b4a5c84620d791da34a9e')) throw Error();
  const mainnet = config.env?.mainnet;
  if (!mainnet || Object.keys(config.env).some(name => name !== 'mainnet')) throw Error();
  const mainnetVars = mainnet.vars ?? {};
  if (mainnet.name !== 'issue-viability-api-mainnet' || !hasRateBudget(mainnet.durable_objects?.bindings) || !hasKv(mainnet.kv_namespaces, MAINNET_KV_PLACEHOLDER) || mainnetVars.X402_ENABLED !== 'true' || mainnetVars.X402_NETWORK !== MAINNET || mainnetVars.X402_ASSET !== MAINNET_USDC || mainnetVars.X402_FACILITATOR_URL !== CDP || mainnetVars.X402_MAINNET_APPROVED !== 'true' || mainnetVars.X402_PRICE !== PRICE || mainnetVars.X402_BAZAAR !== 'true') throw Error();
  if (target === 'mainnet' && mainnet.kv_namespaces?.some(b => b.id === config.kv_namespaces?.find(x => x.binding === 'VIABILITY_CACHE')?.id)) throw Error();
}

try {
  const target = process.argv[2] ?? 'sepolia';
  verifyConfig(readFileSync('wrangler.jsonc', 'utf8'), readFileSync('src/payments.ts', 'utf8'), target);
  console.log(`Configuration safety: PASS (${target})`);
} catch {
  console.error('Configuration safety: FAIL (invalid approved configuration)');
  process.exitCode = 1;
}
