/**
 * The atomic-reservation rate budget + authoritative-recovery accounting.
 *
 * Covers the pure decision fns, `MemoryRateBudget`, the Durable-Object class
 * against an in-memory SQL fake, the fail-closed adapter, the concurrency /
 * out-of-order scenarios from Codex review 1, the indeterminate-attempt
 * scenarios from review 2, and the `GET /rate_limit` authoritative-recovery
 * model from review 3 (no chargeable discovery probe).
 */
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { CONFIG } from "../src/config.ts";
import {
  FALLBACK_RETRY_MS,
  MemoryRateBudget,
  PROBE_RETRY_MS,
  RECOVERY_TTL_MS,
  admit,
  applyReconcile,
  applyRecovery,
  normalize,
  reservationCost,
  type BudgetSnapshot,
  type Reconciliation,
  type RateBudgetState,
  type RecoveryResult,
} from "../src/rate-budget.ts";
import { RateBudgetDO, durableObjectRateBudget } from "../src/worker/rate-budget-do.ts";
// Resolves to `test/shims/cloudflare-workers.mjs` under `node:test` (see the
// `--import` in `package.json`); the real module only exists in workerd.
import { DurableObject } from "cloudflare:workers";

const T = 1_000_000_000_000;
const HOUR = 3_600_000;
const FLOOR = CONFIG.RATE_LIMIT_FLOOR; // 150
const win = (remaining: number, resetAtMs = T + HOUR, cost = 1): RateBudgetState => ({
  remaining,
  resetAtMs,
  cost,
});
const obs = (state: RateBudgetState): Reconciliation => ({ outcome: "observed", rateLimit: state });
const IND: Reconciliation = { outcome: "indeterminate" };
const NOT_SENT: Reconciliation = { outcome: "not-sent" };
const recOk = (state: RateBudgetState): RecoveryResult => ({ outcome: "observed", rateLimit: state });
const REC_FAIL: RecoveryResult = { outcome: "failed" };
const empty = (): BudgetSnapshot => ({
  authoritative: null,
  reservations: [],
  recovery: null,
  recoveryNotBeforeMs: null,
});
const lease = (token = "lease-tok", startedAtMs = T): BudgetSnapshot["recovery"] => ({
  token,
  startedAtMs,
});
const snap = (
  authoritative: RateBudgetState | null,
  reservations: BudgetSnapshot["reservations"] = [],
  recovery: BudgetSnapshot["recovery"] = null,
  recoveryNotBeforeMs: number | null = null,
): BudgetSnapshot => ({ authoritative, reservations, recovery, recoveryNotBeforeMs });

/** Seed a known budget the way the app does: election -> GET /rate_limit -> recover. */
async function seed(b: MemoryRateBudget, state: RateBudgetState, now = T) {
  const d = await b.reserveLiveCall(now);
  if (d.ok || !("recover" in d)) throw new Error("expected a recovery election");
  await b.recover(d.recoveryToken, recOk(state), now);
}
async function seedDO(doInst: RateBudgetDO, state: RateBudgetState, now = T) {
  const d = await doInst.reserveLiveCall(now);
  if (d.ok || !("recover" in d)) throw new Error("expected a recovery election");
  await doInst.recover(d.recoveryToken, recOk(state), now);
}

describe("reservationCost", () => {
  it("is the floor (1) until a higher cost is observed, then tracks it up", () => {
    expect(reservationCost(null)).toBe(1);
    expect(reservationCost(win(500, T + HOUR, 1))).toBe(1);
    expect(reservationCost(win(500, T + HOUR, 4))).toBe(4);
  });
});

describe("admit() / applyReconcile() / normalize() — pure", () => {
  it("unknown budget: elects exactly one caller to recover, blocks the rest — never admits", () => {
    const a1 = admit(empty(), T, "r1", "tok1");
    expect(a1.decision).toEqual({
      ok: false,
      recover: true,
      recoveryToken: "tok1",
      retryAfterMs: PROBE_RETRY_MS,
    });
    expect(a1.next.recovery).toEqual({ token: "tok1", startedAtMs: T });
    expect(a1.next.reservations).toEqual([]); // no chargeable reservation is created
    const a2 = admit(a1.next, T, "r2", "tok2");
    expect(a2.decision).toEqual({ ok: false, retryAfterMs: PROBE_RETRY_MS });
    expect("recover" in a2.decision).toBe(false);
  });

  it("known budget: admits while projected remaining stays at/above the floor", () => {
    const a1 = admit(snap(win(FLOOR + 1)), T, "r1", "tok1"); // 151 - 1 = 150 -> ok
    expect(a1.decision.ok).toBe(true);
    const a2 = admit(a1.next, T, "r2", "tok2"); // 151 - 2 = 149 -> blocked
    expect(a2.decision.ok).toBe(false);
    expect("recover" in a2.decision).toBe(false); // a known-budget block is not a recovery
  });

  it("observed: monotonic-down within a window; a delayed higher value cannot reopen", () => {
    let s = snap(win(160), [
      { id: "a", createdAtMs: T, indeterminate: false },
      { id: "b", createdAtMs: T, indeterminate: false },
    ]);
    s = applyReconcile(s, "b", obs(win(149)), T);
    expect(s.authoritative!.remaining).toBe(149);
    s = applyReconcile(s, "a", obs(win(151)), T);
    expect(s.authoritative!.remaining).toBe(149);
    expect(s.reservations).toHaveLength(0);
  });

  it("observed: never discards a lower remaining count merely because GitHub reports an earlier reset", () => {
    const base = snap(win(200, T + HOUR), [{ id: "x", createdAtMs: T, indeterminate: false }]);
    // An already-expired observation is not usable evidence at all.
    expect(applyReconcile(base, "x", obs(win(5, T - 1000)), T).authoritative).toEqual(win(200, T + HOUR));
    // GitHub has returned this shape for one live window: GET /rate_limit gives
    // a later reset and the immediately-following GraphQL result gives a lower
    // remaining with an earlier reset. Releasing x while retaining 200 would
    // over-admit; non-newer data must fold downward.
    expect(applyReconcile(base, "x", obs(win(199, T + HOUR - 1000)), T).authoritative).toEqual(
      win(199, T + HOUR - 1000),
    );
    expect(applyReconcile(base, "x", obs(win(4000, T + 2 * HOUR)), T).authoritative).toEqual(
      win(4000, T + 2 * HOUR),
    );
  });

  it("earlier-reset GraphQL observations cannot over-admit at the rate-limit floor", () => {
    const initial = snap(win(FLOOR + 1, T + HOUR));
    const admitted = admit(initial, T, "r1", "tok1");
    if (!admitted.decision.ok) throw new Error("setup");
    // Before the fix this lower reset made applyReconcile ignore the real 150
    // remaining and release r1, leaving 151; a second call was admitted even
    // though it would take GitHub below the 150 floor.
    const reconciled = applyReconcile(
      admitted.next,
      "r1",
      obs(win(FLOOR, T + HOUR - 1000)),
      T,
    );
    expect(reconciled.authoritative).toEqual(win(FLOOR, T + HOUR - 1000));
    expect(admit(reconciled, T, "r2", "tok2").decision.ok).toBe(false);
  });

  it("indeterminate: keeps the reservation, marks it, no budget change", () => {
    const next = applyReconcile(
      snap(win(5000), [{ id: "a", createdAtMs: T, indeterminate: false }]),
      "a",
      IND,
      T,
    );
    expect(next.authoritative).toEqual(win(5000));
    expect(next.reservations).toEqual([{ id: "a", createdAtMs: T, indeterminate: true }]);
  });

  it("not-sent: releases the reservation, no budget change", () => {
    const next = applyReconcile(
      snap(win(5000), [{ id: "a", createdAtMs: T, indeterminate: false }]),
      "a",
      NOT_SENT,
      T,
    );
    expect(next.reservations).toHaveLength(0);
    expect(next.authoritative).toEqual(win(5000));
  });

  it("normalize: a known window past its reset drops to UNKNOWN and wipes reservations", () => {
    const s = snap(win(10, T + 1000), [{ id: "a", createdAtMs: T, indeterminate: true }]);
    expect(normalize(s, T + 1001)).toEqual({
      authoritative: null,
      reservations: [],
      recovery: null,
      recoveryNotBeforeMs: null,
    });
  });

  it("normalize: a recovery backoff still in the future is preserved across a window reset", () => {
    const s = snap(win(10, T + 1000), [], null, T + 5000);
    const n = normalize(s, T + 1001); // window elapsed, but backoff has not
    expect(n.authoritative).toBeNull();
    expect(n.recoveryNotBeforeMs).toBe(T + 5000);
    // ...and it clears once its own deadline passes
    expect(normalize(s, T + 5001).recoveryNotBeforeMs).toBeNull();
  });

  it("normalize: with a known window, NO reservation expires on a TTL — held to the reset (fail closed)", () => {
    const s = snap(win(5000, T + HOUR), [
      { id: "plain", createdAtMs: T - HOUR, indeterminate: false },
      { id: "ind", createdAtMs: T - HOUR, indeterminate: true },
    ]);
    // A possibly-dispatched GitHub request must keep its debit until the window
    // resets; a short TTL here would let stale-high `remaining` re-admit calls.
    expect(normalize(s, T).reservations.map((r) => r.id)).toEqual(["plain", "ind"]);
    // ...and the window-reset branch still clears them all at resetAt.
    expect(normalize(s, T + HOUR).reservations).toHaveLength(0);
  });

  it("normalize: while the budget is UNKNOWN there are never any reservations", () => {
    const s = snap(null, [{ id: "orphan", createdAtMs: T, indeterminate: false }], null);
    expect(normalize(s, T).reservations).toHaveLength(0);
  });

  it("normalize: an abandoned recovery election (older than RECOVERY_TTL_MS) is cleared", () => {
    const s = snap(null, [], lease("t", T));
    expect(normalize(s, T + RECOVERY_TTL_MS - 1).recovery).toEqual({ token: "t", startedAtMs: T });
    expect(normalize(s, T + RECOVERY_TTL_MS + 1).recovery).toBeNull();
  });

  it("observed newer window supersedes old-window indeterminate debits", () => {
    const s = snap(win(50, T + HOUR), [
      { id: "ind", createdAtMs: T, indeterminate: true },
      { id: "live", createdAtMs: T, indeterminate: false },
    ]);
    const next = applyReconcile(s, "other", obs(win(5000, T + 2 * HOUR)), T);
    expect(next.authoritative).toEqual(win(5000, T + 2 * HOUR));
    expect(next.reservations.map((r) => r.id)).toEqual(["live"]); // indeterminate dropped
  });
});

describe("applyRecovery() — pure", () => {
  const TOK = "owner-token";
  const electing = (now = T): BudgetSnapshot => snap(null, [], lease(TOK, now));

  it("observed (current owner): adopts the authoritative budget and clears the election", () => {
    const next = applyRecovery(electing(), TOK, recOk(win(3000, T + HOUR)), T);
    expect(next.authoritative).toEqual(win(3000, T + HOUR));
    expect(next.recovery).toBeNull();
    expect(next.recoveryNotBeforeMs).toBeNull();
  });

  it("failed (current owner): budget stays UNKNOWN, lease cleared, backoff persisted", () => {
    const next = applyRecovery(electing(), TOK, REC_FAIL, T);
    expect(next.authoritative).toBeNull();
    expect(next.reservations).toHaveLength(0);
    expect(next.recovery).toBeNull();
    expect(next.recoveryNotBeforeMs).toBe(T + FALLBACK_RETRY_MS);
  });

  it("failed with a server hint: persists exactly that backoff", () => {
    const next = applyRecovery(electing(), TOK, { outcome: "failed", retryAfterMs: 120_000 }, T);
    expect(next.recoveryNotBeforeMs).toBe(T + 120_000);
  });

  it("observed but already expired: not adopted, stays UNKNOWN, lease cleared", () => {
    const next = applyRecovery(electing(), TOK, recOk(win(3000, T - 1)), T);
    expect(next.authoritative).toBeNull();
    expect(next.recovery).toBeNull();
  });

  it("does not fabricate admission capacity — reservations stay empty in the unknown state", () => {
    const s = snap(null, [{ id: "x", createdAtMs: T, indeterminate: true }], lease(TOK, T));
    const next = applyRecovery(s, TOK, recOk(win(3000, T + HOUR)), T);
    expect(next.authoritative).toEqual(win(3000, T + HOUR));
    expect(next.reservations).toHaveLength(0);
  });

  it("wrong / missing / stale token: complete no-op (cannot touch budget, lease, or backoff)", () => {
    const owned = snap(null, [], lease("B-token", T + RECOVERY_TTL_MS), T + 999_999);
    // a caller holding A's expired token
    expect(applyRecovery(owned, "A-token", recOk(win(9999, T + HOUR)), T + RECOVERY_TTL_MS)).toEqual(
      normalize(owned, T + RECOVERY_TTL_MS),
    );
    // A's failure also cannot set/clear anything
    expect(applyRecovery(owned, "A-token", REC_FAIL, T + RECOVERY_TTL_MS).recoveryNotBeforeMs).toBe(
      T + 999_999,
    );
    // no lease at all -> still inert
    expect(applyRecovery(snap(null, [], null), "any", recOk(win(1, T + HOUR)), T).authoritative).toBeNull();
  });

  it("stale A returning 151/W cannot overwrite current-owner B's 149/W", () => {
    // B is the current owner and has already folded in 149/W.
    const afterB = applyRecovery(electing(), TOK, recOk(win(149, T + HOUR)), T);
    expect(afterB.authoritative!.remaining).toBe(149);
    expect(afterB.recovery).toBeNull();
    // Delayed A (different, now-stale token) reports a higher 151/W.
    const afterStaleA = applyRecovery(afterB, "A-token", recOk(win(151, T + HOUR)), T);
    expect(afterStaleA.authoritative!.remaining).toBe(149); // unchanged — no reopen
  });

  it("current-owner observed folds monotonically: same window min, cost never down", () => {
    const s = snap(win(149, T + HOUR, 4), [], lease(TOK, T));
    const next = applyRecovery(s, TOK, recOk(win(151, T + HOUR, 1)), T);
    expect(next.authoritative).toEqual({ remaining: 149, resetAtMs: T + HOUR, cost: 4 });
  });

  it("current-owner observed: expired data is ignored, a live earlier reset folds down, newer window adopted", () => {
    const base = snap(win(200, T + HOUR), [], lease(TOK, T));
    expect(applyRecovery(base, TOK, recOk(win(5, T - 1000)), T).authoritative).toEqual(
      win(200, T + HOUR),
    );
    expect(applyRecovery(base, TOK, recOk(win(199, T + HOUR - 1000)), T).authoritative).toEqual(
      win(199, T + HOUR - 1000),
    );
    expect(applyRecovery(base, TOK, recOk(win(4000, T + 2 * HOUR)), T).authoritative).toEqual(
      win(4000, T + 2 * HOUR),
    );
  });
});

describe("recovery backoff — admit() blocks recovery + assessments until it elapses (round 4)", () => {
  it("during a backoff, admit elects nobody and admits nothing; after it, exactly one election", () => {
    const s = snap(null, [], null, T + 30_000); // backoff for 30s, no lease
    const during = admit(s, T + 10_000, "r1", "tok1");
    expect(during.decision).toEqual({ ok: false, retryAfterMs: 20_000 });
    expect("recover" in during.decision).toBe(false);
    expect(during.next.recovery).toBeNull(); // no election opened

    // 20 callers during the backoff -> zero elections
    let s2 = s;
    for (let i = 0; i < 20; i++) {
      const a = admit(s2, T + 10_000, `r${i}`, `tok${i}`);
      expect(a.decision.ok).toBe(false);
      expect("recover" in a.decision).toBe(false);
      s2 = a.next;
    }
    expect(s2.recovery).toBeNull();

    // once the deadline passes, the next caller is elected exactly once
    const after1 = admit(s2, T + 30_001, "rA", "tokA");
    expect("recover" in after1.decision).toBe(true);
    const after2 = admit(after1.next, T + 30_002, "rB", "tokB");
    expect("recover" in after2.decision).toBe(false);
  });
});

describe("MemoryRateBudget — concurrency & out-of-order (review 1)", () => {
  it("concurrent admission: remaining 151, floor 150 -> first ok, second blocked", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(FLOOR + 1));
    expect((await b.reserveLiveCall(T)).ok).toBe(true);
    expect((await b.reserveLiveCall(T)).ok).toBe(false);
  });

  it("many concurrent cache misses: exactly floor-worth are granted", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(155)); // 155 - 5 = 150
    let granted = 0;
    for (let i = 0; i < 10; i++) if ((await b.reserveLiveCall(T)).ok) granted++;
    expect(granted).toBe(5);
  });

  it("50 reservations fired in parallel still respect the floor", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(155));
    const results = await Promise.all(Array.from({ length: 50 }, () => b.reserveLiveCall(T)));
    expect(results.filter((r) => r.ok).length).toBe(5);
  });

  it("9. reversed response order: later 149 then delayed 151 -> stays blocked at 149", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(160));
    const rA = await b.reserveLiveCall(T);
    const rB = await b.reserveLiveCall(T);
    if (!rA.ok || !rB.ok) throw new Error("setup");
    await b.reconcile(rB.reservationId, obs(win(149)), T);
    await b.reconcile(rA.reservationId, obs(win(151)), T);
    expect(b.snapshot().authoritative!.remaining).toBe(149);
    expect((await b.reserveLiveCall(T)).ok).toBe(false);
  });

  it("10. cross-reset late response: an older window never overwrites the current one", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(200, T + HOUR));
    const rOld = await b.reserveLiveCall(T);
    if (!rOld.ok) throw new Error("setup");
    await b.reconcile(rOld.reservationId, obs(win(5, T - 1000)), T);
    expect(b.snapshot().authoritative).toEqual(win(200, T + HOUR));
  });

  it("11. successful reserve -> observe -> reconcile still functions across many cycles", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(5000));
    for (let i = 0; i < 20; i++) {
      const r = await b.reserveLiveCall(T + i);
      expect(r.ok).toBe(true);
      if (r.ok) await b.reconcile(r.reservationId, obs(win(5000 - i - 1)), T + i);
    }
    expect(b.snapshot().reservations).toHaveLength(0);
  });
});

describe("MemoryRateBudget — authoritative recovery & indeterminate accounting (review 3)", () => {
  it("3. cold start performs at most ONE recovery election before any assessment", async () => {
    const b = new MemoryRateBudget();
    const first = await b.reserveLiveCall(T);
    expect(first.ok).toBe(false);
    if (first.ok || !("recover" in first)) throw new Error("expected election");
    // No assessment is admitted while unknown, even repeatedly.
    for (let i = 0; i < 5; i++) {
      const d = await b.reserveLiveCall(T + i);
      expect(d.ok).toBe(false);
      expect("recover" in d).toBe(false); // only the first caller is elected
    }
    await b.recover(first.recoveryToken, recOk(win(5000, T + HOUR)), T);
    expect((await b.reserveLiveCall(T)).ok).toBe(true); // now assessments flow
  });

  it("4. 20 concurrent cold-start callers -> exactly one recovery election", async () => {
    const b = new MemoryRateBudget();
    const decisions = await Promise.all(Array.from({ length: 20 }, () => b.reserveLiveCall(T)));
    const elected = decisions.filter((d) => !d.ok && "recover" in d);
    expect(elected).toHaveLength(1);
    expect(decisions.every((d) => !d.ok)).toBe(true); // nobody was admitted
  });

  it("5. a failed recovery admits ZERO assessments and holds a backoff before re-electing", async () => {
    const b = new MemoryRateBudget();
    const e1 = await b.reserveLiveCall(T);
    if (e1.ok || !("recover" in e1)) throw new Error("expected election");
    await b.recover(e1.recoveryToken, REC_FAIL, T);
    expect(b.snapshot().authoritative).toBeNull(); // still unknown
    expect(b.snapshot().recoveryNotBeforeMs).toBe(T + FALLBACK_RETRY_MS);

    // During the backoff: blocked, and NOT re-elected (no fresh GET /rate_limit).
    const during = await b.reserveLiveCall(T + 1);
    expect(during.ok).toBe(false);
    expect("recover" in during).toBe(false);

    // After the backoff elapses: exactly one fresh election.
    const after = await b.reserveLiveCall(T + FALLBACK_RETRY_MS + 1);
    expect(after.ok).toBe(false);
    expect("recover" in after).toBe(true);
  });

  it("5b. a stale recovery token cannot clear the current owner's lease or backoff", async () => {
    const b = new MemoryRateBudget();
    const e1 = await b.reserveLiveCall(T);
    if (e1.ok || !("recover" in e1)) throw new Error("expected election");
    // The elected caller stalls past the TTL; a fresh caller is re-elected.
    const e2 = await b.reserveLiveCall(T + RECOVERY_TTL_MS + 1);
    if (e2.ok || !("recover" in e2)) throw new Error("expected re-election");
    expect(e2.recoveryToken).not.toBe(e1.recoveryToken);
    // The stale first caller now fails — must be completely inert.
    await b.recover(e1.recoveryToken, REC_FAIL, T + RECOVERY_TTL_MS + 2);
    expect(b.snapshot().recovery!.token).toBe(e2.recoveryToken); // e2's lease intact
    expect(b.snapshot().recoveryNotBeforeMs).toBeNull(); // no backoff from the stale failure
    // e2 then succeeds normally.
    await b.recover(e2.recoveryToken, recOk(win(5000, T + HOUR)), T + RECOVERY_TTL_MS + 3);
    expect((await b.reserveLiveCall(T + RECOVERY_TTL_MS + 4)).ok).toBe(true);
  });

  it("an abandoned recovery election is re-elected only after RECOVERY_TTL_MS", async () => {
    const b = new MemoryRateBudget();
    const e1 = await b.reserveLiveCall(T);
    if (e1.ok || !("recover" in e1)) throw new Error("expected election");
    // elector crashed; no recover() call arrives
    expect("recover" in (await b.reserveLiveCall(T + RECOVERY_TTL_MS - 1))).toBe(false);
    expect("recover" in (await b.reserveLiveCall(T + RECOVERY_TTL_MS + 1))).toBe(true);
  });

  it("7. an old window's expiry requires a fresh recovery before any new assessment", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(5000, T + HOUR));
    expect((await b.reserveLiveCall(T)).ok).toBe(true); // assessments flow while known
    // window elapses -> next reserve is a recovery election, NOT an admission
    const afterReset = await b.reserveLiveCall(T + HOUR + 1);
    if (afterReset.ok || !("recover" in afterReset)) throw new Error("expected a recovery election");
    await b.recover(afterReset.recoveryToken, recOk(win(4000, T + 2 * HOUR)), T + HOUR + 1);
    expect((await b.reserveLiveCall(T + HOUR + 2)).ok).toBe(true);
  });

  it("1/2. ambiguous timeout / connection loss: the reservation is NOT released, capacity not restored", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(FLOOR + 1)); // 151
    const r1 = await b.reserveLiveCall(T); // 151 - 1 = 150 -> ok
    if (!r1.ok) throw new Error("setup");
    await b.reconcile(r1.reservationId, IND, T); // GitHub may have charged it
    expect(b.snapshot().reservations).toHaveLength(1); // still debiting
    expect((await b.reserveLiveCall(T)).ok).toBe(false); // 151 - (1 ind + 1) = 149 < 150
  });

  it("known window: an indeterminate debit is retained past any short interval, until reset", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(FLOOR + 1, T + HOUR)); // 151, resets in an hour
    const r1 = await b.reserveLiveCall(T);
    if (!r1.ok) throw new Error("setup");
    await b.reconcile(r1.reservationId, IND, T);
    expect((await b.reserveLiveCall(T + 1)).ok).toBe(false);
    expect((await b.reserveLiveCall(T + 5 * 60_000)).ok).toBe(false); // 5 min later: still blocked
    expect(b.snapshot().reservations).toHaveLength(1);
  });

  it("observed success after an indeterminate sibling still reconciles correctly", async () => {
    const b = new MemoryRateBudget();
    await seed(b, win(5000));
    const rInd = await b.reserveLiveCall(T);
    const rOk = await b.reserveLiveCall(T);
    if (!rInd.ok || !rOk.ok) throw new Error("setup");
    await b.reconcile(rInd.reservationId, IND, T);
    await b.reconcile(rOk.reservationId, obs(win(4998)), T); // monotonic down, same window
    const s = b.snapshot();
    expect(s.authoritative!.remaining).toBe(4998);
    expect(s.reservations.map((r) => r.indeterminate)).toEqual([true]); // only rInd remains
  });
});

/* --- in-memory SQL fake for the DO (budget_state / reservations / recovery / recovery_backoff) --- */
function fakeSql() {
  let budget: { remaining: number; reset_at_ms: number; cost: number } | null = null;
  let reservations: Array<{ id: string; created_at_ms: number; indeterminate: number }> = [];
  let recovery: { started_at_ms: number; token: string } | null = null;
  let recoveryBackoff: number | null = null;
  let failReservationInsert = false;
  let failRecoveryWrite = false;
  return {
    _peek: () => ({ budget, reservations: [...reservations], recovery, recoveryBackoff }),
    /** Make the next `INSERT INTO reservations` throw, to exercise rollback. */
    _failReservationInsert: (v: boolean) => {
      failReservationInsert = v;
    },
    /** Make the next recovery-lease/backoff write throw, to exercise rollback. */
    _failRecoveryWrite: (v: boolean) => {
      failRecoveryWrite = v;
    },
    /**
     * Cloudflare `transactionSync`: snapshot state, run the closure, and on any
     * throw restore the snapshot before rethrowing (all-or-nothing).
     */
    transactionSync<T>(closure: () => T): T {
      const savedBudget = budget ? { ...budget } : null;
      const savedReservations = reservations.map((r) => ({ ...r }));
      const savedRecovery = recovery ? { ...recovery } : null;
      const savedBackoff = recoveryBackoff;
      try {
        return closure();
      } catch (e) {
        budget = savedBudget;
        reservations = savedReservations;
        recovery = savedRecovery;
        recoveryBackoff = savedBackoff;
        throw e;
      }
    },
    exec(query: string, ...b: unknown[]) {
      const s = query.replace(/\s+/g, " ").trim();
      if (s.startsWith("CREATE TABLE")) return { toArray: () => [] };
      if (s.startsWith("SELECT remaining, reset_at_ms, cost FROM budget_state"))
        return { toArray: () => (budget ? [{ ...budget }] : []) };
      if (s.startsWith("SELECT id, created_at_ms, indeterminate FROM reservations"))
        return { toArray: () => reservations.map((r) => ({ ...r })) };
      if (s.startsWith("SELECT started_at_ms, token FROM recovery"))
        return { toArray: () => (recovery === null ? [] : [{ ...recovery }]) };
      if (s.startsWith("SELECT not_before_ms FROM recovery_backoff"))
        return { toArray: () => (recoveryBackoff === null ? [] : [{ not_before_ms: recoveryBackoff }]) };
      if (s.startsWith("INSERT INTO budget_state")) {
        budget = { remaining: Number(b[0]), reset_at_ms: Number(b[1]), cost: Number(b[2]) };
        return { toArray: () => [] };
      }
      if (s.startsWith("DELETE FROM budget_state")) {
        budget = null;
        return { toArray: () => [] };
      }
      if (s.startsWith("DELETE FROM reservations")) {
        reservations = [];
        return { toArray: () => [] };
      }
      if (s.startsWith("INSERT INTO reservations")) {
        if (failReservationInsert) throw new Error("fakeSql: simulated INSERT failure");
        reservations.push({ id: String(b[0]), created_at_ms: Number(b[1]), indeterminate: Number(b[2]) });
        return { toArray: () => [] };
      }
      if (s.startsWith("INSERT INTO recovery_backoff")) {
        if (failRecoveryWrite) throw new Error("fakeSql: simulated recovery_backoff INSERT failure");
        recoveryBackoff = Number(b[0]);
        return { toArray: () => [] };
      }
      if (s.startsWith("DELETE FROM recovery_backoff")) {
        recoveryBackoff = null;
        return { toArray: () => [] };
      }
      if (s.startsWith("INSERT INTO recovery")) {
        if (failRecoveryWrite) throw new Error("fakeSql: simulated recovery INSERT failure");
        recovery = { started_at_ms: Number(b[0]), token: String(b[1]) };
        return { toArray: () => [] };
      }
      if (s.startsWith("DELETE FROM recovery")) {
        recovery = null;
        return { toArray: () => [] };
      }
      throw new Error(`fakeSql: unhandled query: ${s}`);
    },
  };
}
const fakeState = (sql: ReturnType<typeof fakeSql>) => ({
  storage: { sql, transactionSync: sql.transactionSync },
});
/** Build the DO the way the runtime does: `new RateBudgetDO(ctx, env)`.
 *  `RateBudgetDO` binds no `env`, so `{}` stands in. */
const newDO = (sql: ReturnType<typeof fakeSql>) =>
  new RateBudgetDO(fakeState(sql) as any, {} as any);

describe("RateBudgetDO — Durable Object RPC eligibility", () => {
  it("extends the runtime DurableObject base so stub methods dispatch over RPC", () => {
    // A plain class is a fetch-only ("classic") DO: `stub.reserveLiveCall(...)`
    // then rejects, the adapter fails closed, and the app returns a spurious
    // "budget below the safe floor" 503. Extending `DurableObject` is the fix;
    // this guards against a silent revert.
    expect(RateBudgetDO.prototype instanceof DurableObject).toBe(true);
  });
});

describe("RateBudgetDO — parity with MemoryRateBudget over SQLite", () => {
  it("recovery election is persisted, single-flight across isolates, then adopted", async () => {
    const sql = fakeSql();
    const a = newDO(sql);
    const e1 = await a.reserveLiveCall(T);
    if (e1.ok || !("recover" in e1)) throw new Error("expected a recovery election");
    expect(sql._peek().recovery?.started_at_ms).toBe(T); // lease persisted
    expect(sql._peek().recovery?.token).toBe(e1.recoveryToken);

    const b = newDO(sql); // second isolate, same storage
    const e2 = await b.reserveLiveCall(T);
    expect(e2.ok).toBe(false);
    expect("recover" in e2).toBe(false); // not re-elected — single-flight

    await a.recover(e1.recoveryToken, recOk(win(FLOOR + 1, T + HOUR)), T);
    expect(sql._peek().recovery).toBeNull(); // lease cleared
    expect((await b.reserveLiveCall(T)).ok).toBe(true); // 151 - 1 = 150 -> admitted
  });

  it("10. a stale recovery token is inert across isolates; the current owner still resolves", async () => {
    const sql = fakeSql();
    const a = newDO(sql);
    const e1 = await a.reserveLiveCall(T);
    if (e1.ok || !("recover" in e1)) throw new Error("expected an election");

    // a's GET /rate_limit stalls past the TTL; a fresh isolate re-elects.
    const b = newDO(sql);
    const e2 = await b.reserveLiveCall(T + RECOVERY_TTL_MS + 1);
    if (e2.ok || !("recover" in e2)) throw new Error("expected a re-election");
    expect(e2.recoveryToken).not.toBe(e1.recoveryToken);

    // stale a fails -> completely inert (b's lease and a null backoff both intact)
    await a.recover(e1.recoveryToken, REC_FAIL, T + RECOVERY_TTL_MS + 2);
    expect(sql._peek().recovery?.token).toBe(e2.recoveryToken);
    expect(sql._peek().recoveryBackoff).toBeNull();

    // b resolves normally
    await b.recover(e2.recoveryToken, recOk(win(FLOOR + 1, T + HOUR)), T + RECOVERY_TTL_MS + 3);
    expect(sql._peek().recovery).toBeNull();
    expect((await a.reserveLiveCall(T + RECOVERY_TTL_MS + 4)).ok).toBe(true);
  });

  it("11. a failed recovery persists the backoff row transactionally; it gates the next callers", async () => {
    const sql = fakeSql();
    const doInst = newDO(sql);
    const e1 = await doInst.reserveLiveCall(T);
    if (e1.ok || !("recover" in e1)) throw new Error("expected an election");
    await doInst.recover(e1.recoveryToken, { outcome: "failed", retryAfterMs: 120_000 }, T);
    expect(sql._peek().recoveryBackoff).toBe(T + 120_000);
    expect(sql._peek().recovery).toBeNull();

    // during the backoff: blocked, not re-elected
    const during = await doInst.reserveLiveCall(T + 1000);
    expect(during.ok).toBe(false);
    expect("recover" in during).toBe(false);

    // after: one fresh election
    const after = await doInst.reserveLiveCall(T + 120_001);
    expect("recover" in after).toBe(true);
  });

  it("12. a SQL failure while writing the recovery lease rolls the whole #save back", async () => {
    const sql = fakeSql();
    const doInst = newDO(sql);
    sql._failRecoveryWrite(true);
    let threw = false;
    try {
      await doInst.reserveLiveCall(T); // election -> #save writes the lease -> fails
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(sql._peek().recovery).toBeNull(); // nothing partially persisted
    expect(sql._peek().recoveryBackoff).toBeNull();

    // fault clears -> a subsequent election persists cleanly
    sql._failRecoveryWrite(false);
    const e = await doInst.reserveLiveCall(T + 1);
    if (e.ok || !("recover" in e)) throw new Error("expected an election");
    expect(sql._peek().recovery?.token).toBe(e.recoveryToken);
  });

  it("concurrent admission + reversed order + indeterminate debit behave identically", async () => {
    const sql = fakeSql();
    const doInst = newDO(sql);
    await seedDO(doInst, win(160));

    const rA = await doInst.reserveLiveCall(T);
    const rB = await doInst.reserveLiveCall(T);
    if (!rA.ok || !rB.ok) throw new Error("setup");

    const doInst2 = newDO(sql); // second isolate, same storage
    expect(sql._peek().reservations).toHaveLength(2);

    await doInst2.reconcile(rB.reservationId, obs(win(149)), T);
    await doInst.reconcile(rA.reservationId, obs(win(151)), T); // delayed, must not reopen
    expect(sql._peek().budget!.remaining).toBe(149);
    expect((await doInst.reserveLiveCall(T)).ok).toBe(false);
  });

  it("indeterminate reconcile persists the flag; the debit survives across isolates", async () => {
    const sql = fakeSql();
    const a = newDO(sql);
    await seedDO(a, win(FLOOR + 1, T + HOUR));
    const r1 = await a.reserveLiveCall(T);
    if (!r1.ok) throw new Error("setup");
    await a.reconcile(r1.reservationId, { outcome: "indeterminate" }, T);

    expect(sql._peek().reservations).toEqual([
      { id: r1.reservationId, created_at_ms: T, indeterminate: 1 },
    ]);
    const b = newDO(sql);
    expect((await b.reserveLiveCall(T)).ok).toBe(false); // 151 - (1 ind + 1) = 149
  });

  it("window reset drops to UNKNOWN, wipes tables, and requires a fresh recovery", async () => {
    const sql = fakeSql();
    const doInst = newDO(sql);
    await seedDO(doInst, win(10, T + 1000));
    expect((await doInst.reserveLiveCall(T + 500)).ok).toBe(false); // 10 - 1 < 150
    const afterReset = await doInst.reserveLiveCall(T + 1001);
    expect(afterReset.ok).toBe(false);
    expect("recover" in afterReset).toBe(true); // recovery-only, not admission
    expect(sql._peek().budget).toBeNull();
  });

  it("8. a SQL failure mid-#save rolls the whole mutation back (no partial reservation set)", async () => {
    const sql = fakeSql();
    const doInst = newDO(sql);
    await seedDO(doInst, win(5000, T + HOUR));
    const rA = await doInst.reserveLiveCall(T);
    const rB = await doInst.reserveLiveCall(T);
    if (!rA.ok || !rB.ok) throw new Error("setup");
    expect(sql._peek().reservations).toHaveLength(2);
    const before = sql._peek();

    // The next #save (via reconcile) will DELETE reservations then fail on the
    // reinsert. Without a transaction that leaves the table empty; with one it
    // rolls back to exactly the pre-save rows and budget.
    sql._failReservationInsert(true);
    let threw = false;
    try {
      await doInst.reconcile(rA.reservationId, obs(win(4999, T + HOUR)), T);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(sql._peek().reservations.map((r) => r.id).sort()).toEqual(
      before.reservations.map((r) => r.id).sort(),
    );
    expect(sql._peek().budget!.remaining).toBe(5000);

    // Recovery: once the fault clears, a normal reconcile persists cleanly.
    sql._failReservationInsert(false);
    await doInst.reconcile(rA.reservationId, obs(win(4999, T + HOUR)), T);
    expect(sql._peek().budget!.remaining).toBe(4999);
    expect(sql._peek().reservations.map((r) => r.id)).toEqual([rB.reservationId]);
  });
});

describe("durableObjectRateBudget adapter — fail closed", () => {
  const throwingNamespace = {
    idFromName: () => ({ toString: () => "id" }),
    get: () => ({
      reserveLiveCall: async () => {
        throw new Error("DO unreachable");
      },
      reconcile: async () => {
        throw new Error("DO unreachable");
      },
      recover: async () => {
        throw new Error("DO unreachable");
      },
    }),
  };

  it("a DO failure blocks the reservation rather than bypassing the floor", async () => {
    const budget = durableObjectRateBudget(throwingNamespace as any);
    const d = await budget.reserveLiveCall(T);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.retryAfterMs).toBeGreaterThan(0);
  });

  it("a reserveLiveCall RPC failure is logged (fail closed) without leaking a token", async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    try {
      const budget = durableObjectRateBudget(throwingNamespace as any);
      const d = await budget.reserveLiveCall(T);
      expect(d.ok).toBe(false); // still fail closed
    } finally {
      console.error = orig;
    }
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("RATE_BUDGET");
    expect(line).toContain("reserveLiveCall");
    expect(line).toContain("DO unreachable"); // the real cause is surfaced
    // No reservationId / recoveryToken exists on the reserve path, so none can
    // be logged; `recoveryToken` must never appear in a diagnostic line.
    expect(line).not.toContain("recoveryToken");
  });

  it("a DO failure in reconcile() is propagated (the app holds the reservation to reset)", async () => {
    const budget = durableObjectRateBudget(throwingNamespace as any);
    let threw = false;
    try {
      await budget.reconcile("r1", { outcome: "indeterminate" }, T);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("a DO failure in recover() is propagated (the app treats it as a failed recovery)", async () => {
    const budget = durableObjectRateBudget(throwingNamespace as any);
    let threw = false;
    try {
      await budget.recover("tok", { outcome: "failed" }, T);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("forwards to a healthy DO stub", async () => {
    const calls: string[] = [];
    const healthy = {
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => ({
        reserveLiveCall: async (nowMs: number) => {
          calls.push(`reserve:${nowMs}`);
          return { ok: true, reservationId: "rid" } as const;
        },
        reconcile: async (id: string, result: Reconciliation) => {
          calls.push(`reconcile:${id}:${result.outcome}`);
        },
        recover: async (token: string, result: RecoveryResult) => {
          calls.push(`recover:${token}:${result.outcome}`);
        },
      }),
    };
    const budget = durableObjectRateBudget(healthy as any);
    expect(await budget.reserveLiveCall(T)).toEqual({ ok: true, reservationId: "rid" });
    await budget.reconcile("rid", obs(win(5000)), T);
    await budget.recover("rtok", recOk(win(5000)), T);
    expect(calls).toEqual([`reserve:${T}`, "reconcile:rid:observed", "recover:rtok:observed"]);
  });
});
