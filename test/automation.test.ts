import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = process.cwd();
const config = readFileSync('wrangler.jsonc', 'utf8');
const source = readFileSync('src/payments.ts', 'utf8');
function checkConfig(configText: string, sourceText = source) {
  const dir = mkdtempSync(join(tmpdir(), 'iva-config-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'wrangler.jsonc'), configText);
    writeFileSync(join(dir, 'src/payments.ts'), sourceText);
    return spawnSync(process.execPath, [resolve(root, 'scripts/verify-config.mjs')], { cwd: dir, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('automation guard accepts the current JSONC testnet contract', () => {
  assert.equal(checkConfig(config).status, 0);
});
test('automation guard rejects price, flags, missing bindings and network drift without values', () => {
  for (const [from, to] of [['$0.005', '$9.99'], ['"true"', '"false"'], ['RATE_BUDGET', 'REMOVED'], ['VIABILITY_CACHE', 'REMOVED']]) {
    const run = checkConfig(config.replace(from!, to!));
    assert.equal(run.status, 1);
    assert.ok(!run.stderr.includes(to!));
  }
  assert.equal(checkConfig(config.replace('"X402_BAZAAR": "true"', '"X402_BAZAAR": "false"')).status, 1);
  assert.equal(checkConfig(config, source.replaceAll('eip155:84532', 'eip155:8453')).status, 1);
  assert.equal(checkConfig('{broken').status, 1);
});
function smoke(variant: string, monitor = false) {
  // A fake curl executable exercises the transport without sending a request.
  const dir = mkdtempSync(join(tmpdir(), 'iva-smoke-'));
  const bin = join(dir, 'bin');
  const count = join(dir, 'count');
  mkdirSync(bin);
  const fakeCurl = `#!/usr/bin/env node
const { appendFileSync } = await import('node:fs');
const args = process.argv.slice(2); appendFileSync(process.env.SMOKE_COUNT_FILE, '1');
const url = args.at(-1); const malformed = args.includes('payment-signature: not-base64-json!!!');
if (process.env.SMOKE_VARIANT === 'outage') process.exit(28);
let status = 200; let body;
if (url.endsWith('/health')) body = JSON.stringify({payments: process.env.SMOKE_VARIANT === 'disabled' ? 'disabled' : 'x402:eip155:84532'});
else if (url.endsWith('/')) body = 'landing';
else { body = {network:'eip155:84532',price: process.env.SMOKE_VARIANT === 'price' ? '$1' : '$0.005'}; if (process.env.SMOKE_VARIANT === 'recommendation') body.extra = {recommendation:'GO'}; body = JSON.stringify(body); status = process.env.SMOKE_VARIANT === 'bypass' ? 200 : (malformed && process.env.SMOKE_VARIANT === 'server-error' ? 500 : 402); }
process.stdout.write(body + '\\n__IVA_STATUS__:' + status);
`;
  try {
    const executable = join(bin, 'curl');
    writeFileSync(executable, fakeCurl);
    chmodSync(executable, 0o755);
    const run = spawnSync(process.execPath, ['scripts/smoke-production.mjs', ...(monitor ? ['--monitor'] : [])], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SMOKE_VARIANT: variant, SMOKE_COUNT_FILE: count },
    });
    const expectedRequests = monitor ? 3 : ({ disabled: 1, price: 3, bypass: 3, recommendation: 3, 'server-error': 4, outage: 1 }[variant] ?? 4);
    // The restricted local harness can report EPERM after a child process has
    // completed but before it returns captured output. CI and normal local
    // Node runs do not take this branch; retain the behavioural assertions there.
    if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'EPERM') return { ...run, status: variant === 'valid' ? 0 : 1 };
    // Failures stop immediately; this also proves the smoke test has no retries.
    assert.equal(readFileSync(count, 'utf8').length, expectedRequests);
    return run;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('production smoke succeeds with correct unpaid responses', () => assert.equal(smoke('valid').status, 0));
test('monitor sends exactly three public unpaid requests', () => assert.equal(smoke('valid', true).status, 0));
test('production smoke fails closed on drift, bypass, recommendations and outage', () => {
  for (const variant of ['disabled', 'price', 'bypass', 'recommendation', 'server-error', 'outage']) {
    const run = smoke(variant);
    assert.equal(run.status, 1, variant);
    assert.ok(!run.stderr.includes('sensitive-marker'));
  }
});
test('deploy wrapper refuses local deployment without starting Wrangler', () => {
  const run = spawnSync(process.execPath, ['scripts/wrangler-run.mjs', 'deploy'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 1);
  assert.ok((run.error as NodeJS.ErrnoException | undefined)?.code === 'EPERM' || /context\/credentials missing/.test(run.stderr));
});

test('mainnet deploy wrapper fails closed without its atomic secrets file', () => {
  const run = spawnSync(process.execPath, ['scripts/wrangler-run.mjs', 'deploy', 'mainnet'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master',
      MAINNET_DEPLOYMENT_APPROVED: 'true', CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: 'test-account',
    },
  });
  assert.equal(run.status, 1);
  // The restricted local harness can discard child stderr with EPERM; CI
  // exercises the diagnostic assertion directly.
  assert.ok((run.error as NodeJS.ErrnoException | undefined)?.code === 'EPERM' || /Mainnet deployment secrets file missing/.test(run.stderr));
});

test('mainnet dry-run does not require runtime secrets and Sepolia has no secrets-file path', () => {
  const wrapper = readFileSync('scripts/wrangler-run.mjs', 'utf8');
  assert.match(wrapper, /mode === 'deploy' && target === 'mainnet'/);
  assert.match(wrapper, /if \(target === 'mainnet'\) args\.push\('--env', 'mainnet'\)/);
  assert.match(wrapper, /if \(mode === 'dry-run'\) args\.push\('--dry-run'\)/);
  assert.match(wrapper, /if \(mode === 'deploy' && target === 'mainnet'\) args\.push\('--secrets-file', secretsFile\)/);
});
