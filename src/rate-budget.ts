/**
 * Coordinates the ONE shared GitHub credential's GraphQL point budget so live
 * calls stop once the projected `remaining` would fall below
 * `CONFIG.RATE_LIMIT_FLOOR`, until the rate window resets.
 *
 * ATOMIC RESERVATION MODEL (not check-then-observe). A read-only "may I call?"
 * check is unsafe: N concurrent cache misses all read the same above-floor
 * `remaining`, all pass, and all consume the credential before any response
 * lowers it. Instead:
 *
 *   1. `reserveLiveCall(now)` -> persists an in-flight reservation *before*
 *      returning `ok`, so concurrent callers subtract each other's projected
 *      cost. Returns `{ ok:false, retryAfterMs }` when reserving would breach
 *      the floor.
 *   2. the GitHub fetch happens OUTSIDE this store (never held across it).
 *   3. `reconcile(id, result, now)` -> settles that one reservation.
 *
 * AUTHORITATIVE RECOVERY (`recover`). The GraphQL points budget is learned ONLY
 * from GitHub's authoritative, non-chargeable `GET /rate_limit`
 * (`resources.graphql.remaining` / `.reset`) — never from a speculative
 * chargeable assessment. While the budget is unknown (cold start, post-reset,
 * after a store wipe) NO assessment is admitted: `reserveLiveCall` elects
 * exactly one caller with `{ ok:false, recover:true, recoveryToken }` to run
 * `GET /rate_limit` and feed the result back via `recover(recoveryToken, ...)`;
 * every other caller waits.
 *
 * RECOVERY OWNERSHIP TOKEN (round-4 remediation). Each election mints a
 * collision-resistant `recoveryToken` (generated inside this module / the
 * Durable Object, never from HTTP input). Only the caller holding the CURRENT
 * lease token may mutate recovery or authoritative state through `recover`. If
 * an election's `GET /rate_limit` outlives `RECOVERY_TTL_MS`, `normalize` drops
 * the lease and the next caller is elected with a *new* token; the original
 * caller's token is then permanently stale and its later success or failure is
 * completely inert — it cannot overwrite the budget, clear the new owner's
 * lease, or change the backoff.
 *
 * MONOTONIC RECOVERY. A current-owner `observed` recovery folds in exactly like
 * a normal `observed` reconcile: a strictly newer reset window is adopted;
 * otherwise `remaining` and `resetAtMs` only decrease and `cost` never
 * decreases. GitHub has returned slightly different reset timestamps for the
 * same live GraphQL window (for example, `GET /rate_limit` then the query), so
 * a lower timestamp is not sufficient evidence to discard a lower remaining
 * count. A delayed older-window observation can only cause conservative
 * over-blocking, never reopen capacity.
 *
 * PERSISTED RECOVERY BACKOFF. A failed / secondary-limited recovery (current
 * owner) persists `recoveryNotBeforeMs = now + (Retry-After | FALLBACK_RETRY_MS)`.
 * Until it elapses `admit` elects NO recovery caller and admits NO assessment,
 * returning a conservative retry delay — so a non-compliant client cannot drive
 * repeated serial `GET /rate_limit` calls. It is cleared only by the passage of
 * time or a successful current-owner recovery, and it deliberately survives a
 * primary-window reset (a secondary/abuse limit is not bound to that window).
 *
 * RECONCILE OUTCOMES (`Reconciliation`):
 *   - `observed`      — we have the authoritative `rateLimit`; release the
 *                       reservation and fold the value in monotonically.
 *   - `indeterminate` — a chargeable GraphQL request may have been dispatched
 *                       but we never got its `rateLimit` (timeout, transport
 *                       loss, or a REST fallback after a GraphQL transport
 *                       failure). Do NOT release: keep the reserved cost debited
 *                       through the current reset window.
 *   - `not-sent`      — it is *proven* no chargeable request went out; release
 *                       the reservation, no budget change.
 *
 * FAIL CLOSED. A backing-store failure in `reserveLiveCall` resolves to
 * `{ ok:false }` (never "allowed"). A failed `reconcile` leaves the reservation
 * in place; while the reset window is known it is held to that reset (a possibly
 * -charged request never has its debit dropped by a short TTL). A transient
 * failure causes temporary over-blocking, never a quota bypass.
 *
 * The pure `normalize` / `admit` / `applyReconcile` / `applyRecovery` are the
 * whole decision; `MemoryRateBudget` and the Worker `RateBudgetDO` share them so
 * local and fleet behaviour cannot drift.
 */
import { CONFIG } from "./config.ts";

/** Authoritative budget from a GraphQL response's `rateLimit` or `GET /rate_limit`. */
export interface RateBudgetState {
  remaining: number;
  resetAtMs: number;
  /** GraphQL point cost of one assessment query, as reported by GitHub. */
  cost: number;
}

export interface Reservation {
  id: string;
  createdAtMs: number;
  /** A chargeable GitHub attempt may be outstanding; held to the window reset. */
  indeterminate: boolean;
}

/**
 * An in-flight `GET /rate_limit` recovery election. Only the caller holding this
 * exact `token` may fold a recovery result back in (see `applyRecovery`). The
 * token is minted inside `MemoryRateBudget` / `RateBudgetDO`, never taken from
 * request input.
 */
export interface RecoveryLease {
  token: string;
  startedAtMs: number;
}

/** Coordinated state: authoritative budget + outstanding reservations + recovery marker. */
export interface BudgetSnapshot {
  /** `null` = unknown; assessments are blocked until `GET /rate_limit` recovery. */
  authoritative: RateBudgetState | null;
  reservations: Reservation[];
  /**
   * The current recovery election, or `null` if none is in flight. Single-flight
   * + owner-token gated. `normalize` clears a lease older than `RECOVERY_TTL_MS`
   * so a crashed elector cannot block recovery forever.
   */
  recovery: RecoveryLease | null;
  /**
   * Epoch-ms before which NO recovery may be elected and NO assessment admitted.
   * Set by a failed / secondary-limited recovery; `null` = no backoff. Cleared
   * only by the passage of time (`normalize`) or a successful current-owner
   * recovery. Deliberately survives a primary-window reset.
   */
  recoveryNotBeforeMs: number | null;
}

export type ReserveDecision =
  | { ok: true; reservationId: string }
  /** Budget unknown and you are elected: run `GET /rate_limit`, then `recover(recoveryToken, ...)`. */
  | { ok: false; recover: true; recoveryToken: string; retryAfterMs: number }
  /** Blocked: below the floor, waiting on another caller's recovery, or in backoff. */
  | { ok: false; retryAfterMs: number };

/** How a reservation's live call turned out. See the module doc. */
export type Reconciliation =
  | { outcome: "observed"; rateLimit: RateBudgetState }
  | { outcome: "indeterminate" }
  | { outcome: "not-sent" };

/** Outcome of an elected `GET /rate_limit` authoritative recovery. */
export type RecoveryResult =
  /** `GET /rate_limit` succeeded — `resources.graphql` mapped to a budget state. */
  | { outcome: "observed"; rateLimit: RateBudgetState }
  /**
   * `GET /rate_limit` failed / was secondary-limited — budget stays unknown.
   * `retryAfterMs` (when known, e.g. a secondary-limit `Retry-After`) is
   * persisted as the recovery backoff; otherwise `FALLBACK_RETRY_MS` is used.
   */
  | { outcome: "failed"; retryAfterMs?: number };

export interface RateBudget {
  /** Atomically reserve headroom for one live GitHub call. Never rejects. */
  reserveLiveCall(nowMs: number): Promise<ReserveDecision>;
  /** Settle a reservation. May reject (store failure) — caller must not retry inline. */
  reconcile(reservationId: string, result: Reconciliation, nowMs: number): Promise<void>;
  /**
   * Feed back the result of an elected `GET /rate_limit` recovery. `recoveryToken`
   * MUST be the value handed out by the matching `reserveLiveCall` election; a
   * stale / wrong token is a no-op. May reject (store failure) — the caller
   * treats that like a failed recovery.
   */
  recover(recoveryToken: string, result: RecoveryResult, nowMs: number): Promise<void>;
}

/**
 * Floor on the reserved GraphQL point cost of one assessment.
 *
 * Evidence: `signals.rateLimit.cost` is **1** for every one of the 23 recorded
 * real GitHub responses (`test/fixtures/raw/*.json`), and the IssueViability
 * query is a single, non-paginated GraphQL request (`tryGraphQL` sends exactly
 * one POST; no retry, no pagination), so the maximum GraphQL points one
 * admitted assessment can consume is 1. The REST fallback
 * (`fetchSignals` -> `tryRest`) draws GitHub's *separate* REST request bucket,
 * which this GraphQL-points floor does not govern (see limitation #9). `GET
 * /rate_limit` recovery seeds `cost` at this floor; `reservationCost()` still
 * takes `max(this, lastObservedCost)`, so a future query change that raises the
 * reported `cost` widens every subsequent reservation automatically.
 */
export const RESERVATION_COST_FLOOR = 1;

/**
 * A `GET /rate_limit` recovery election older than this is treated as abandoned
 * (the elected caller crashed / the request hung) and a fresh caller may be
 * elected with a NEW token. Comfortably longer than one `GET /rate_limit`
 * attempt + overhead (the default `fetchRateLimit` timeout is 6 s).
 */
export const RECOVERY_TTL_MS = 15_000;

/** Retry-After handed to callers waiting on an in-flight recovery. */
export const PROBE_RETRY_MS = 1_000;

/** Retry-After when a backing store fails, or a recovery failed with no server hint. */
export const FALLBACK_RETRY_MS = 60_000;

/** Reserved point cost per in-flight assessment. */
export function reservationCost(authoritative: RateBudgetState | null): number {
  return Math.max(RESERVATION_COST_FLOOR, authoritative?.cost ?? 0);
}

/**
 * Bring a snapshot up to date for `nowMs`. Pure.
 *
 *  - A recovery lease older than `RECOVERY_TTL_MS` is dropped (abandoned
 *    election). A `recoveryNotBeforeMs` in the past is cleared (backoff elapsed).
 *  - Budget UNKNOWN (`authoritative === null`): there are no valid reservations
 *    (none is ever admitted without a known window) and no assessment is
 *    admitted until `GET /rate_limit` recovery.
 *  - Budget KNOWN, window still open: every outstanding reservation is HELD to
 *    the reset (fail closed). Once a live call has been reserved the GitHub
 *    request may already have been dispatched and charged; a short TTL that
 *    released it here would let a stale-high `remaining` re-admit calls and
 *    bypass the floor. The reset window bounds the over-block.
 *  - Budget KNOWN, window elapsed: the budget has refilled but must be
 *    re-learned authoritatively — drop to UNKNOWN, discard the now-moot
 *    pre-reset reservations, and require a fresh `GET /rate_limit`. Any
 *    `recoveryNotBeforeMs` still in the future is preserved across the reset.
 */
export function normalize(snap: BudgetSnapshot, nowMs: number): BudgetSnapshot {
  let recovery = snap.recovery;
  if (recovery !== null && nowMs - recovery.startedAtMs >= RECOVERY_TTL_MS) {
    recovery = null; // abandoned election — allow a fresh one (new token)
  }

  let recoveryNotBeforeMs = snap.recoveryNotBeforeMs;
  if (recoveryNotBeforeMs !== null && nowMs >= recoveryNotBeforeMs) {
    recoveryNotBeforeMs = null; // backoff elapsed
  }

  const authoritative = snap.authoritative;
  if (authoritative === null || nowMs >= authoritative.resetAtMs) {
    return { authoritative: null, reservations: [], recovery, recoveryNotBeforeMs };
  }
  return { authoritative, reservations: snap.reservations, recovery, recoveryNotBeforeMs };
}

/**
 * Decide admission for `reservationId` and return the snapshot to persist. Pure.
 *
 * While the budget is unknown this NEVER returns `{ ok: true }`:
 *  - in a recovery backoff -> block with a conservative retry, elect no one;
 *  - otherwise elect exactly one caller (`recover: true`, carrying
 *    `recoveryToken`) and block the rest.
 *
 * `recoveryToken` is supplied by the caller (the impl mints a collision-
 * resistant id, like `reservationId`); it is only used if this call is the one
 * that opens a new election.
 */
export function admit(
  snap: BudgetSnapshot,
  nowMs: number,
  reservationId: string,
  recoveryToken: string,
): { decision: ReserveDecision; next: BudgetSnapshot } {
  const s = normalize(snap, nowMs);

  if (s.authoritative === null) {
    // In a persisted recovery backoff: elect no one, admit nothing.
    if (s.recoveryNotBeforeMs !== null) {
      return {
        decision: { ok: false, retryAfterMs: Math.max(1_000, s.recoveryNotBeforeMs - nowMs) },
        next: s,
      };
    }
    // No election in flight: open one, minted with this caller's token.
    if (s.recovery === null) {
      return {
        decision: { ok: false, recover: true, recoveryToken, retryAfterMs: PROBE_RETRY_MS },
        next: { ...s, recovery: { token: recoveryToken, startedAtMs: nowMs } },
      };
    }
    // Someone else already owns the election.
    return { decision: { ok: false, retryAfterMs: PROBE_RETRY_MS }, next: s };
  }

  const cost = reservationCost(s.authoritative);
  const outstanding = s.reservations.length;
  const projected = s.authoritative.remaining - (outstanding + 1) * cost;
  if (projected >= CONFIG.RATE_LIMIT_FLOOR) {
    return {
      decision: { ok: true, reservationId },
      next: {
        ...s,
        reservations: [
          ...s.reservations,
          { id: reservationId, createdAtMs: nowMs, indeterminate: false },
        ],
      },
    };
  }
  return {
    decision: { ok: false, retryAfterMs: Math.max(1_000, s.authoritative.resetAtMs - nowMs) },
    next: s,
  };
}

/**
 * Settle a reservation. Pure.
 *
 *  - `indeterminate` -> mark the reservation (keep its debit); `normalize`
 *    holds it to the window reset.
 *  - `observed` / `not-sent` -> release the reservation; `observed` also folds
 *    the authoritative value in monotonically and reset-window aware:
 *      * strictly newer -> adopt it, drop now-superseded indeterminate debits
 *      * same/older-or-ambiguous -> `min(remaining, resetAtMs)` and
 *        `max(cost)`; GitHub's reset timestamp is not a unique window ID
 */
export function applyReconcile(
  snap: BudgetSnapshot,
  reservationId: string,
  result: Reconciliation,
  nowMs: number,
): BudgetSnapshot {
  const s = normalize(snap, nowMs);

  if (result.outcome === "indeterminate") {
    return {
      authoritative: s.authoritative,
      reservations: s.reservations.map((r) =>
        r.id === reservationId ? { ...r, indeterminate: true } : r,
      ),
      recovery: s.recovery,
      recoveryNotBeforeMs: s.recoveryNotBeforeMs,
    };
  }

  const reservations = s.reservations.filter((r) => r.id !== reservationId);
  let authoritative = s.authoritative;

  if (result.outcome === "observed") {
    const observed = result.rateLimit;
    if (nowMs < observed.resetAtMs) {
      if (authoritative === null || observed.resetAtMs > authoritative.resetAtMs) {
        // First observation, or a strictly newer window: adopt it, and drop
        // indeterminate debits from the now-superseded window.
        return {
          authoritative: { ...observed },
          reservations: reservations.filter((r) => !r.indeterminate),
          recovery: s.recovery,
          recoveryNotBeforeMs: s.recoveryNotBeforeMs,
        };
      } else {
        // A lower reset timestamp is not proof of an older GraphQL window:
        // GitHub has returned a later timestamp from GET /rate_limit than from
        // the immediately following successful GraphQL response in one live
        // window. Dropping that response would release its reservation while
        // retaining a stale-high remaining value, which can over-admit. Fold
        // all non-newer observations downward instead. A genuinely old delayed
        // response may over-block or trigger an early recovery, but cannot
        // create a false admission.
        authoritative = {
          remaining: Math.min(authoritative.remaining, observed.remaining), // monotonic down
          resetAtMs: Math.min(authoritative.resetAtMs, observed.resetAtMs),
          cost: Math.max(authoritative.cost, observed.cost),
        };
      }
    }
  }
  return {
    authoritative,
    reservations,
    recovery: s.recovery,
    recoveryNotBeforeMs: s.recoveryNotBeforeMs,
  };
}

/**
 * Fold an elected `GET /rate_limit` recovery result into the snapshot. Pure.
 *
 * OWNER-TOKEN GATE. If `recoveryToken` is not the current lease token (the lease
 * expired and someone else was elected, or it was already cleared), this is a
 * complete no-op: a stale caller cannot overwrite the budget, clear another
 * owner's lease, or change the backoff.
 *
 * For the CURRENT owner:
 *  - `failed`   -> clear the lease; persist
 *                  `recoveryNotBeforeMs = now + (result.retryAfterMs ?? FALLBACK_RETRY_MS)`;
 *                  budget stays UNKNOWN; NO assessment admitted until it elapses.
 *  - `observed`, window already elapsed -> discard (stays UNKNOWN), clear lease,
 *                  keep any existing backoff.
 *  - `observed`, live window -> fold in monotonically (same rules as
 *                  `applyReconcile`'s `observed`: a newer window is adopted;
 *                  every non-newer observation can only lower remaining/reset
 *                  and raise cost), clear the lease, and clear `recoveryNotBeforeMs`
 *                  (a healthy authoritative read supersedes any prior backoff).
 *
 * CONSERVATIVE RESERVATION HANDLING. A recovery result NEVER erases outstanding
 * reservations — it only ever ADDS them to what it debits. In the supported flow
 * there are no reservations at recovery time (none is admitted without a known
 * window, and `normalize` clears them on reset), so this is a defensive
 * guarantee rather than a routine path.
 */
export function applyRecovery(
  snap: BudgetSnapshot,
  recoveryToken: string,
  result: RecoveryResult,
  nowMs: number,
): BudgetSnapshot {
  const s = normalize(snap, nowMs);

  if (s.recovery === null || s.recovery.token !== recoveryToken) {
    return s; // stale / wrong / already-cleared token — inert
  }

  if (result.outcome === "failed") {
    const backoff = result.retryAfterMs !== undefined ? result.retryAfterMs : FALLBACK_RETRY_MS;
    return {
      authoritative: s.authoritative,
      reservations: s.reservations,
      recovery: null,
      recoveryNotBeforeMs: nowMs + Math.max(1_000, backoff),
    };
  }

  const observed = result.rateLimit;
  if (nowMs >= observed.resetAtMs) {
    // A stale / skewed snapshot — ignore it for the budget (mirrors
    // `applyReconcile`: an already-expired observation is not evidence). The
    // lease is done; any backoff is left as-is (this was not a healthy read).
    return {
      authoritative: s.authoritative,
      reservations: s.reservations,
      recovery: null,
      recoveryNotBeforeMs: s.recoveryNotBeforeMs,
    };
  }

  let authoritative = s.authoritative;
  if (authoritative === null || observed.resetAtMs > authoritative.resetAtMs) {
    authoritative = { ...observed }; // first learn, or a strictly newer window
  } else {
    authoritative = {
      remaining: Math.min(authoritative.remaining, observed.remaining), // never up
      resetAtMs: Math.min(authoritative.resetAtMs, observed.resetAtMs),
      cost: Math.max(authoritative.cost, observed.cost), // never down
    };
  }

  return {
    authoritative,
    reservations: s.reservations,
    recovery: null,
    recoveryNotBeforeMs: null, // a healthy current-owner read supersedes any backoff
  };
}

/**
 * Process-local implementation — one instance per app, good for `npm run dev`.
 * A single Node process is its own serialization boundary (no true parallelism
 * between the `await`s), so mutating the snapshot in place is safe here.
 */
export class MemoryRateBudget implements RateBudget {
  #snap: BudgetSnapshot;

  /**
   * @param initial optional already-known budget (e.g. restored from a snapshot,
   *   or supplied by a test that is not exercising authoritative recovery). When
   *   omitted the budget starts UNKNOWN, so the first `reserveLiveCall` elects a
   *   `GET /rate_limit` recovery — the real server's cold-start behaviour.
   */
  constructor(initial: RateBudgetState | null = null) {
    this.#snap = {
      authoritative: initial,
      reservations: [],
      recovery: null,
      recoveryNotBeforeMs: null,
    };
  }

  async reserveLiveCall(nowMs: number): Promise<ReserveDecision> {
    const { decision, next } = admit(this.#snap, nowMs, crypto.randomUUID(), crypto.randomUUID());
    this.#snap = next;
    return decision;
  }

  async reconcile(reservationId: string, result: Reconciliation, nowMs: number): Promise<void> {
    this.#snap = applyReconcile(this.#snap, reservationId, result, nowMs);
  }

  async recover(recoveryToken: string, result: RecoveryResult, nowMs: number): Promise<void> {
    this.#snap = applyRecovery(this.#snap, recoveryToken, result, nowMs);
  }

  /** Test-only view of the coordinated state. */
  snapshot(): BudgetSnapshot {
    return {
      authoritative: this.#snap.authoritative,
      reservations: [...this.#snap.reservations],
      recovery: this.#snap.recovery ? { ...this.#snap.recovery } : null,
      recoveryNotBeforeMs: this.#snap.recoveryNotBeforeMs,
    };
  }
}
