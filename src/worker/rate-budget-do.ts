/**
 * Cloudflare Durable Object — the shared `RateBudget` for a Worker deployment.
 *
 * ONE logical instance (name `"github-credential"`) is the serialization
 * boundary: every `reserveLiveCall` / `reconcile` / `recover` RPC runs to
 * completion before the next starts, so the read-modify-write of the state is
 * atomic. The GitHub fetch (and the `GET /rate_limit` recovery call) happen in
 * the Worker between RPCs and are NEVER held inside the DO.
 *
 * Decision logic is the shared pure `admit` / `applyReconcile` / `applyRecovery`
 * from `../rate-budget.ts`, so the DO and `MemoryRateBudget` cannot drift. This
 * file only maps that state to/from SQLite (`ctx.storage.sql`) — allowed on
 * the Workers **Free** plan via a `new_sqlite_classes` migration (see
 * `wrangler.jsonc`). NOT imported by the Node entrypoint and NOT deployed.
 *
 * Minimal Cloudflare ambient types are declared locally (`cloudflare-workers.d.ts`)
 * to avoid adding `@cloudflare/workers-types` as a dependency. The class DOES
 * import the real `DurableObject` base from `cloudflare:workers` — extending it
 * is what makes `reserveLiveCall` / `reconcile` / `recover` dispatch over RPC
 * from the Worker (a plain class exposes only `fetch()`). `node:test` runs map
 * that bare specifier to a shim (see `test/shims/`).
 *
 * Deployed (see `wrangler.jsonc`); not imported by the Node entrypoint
 * (`src/server.ts`), which uses `MemoryRateBudget` instead.
 */
import { DurableObject } from "cloudflare:workers";

import {
  FALLBACK_RETRY_MS,
  admit,
  applyReconcile,
  applyRecovery,
  type BudgetSnapshot,
  type RateBudget,
  type Reconciliation,
  type RecoveryResult,
  type ReserveDecision,
} from "../rate-budget.ts";

/* --- minimal Cloudflare ambient shapes (only what this file touches) ---
 * `SqlStorage` / `DurableObjectStorage` / `DurableObjectState` are global,
 * declared in `cloudflare-workers.d.ts`. Only the stub-side shapes are local. */
interface DurableObjectId {
  toString(): string;
}
/** The subset of a DO stub we call (RPC — modern compatibility date). */
interface RateBudgetStub {
  reserveLiveCall(nowMs: number): Promise<ReserveDecision>;
  reconcile(reservationId: string, result: Reconciliation, nowMs: number): Promise<void>;
  recover(recoveryToken: string, result: RecoveryResult, nowMs: number): Promise<void>;
}
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): RateBudgetStub;
}

const SINGLETON_NAME = "github-credential";

/**
 * Bind as `RATE_BUDGET` with `{ "new_sqlite_classes": ["RateBudgetDO"] }`.
 *
 * Schema (minimal):
 *   budget_state     0..1 row  — authoritative remaining / resetAt / cost.
 *                                No row = unknown (recovery-only state).
 *   reservations     0..N rows — id + created_at_ms + indeterminate flag per
 *                                in-flight (or possibly-charged) live call.
 *   recovery         0..1 row  — started_at_ms + owner token of the in-flight
 *                                `GET /rate_limit` election (single-flight +
 *                                owner-token gate). No row = no election.
 *   recovery_backoff 0..1 row  — not_before_ms: no recovery may be elected and
 *                                no assessment admitted before this epoch-ms.
 *                                No row = no backoff.
 *
 * Never deployed, so `CREATE TABLE` here is the whole schema (no ALTER needed).
 */
export class RateBudgetDO extends DurableObject {
  #sql: SqlStorage;
  #storage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#storage = ctx.storage;
    this.#sql = ctx.storage.sql;
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS budget_state (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), " +
        "remaining INTEGER NOT NULL, reset_at_ms INTEGER NOT NULL, cost INTEGER NOT NULL)",
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS reservations (" +
        "id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL, " +
        "indeterminate INTEGER NOT NULL DEFAULT 0)",
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS recovery (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), started_at_ms INTEGER NOT NULL, token TEXT NOT NULL)",
    );
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS recovery_backoff (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), not_before_ms INTEGER NOT NULL)",
    );
  }

  #load(): BudgetSnapshot {
    const b = this.#sql
      .exec("SELECT remaining, reset_at_ms, cost FROM budget_state WHERE id = 1")
      .toArray()[0];
    const rs = this.#sql
      .exec("SELECT id, created_at_ms, indeterminate FROM reservations")
      .toArray();
    const lease = this.#sql
      .exec("SELECT started_at_ms, token FROM recovery WHERE id = 1")
      .toArray()[0];
    const backoff = this.#sql
      .exec("SELECT not_before_ms FROM recovery_backoff WHERE id = 1")
      .toArray()[0];
    return {
      authoritative: b
        ? { remaining: Number(b.remaining), resetAtMs: Number(b.reset_at_ms), cost: Number(b.cost) }
        : null,
      reservations: rs.map((r) => ({
        id: String(r.id),
        createdAtMs: Number(r.created_at_ms),
        indeterminate: Number(r.indeterminate) === 1,
      })),
      recovery: lease
        ? { token: String(lease.token), startedAtMs: Number(lease.started_at_ms) }
        : null,
      recoveryNotBeforeMs: backoff ? Number(backoff.not_before_ms) : null,
    };
  }

  #save(snap: BudgetSnapshot): void {
    // The budget row, reservation set, recovery lease and recovery backoff are
    // one safety-critical unit: a partial write (e.g. reservations DELETEd but
    // not reinserted, or a lease cleared without its backoff) would let quota be
    // reused. `transactionSync` makes the whole mutation atomic — any failed
    // statement rolls the entire block back.
    this.#storage.transactionSync(() => {
      if (snap.authoritative) {
        this.#sql.exec(
          "INSERT INTO budget_state (id, remaining, reset_at_ms, cost) VALUES (1, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET remaining = excluded.remaining, " +
            "reset_at_ms = excluded.reset_at_ms, cost = excluded.cost",
          Math.trunc(snap.authoritative.remaining),
          Math.trunc(snap.authoritative.resetAtMs),
          Math.trunc(snap.authoritative.cost),
        );
      } else {
        this.#sql.exec("DELETE FROM budget_state WHERE id = 1");
      }
      // Small, bounded set (<= floor / cost); one logical DO. Replace wholesale
      // inside this single serialized, transactional RPC.
      this.#sql.exec("DELETE FROM reservations");
      for (const r of snap.reservations) {
        this.#sql.exec(
          "INSERT INTO reservations (id, created_at_ms, indeterminate) VALUES (?, ?, ?)",
          r.id,
          Math.trunc(r.createdAtMs),
          r.indeterminate ? 1 : 0,
        );
      }
      if (snap.recovery !== null) {
        this.#sql.exec(
          "INSERT INTO recovery (id, started_at_ms, token) VALUES (1, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET started_at_ms = excluded.started_at_ms, token = excluded.token",
          Math.trunc(snap.recovery.startedAtMs),
          snap.recovery.token,
        );
      } else {
        this.#sql.exec("DELETE FROM recovery WHERE id = 1");
      }
      if (snap.recoveryNotBeforeMs !== null) {
        this.#sql.exec(
          "INSERT INTO recovery_backoff (id, not_before_ms) VALUES (1, ?) " +
            "ON CONFLICT(id) DO UPDATE SET not_before_ms = excluded.not_before_ms",
          Math.trunc(snap.recoveryNotBeforeMs),
        );
      } else {
        this.#sql.exec("DELETE FROM recovery_backoff WHERE id = 1");
      }
    });
  }

  /** RPC: atomically reserve headroom for one live GitHub call. */
  async reserveLiveCall(nowMs: number): Promise<ReserveDecision> {
    const { decision, next } = admit(
      this.#load(),
      nowMs,
      crypto.randomUUID(),
      crypto.randomUUID(),
    );
    this.#save(next);
    return decision;
  }

  /** RPC: settle a reservation (observed / indeterminate / not-sent). */
  async reconcile(
    reservationId: string,
    result: Reconciliation,
    nowMs: number,
  ): Promise<void> {
    this.#save(applyReconcile(this.#load(), reservationId, result, nowMs));
  }

  /** RPC: fold in an elected `GET /rate_limit` recovery result (owner-token gated). */
  async recover(recoveryToken: string, result: RecoveryResult, nowMs: number): Promise<void> {
    this.#save(applyRecovery(this.#load(), recoveryToken, result, nowMs));
  }
}

/**
 * Adapt the DO namespace to the app's `RateBudget`.
 *
 * FAIL-CLOSED: a `reserveLiveCall` RPC failure resolves to `{ ok: false }` so
 * the request is blocked, never admitted. A `reconcile` RPC failure is
 * re-thrown so the app knows the reservation was NOT released — it stays in the
 * DO, held to the reset window (temporary over-block, never a bypass). A
 * `recover` RPC failure is re-thrown so the app treats it as a failed recovery
 * (no assessment admitted; back off).
 */
export function durableObjectRateBudget(namespace: DurableObjectNamespace): RateBudget {
  const stub = (): RateBudgetStub => namespace.get(namespace.idFromName(SINGLETON_NAME));
  return {
    async reserveLiveCall(nowMs: number): Promise<ReserveDecision> {
      try {
        return await stub().reserveLiveCall(nowMs);
      } catch (err) {
        // FAIL CLOSED (block, never admit) — but surface the cause. A broken DO
        // binding, a class that is not RPC-eligible, or a runtime error inside
        // the DO all land here; without this line the app reports the generic
        // "GitHub API budget below the safe floor" 503 and the real fault is
        // invisible. Nothing sensitive is in scope on the reserve path: no
        // reservationId and no recoveryToken exist yet, so only `nowMs` and the
        // error are logged.
        console.error(
          `[RATE_BUDGET] reserveLiveCall RPC failed (nowMs=${nowMs}); failing closed:`,
          err,
        );
        return { ok: false, retryAfterMs: FALLBACK_RETRY_MS };
      }
    },
    async reconcile(
      reservationId: string,
      result: Reconciliation,
      nowMs: number,
    ): Promise<void> {
      await stub().reconcile(reservationId, result, nowMs); // may throw -> app holds to reset
    },
    async recover(recoveryToken: string, result: RecoveryResult, nowMs: number): Promise<void> {
      await stub().recover(recoveryToken, result, nowMs); // may throw -> app treats as failed recovery
    },
  };
}
