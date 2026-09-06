import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const mode = process.argv[2];
if (!['dry-run', 'deploy'].includes(mode) || process.argv.length !== 3) process.exit(2);
// Deploy is intentionally callable only from the explicitly dispatched production job.
if (mode === 'deploy' && (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/master' || process.env.PRODUCTION_APPROVED !== 'true' || !process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
  console.error('Deployment context/credentials missing');
  process.exit(1);
}
const args = ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'wrangler.jsonc'];
if (mode === 'dry-run') args.push('--dry-run');
// Capture all Wrangler output: bindings, configuration and diagnostics are not logged.
const run = spawnSync(process.execPath, args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
});
if (run.error || run.status !== 0) {
  console.error(`Wrangler ${mode}: FAIL; raw output suppressed to protect configuration`);
  process.exit(1);
}
console.log(`Wrangler ${mode}: PASS`);
if (mode === 'deploy') {
  const version = run.stdout.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1] ?? 'unavailable';
  const timestamp = new Date().toISOString();
  console.log(`Worker Version ID: ${version}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntimestamp=${timestamp}\n`);
}
