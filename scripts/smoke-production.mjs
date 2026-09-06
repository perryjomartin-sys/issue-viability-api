import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const base = 'https://issue-viability-api.agentactiongateway.workers.dev';
const monitoring = process.argv.slice(2);
if (monitoring.some(arg => arg !== '--monitor') || monitoring.length > 1) {
  console.error('Usage: node scripts/smoke-production.mjs [--monitor]');
  process.exit(2);
}
const results = {};
function requireCondition(ok) { if (!ok) throw Error(); }
function hasRecommendation(value) {
  return value !== null && typeof value === 'object' &&
    (Object.hasOwn(value, 'recommendation') || Object.values(value).some(hasRecommendation));
}
function request(path, options = {}) {
  const headers = { accept: 'application/json', connection: 'close', ...options.headers };
  const args = ['--silent', '--show-error', '--max-time', '45', '--connect-timeout', '15', '--request', options.method ?? 'GET'];
  for (const [name, value] of Object.entries(headers)) args.push('--header', `${name}: ${value}`);
  if (options.body) args.push('--data', options.body);
  // curl is present on GitHub-hosted Ubuntu and avoids the local Node 22/undici
  // request hang observed against this public Worker. It does not follow redirects.
  const marker = '\n__IVA_STATUS__:';
  args.push('--write-out', `${marker}%{http_code}`, base + path);
  const run = spawnSync('curl', args, { encoding: 'utf8', timeout: 50000, maxBuffer: 1024 * 1024 });
  if (run.error || run.status !== 0) throw Error();
  const position = run.stdout.lastIndexOf(marker);
  if (position < 0) throw Error();
  const status = Number(run.stdout.slice(position + marker.length));
  if (!Number.isInteger(status)) throw Error();
  return { status, body: run.stdout.slice(0, position) };
}
let stage = 'health';
try {
  const health = request('/health');
  results.health = health.status;
  requireCondition(health.status === 200 && JSON.parse(health.body).payments === 'x402:eip155:84532');
  stage = 'root';
  const root = request('/');
  results.root = root.status;
  requireCondition(root.status === 200);
  stage = 'unpaid';
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'cli/cli', issue: 14297 }) };
  const unpaid = request('/v1/check', options);
  results.unpaid = unpaid.status;
  const body = JSON.parse(unpaid.body);
  requireCondition(unpaid.status === 402 && body.network === 'eip155:84532' && body.price === '$0.005' && !hasRecommendation(body));
  if (!monitoring.length) {
    stage = 'malformed';
    const malformed = request('/v1/check', { ...options, headers: { ...options.headers, 'payment-signature': 'not-base64-json!!!' } });
    results.malformed = malformed.status;
    // Known rejection statuses only; outages and unexpected responses fail closed.
    requireCondition([400, 402].includes(malformed.status));
    let parsed;
    try { parsed = JSON.parse(malformed.body); } catch { throw Error(); }
    requireCondition(!hasRecommendation(parsed));
  }
  console.log(`Production smoke: PASS ${JSON.stringify(results)}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(results).map(([k, v]) => `${k}=${v}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\nSmoke: PASS\n\n| Path | HTTP |\n|---|---|\n${Object.entries(results).map(([k,v]) => `| ${k} | ${v} |`).join('\n')}\n\nNetwork: eip155:84532; price: $0.005\n`);
} catch (error) {
  const kind = ['TimeoutError', 'TypeError', 'SyntaxError'].includes(error?.name) ? error.name : 'contract';
  console.error(`Production smoke: FAIL at ${stage} (${kind}); HTTP statuses: ${JSON.stringify(results)}; response details suppressed`);
  process.exitCode = 1;
}
