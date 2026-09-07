import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) process.exit(2);
const raw = readFileSync(file, 'utf8');
const safe = raw
  .replace(/\b(CDP_API_KEY_(?:ID|SECRET)|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|X402_PAY_TO|authorization|payment-signature)\b\s*[:=]\s*\S+/gi, '$1: [REDACTED]')
  .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
  .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[REDACTED]')
  .slice(0, 12_000);
console.log(safe || 'No tail events captured.');
