import { readFileSync } from 'node:fs';

/**
 * Return true only when a parsed facilitator `/supported` body explicitly
 * advertises the requested CAIP-2 network. Never use substring matching:
 * `eip155:8453` and `eip155:84532` are distinct identifiers.
 */
export function supportsExactNetwork(body, network) {
  if (typeof network !== 'string') return false;
  const kinds = body && typeof body === 'object' && Array.isArray(body.kinds) ? body.kinds : [];
  return kinds.some(kind => kind && typeof kind === 'object' && kind.network === network);
}

function main() {
  const [file, network] = process.argv.slice(2);
  if (!file || !network || process.argv.length !== 4) process.exit(2);
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'));
    if (!supportsExactNetwork(body, network)) throw Error();
    console.log('Facilitator support audit: PASS (exact network match)');
  } catch {
    console.error('Facilitator support audit: FAIL (required exact network absent)');
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('scripts/audit-facilitator-support.mjs')) main();
