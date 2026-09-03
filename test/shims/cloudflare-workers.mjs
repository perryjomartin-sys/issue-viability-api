/**
 * Test-only stand-in for the `cloudflare:workers` built-in module.
 *
 * `node:test` runs under plain Node, which cannot resolve `cloudflare:workers`
 * (it exists only in the workerd runtime). `RateBudgetDO` extends the real
 * `DurableObject` base ONLY so workerd exposes its methods over RPC; its
 * behaviour depends solely on `super(ctx, env)` recording `ctx`. This shim
 * provides exactly that.
 *
 * Wired in by `test/shims/register.mjs` via `package.json`'s `test` script.
 */
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
