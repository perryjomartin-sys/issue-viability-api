import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const REDACTED = '[REDACTED]';
const MAX_DIAGNOSTIC_LENGTH = 4_000;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitiseWranglerDiagnostic(output, apiToken = process.env.CLOUDFLARE_API_TOKEN) {
  let diagnostic = output
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, REDACTED)
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(CLOUDFLARE_API_TOKEN|[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNATURE)[A-Z0-9_]*|api[_-]?token|authorization|password|secret|private[_-]?key|signature)\b\s*([:=])\s*(?:"[^"]*"|'[^']*'|\S+)/gi, (_match, name, separator) => `${name}${separator} ${REDACTED}`);

  if (apiToken) diagnostic = diagnostic.replace(new RegExp(escapeRegExp(apiToken), 'g'), REDACTED);

  return diagnostic
    .replace(/\b0x[a-f0-9]{64,}\b/gi, REDACTED)
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, REDACTED)
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH) || 'No diagnostic output was produced.';
}

function main() {
  const mode = process.argv[2];
  const target = process.argv[3] ?? 'sepolia';
  if (!['dry-run', 'deploy'].includes(mode) || !['sepolia', 'mainnet'].includes(target) || process.argv.length > 4) process.exit(2);
  // Deploy is intentionally callable only from the explicitly dispatched production job.
  const approval = target === 'mainnet' ? process.env.MAINNET_DEPLOYMENT_APPROVED : process.env.PRODUCTION_APPROVED;
  if (mode === 'deploy' && (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/master' || approval !== 'true' || !process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
    console.error('Deployment context/credentials missing');
    process.exit(1);
  }
  const args = ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'wrangler.jsonc'];
  if (target === 'mainnet') args.push('--env', 'mainnet');
  if (mode === 'dry-run') args.push('--dry-run');
  // Capture all Wrangler output: bindings and configuration are not logged on success.
  const run = spawnSync(process.execPath, args, {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  });
  // Some constrained local sandboxes report EPERM after a child has completed
  // successfully (status 0). The exit status is authoritative in that case.
  if (run.status !== 0) {
    console.error(`Wrangler ${mode}: FAIL\n${sanitiseWranglerDiagnostic(`${run.stderr ?? ''}\n${run.stdout ?? ''}`)}`);
    process.exit(1);
  }
  console.log(`Wrangler ${mode}: PASS`);
  if (mode === 'deploy') {
    const version = run.stdout.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1] ?? 'unavailable';
    const timestamp = new Date().toISOString();
    console.log(`Worker Version ID: ${version}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntimestamp=${timestamp}\n`);
  }
}

if (process.argv[1]?.endsWith('scripts/wrangler-run.mjs')) main();
