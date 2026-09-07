import { spawnSync } from 'node:child_process';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createFacilitatorConfig } from '@coinbase/x402';

const worker = 'issue-viability-api-mainnet';
const allowedVars = new Set([
  'X402_ENABLED', 'X402_NETWORK', 'X402_ASSET', 'X402_FACILITATOR_URL',
  'X402_RESOURCE_URL', 'X402_MAINNET_APPROVED', 'X402_PRICE', 'X402_BAZAAR',
]);
const requiredSecrets = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'X402_PAY_TO'];

function readOnlyWrangler(args) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  });
  if (result.status !== 0) throw Error('read-only Wrangler query failed');
  try { return JSON.parse(result.stdout); } catch { throw Error('Wrangler returned invalid JSON'); }
}

function listFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.versions)) return value.versions;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function plainTextValue(binding) {
  const value = binding.text ?? binding.value;
  return typeof value === 'string' ? value : '<unavailable>';
}

function activeVersion(deployment) {
  const versions = listFrom(deployment?.versions);
  return versions.find((entry) => entry.percentage === 100)?.version_id ?? versions[0]?.version_id;
}

function inspectDeployment() {
  const flags = ['--config', 'wrangler.jsonc', '--env', 'mainnet', '--json'];
  const status = readOnlyWrangler(['deployments', 'status', ...flags]);
  const deployments = readOnlyWrangler(['deployments', 'list', ...flags]);
  const versions = readOnlyWrangler(['versions', 'list', ...flags]);
  const versionId = activeVersion(status);
  if (typeof versionId !== 'string') throw Error('active version unavailable');
  const version = readOnlyWrangler(['versions', 'view', versionId, ...flags]);
  const bindings = listFrom(version?.resources?.bindings);
  const variables = Object.fromEntries(bindings
    .filter((binding) => binding.type === 'plain_text' && allowedVars.has(binding.name))
    .map((binding) => [binding.name, plainTextValue(binding)]));
  const secretNames = new Set(bindings
    .filter((binding) => binding.type === 'secret_text')
    .map((binding) => binding.name));
  const traffic = listFrom(status?.versions).map(({ version_id, percentage }) => ({ version_id, percentage }));
  const recentVersions = listFrom(versions).map((entry) => ({
    id: entry.id,
    created_on: entry.metadata?.created_on,
  }));
  const recentDeployments = listFrom(deployments).map((entry) => ({
    created_on: entry.created_on,
    versions: listFrom(entry.versions).map(({ version_id, percentage }) => ({ version_id, percentage })),
  }));
  console.log(JSON.stringify({
    worker,
    active_deployment_created_on: status.created_on,
    active_version_id: versionId,
    traffic,
    exactly_one_version_at_100_percent: traffic.length === 1 && traffic[0].percentage === 100,
    active_version_created_on: version.metadata?.created_on,
    active_version_preview_url: version.preview_url ?? version.metadata?.preview_url ?? null,
    active_version_plaintext_bindings: variables,
    active_version_secret_presence: Object.fromEntries(requiredSecrets.map((name) => [name, secretNames.has(name)])),
    recent_deployments: recentDeployments,
    recent_versions: recentVersions,
  }, null, 2));
}

async function facilitatorSupport() {
  const id = process.env.CDP_API_KEY_ID;
  const secret = process.env.CDP_API_KEY_SECRET;
  if (!id || !secret) throw Error('CDP credentials unavailable to diagnostic runner');
  try {
    const client = new HTTPFacilitatorClient(createFacilitatorConfig(id, secret));
    const supported = await client.getSupported();
    console.log(JSON.stringify({
      facilitator_support: 'ok',
      kinds: supported.kinds.map(({ x402Version, scheme, network }) => ({ x402Version, scheme, network })),
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[REDACTED]') : 'unknown error';
    console.log(JSON.stringify({ facilitator_support: 'failed', error_type: error instanceof Error ? error.name : 'unknown', message }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[2] === 'facilitator-support') await facilitatorSupport();
else inspectDeployment();
