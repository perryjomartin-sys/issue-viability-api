import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseWranglerDiagnostic } from '../scripts/wrangler-run.mjs';

test('sanitises Wrangler failure diagnostics', () => {
  const token = 'cf-api-token-123';
  const privateKey = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const signature = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const output = [
    'Error: request to Cloudflare failed with code 10000',
    `CLOUDFLARE_API_TOKEN=${token}`,
    'MY_SECRET=not-for-logs',
    `Authorization: Bearer ${token}`,
    `private_key: ${privateKey}`,
    `payment signature=${signature}`,
    '-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----',
  ].join('\n');

  const diagnostic = sanitiseWranglerDiagnostic(output, token);

  assert.match(diagnostic, /Error: request to Cloudflare failed with code 10000/);
  assert.doesNotMatch(diagnostic, new RegExp(token));
  assert.doesNotMatch(diagnostic, /not-for-logs/);
  assert.doesNotMatch(diagnostic, new RegExp(privateKey));
  assert.doesNotMatch(diagnostic, new RegExp(signature));
  assert.doesNotMatch(diagnostic, /secret-key-material/);
  assert.match(diagnostic, /\[REDACTED\]/);
});
