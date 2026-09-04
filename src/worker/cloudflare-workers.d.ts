/**
 * Minimal ambient surface of the Cloudflare Workers runtime that `src/worker/`
 * actually touches — deliberately NOT `@cloudflare/workers-types` (see the note
 * in `rate-budget-do.ts`).
 *
 * Picked up by `tsc` via the `"src"` entry in `tsconfig.json`'s `include`.
 */

/** Cursor returned by `SqlStorage.exec` (Durable Object SQLite API). */
interface SqlStorageCursor {
  toArray(): Array<Record<string, unknown>>;
}

/** `ctx.storage.sql` on a SQLite-backed Durable Object. */
interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlStorageCursor;
}

interface DurableObjectStorage {
  sql: SqlStorage;
  /**
   * Run `closure` as one synchronous SQLite transaction. If it throws, every
   * statement it issued is rolled back and the error propagates.
   */
  transactionSync<T>(closure: () => T): T;
}

/** The `ctx` (a.k.a. `state`) handed to a Durable Object constructor. */
interface DurableObjectState {
  storage: DurableObjectStorage;
}

declare module "cloudflare:workers" {
  /**
   * Runtime base class for a Durable Object. Extending it is what makes an
   * instance's public methods reachable over RPC from a Worker through its stub
   * (required on modern compatibility dates); a plain class exposes only
   * `fetch()`, so `stub.reserveLiveCall(...)` on a plain class rejects.
   */
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
