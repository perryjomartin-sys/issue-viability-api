import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import ts from 'typescript';

// Never include parsed values or exception messages in output.
export function verifyConfig(text, source) {
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config) throw Error();
  const vars = config.vars ?? {};
  if (vars.X402_ENABLED !== 'true' || vars.X402_PRICE !== '$0.005' || vars.X402_BAZAAR !== 'true') throw Error();
  if (config.name !== 'issue-viability-api' || config.main !== 'src/worker/index.ts') throw Error();
  // No alternate deployment environments or network overrides in this phase.
  if (config.env || config.build || Object.keys(vars).some(k => /network|chain/i.test(k))) throw Error();
  if (!config.durable_objects?.bindings?.some(b => b.name === 'RATE_BUDGET' && b.class_name === 'RateBudgetDO')) throw Error();
  if (!config.kv_namespaces?.some(b => b.binding === 'VIABILITY_CACHE' && typeof b.id === 'string' && b.id.length > 0)) throw Error();
  const networks = JSON.stringify(config).match(/eip155:\d+/g) ?? [];
  const file = ts.createSourceFile('payments.ts', source, ts.ScriptTarget.Latest, true);
  let found = false;
  function visit(node) {
    if (ts.isStringLiteral(node)) {
      networks.push(...(node.text.match(/eip155:\d+/g) ?? []));
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'BASE_SEPOLIA') {
      const init = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      found = ts.isStringLiteral(init) && init.text === 'eip155:84532';
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!found || networks.some(n => n !== 'eip155:84532')) throw Error();
}
try {
  verifyConfig(readFileSync('wrangler.jsonc', 'utf8'), readFileSync('src/payments.ts', 'utf8'));
  console.log('Configuration safety: PASS (Base Sepolia, $0.005, required bindings)');
} catch {
  console.error('Configuration safety: FAIL (invalid configuration or testnet contract drift)');
  process.exitCode = 1;
}
