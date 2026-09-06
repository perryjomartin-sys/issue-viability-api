# Issue Viability API — Phase 1 handoff (steps A–G)

## CURRENT STATE — automation handoff (2026-09-06)

The existing Cloudflare Worker is deployed and x402 is live. Network is
**Base Sepolia `eip155:84532` only**, price **`$0.005`**, x402 and Bazaar enabled.
`RATE_BUDGET` and `VIABILITY_CACHE` are deployed. Payment hardening and
observability are complete and deployed; accounting/idempotency audit is
complete. `8646367` added tests only; `eb11a63` ignores `.claude/`.
The repository has been pushed/backed up to GitHub. At automation task start,
local `master` and cached `origin/master` matched
`eb11a636dc758a943ec1515a9828c1e971c16335`; live remote verification was blocked
by unavailable GitHub authentication in this session.

Automation uses Node `22.23.2` and locked Wrangler `4.124.0`. The originally
supplied gateway executable was absent; its package-lock recorded `4.124.0`,
which was installed here without upgrading. Use [AUTOMATION.md](AUTOMATION.md)
for workflow triggers, setup, approval boundaries, and local validation.

Funded Base Sepolia settlement remains **UNVERIFIED**. Mainnet remains
**DISABLED**. No deployment, wallet access, funded transaction, or push is
included in this automation task. `.claude/` remains local and ignored.

## HISTORICAL DEVELOPMENT NOTES — preserved, superseded by CURRENT STATE

Everything below records earlier development stages. Statements such as
“nothing deployed”, “Wrangler unavailable”, “DO not deployed”, “local only”,
“uncommitted”, and old test counts describe those stages, not current status.


## BUILD STATUS

Steps A–E complete and green, independently re-verified. Two pre-Step-F fixes
(V1, V2), the Step-F review remediation (F1–F5), and the Step-G local
implementation (G0–G6) are applied. **Nothing is deployed.**

### Step G — x402 V2 payment gate (local only)

- **G0** — maintenance-bot exclusion now suppresses only LOW-confidence
  incidental mentions. A HIGH-confidence competitor (linked / closing reference)
  always counts, even from Dependabot / github-actions. `derive()` filter:
  `c.highConfidence || !c.authorIsIgnoredBot`.
- **G1** — `@x402/hono`, `@x402/core`, `@x402/evm`, plus required peers
  `@x402/paywall` and `@x402/extensions` — all pinned to `2.24.0`.
- **G2/G3** — `src/payments.ts` gates `POST /v1/check` on x402 V2, network
  hard-coded to `eip155:84532` (Base Sepolia), price `$0.005`. `GET /` and
  `GET /health` are never gated. OFF unless `X402_ENABLED`.
- **G4** — `CONFIG.RATE_LIMIT_FLOOR` is now **enforced**: once a fetch reports
  `rateLimit.remaining` below the floor, no further live calls until `resetAt` —
  serve a valid stale cache, else 503 + `Retry-After`.
- **G5** — x402 Bazaar discovery extension via
  `declareDiscoveryExtension` (`@x402/extensions/bazaar`), plus `serviceName` /
  `description` / `tags` / `mimeType` / `resource` route metadata.
- **G6** — proven locally: unit tests (offline facilitator stub) + one live
  smoke test against `https://x402.org/facilitator` returning a valid 402.
- **G7/G8** — no account created, no wallet, no funds, no deployment.

### G-HARDENING (H1–H8, local — pending review; **not committed**)

> **H7 supersedes parts of H4.** Round 3 (independent Codex, NO-SHIP) found three
> HIGH issues in the H4 model; H7 (below) remediates them. Where H4 and H7
> disagree (the chargeable discovery probe, `INDETERMINATE_PROBE_TTL_MS`, the
> 30 s `RESERVATION_TTL_MS` fail-open on a known window), **H7 is current**.

- **H1** — removed the optional `@x402/paywall` browser wallet UI from direct
  deps (it is an optional peer of `@x402/hono`). Programmatic 402 unchanged.
  `node_modules` 1.1 GB → 133 MB; `package-lock.json` ~12k lines → ~480.
- **H2** — clean reinstall; all four direct `@x402/*` packages (`hono`, `core`,
  `evm`, `extensions`) recorded as **exact** `2.24.0` in `package-lock.json`
  root metadata. No unrelated x402 packages.
- **H3** — `src/config.ts` `RATE_LIMIT_FLOOR` doc updated; README's "no
  `@x402/*` installed" line removed; no overstated deployment readiness.
- **H4 / two adversarial-review rounds** — rate-limit-floor state moved out of
  the `createApp` closure into `src/rate-budget.ts` as an **atomic reservation**
  model. Round 1 found check-then-observe let N concurrent cache misses all pass
  the floor; round 2 found a failed/timed-out fetch released a reservation whose
  GraphQL request GitHub may already have charged.
  - `reserveLiveCall(now)` persists an in-flight reservation **before** returning
    `ok`; admits only while `remaining − (outstanding+1)·cost ≥ FLOOR`. The
    GitHub fetch runs **outside** the store.
  - `reconcile(id, result, now)` with an explicit `Reconciliation`:
    - **observed** → release + fold `rateLimit` in monotonically (within a
      window keep `min(remaining)`; a strictly newer `resetAt` is adopted and
      supersedes old-window indeterminate debits; an older/elapsed one is
      ignored — a delayed "151" can never reopen a known "149").
    - **indeterminate** (fetch threw, or REST fallback → GraphQL may have been
      charged) → **do not release**. The debit is held until the window resets
      (budget known) or `INDETERMINATE_PROBE_TTL_MS` = 60 s (budget unknown, so
      exactly one fresh probe can retry — never a flood).
    - **not-sent** (proven no chargeable request) → release, no budget change.
  - **unknown budget** → exactly one discovery probe; others get
    `retryAfterMs = PROBE_RETRY_MS`.
  - **fail closed**: `reserveLiveCall` store error → `{ ok:false }`; a failed
    `reconcile` leaves the reservation to `RESERVATION_TTL_MS` (30 s, plain) or
    the window (indeterminate) — temporary over-block, never a bypass.
  - reserved cost/assessment = **1** GraphQL point — `tryGraphQL` sends exactly
    one non-paginated POST; observed `rateLimit.cost` is 1 in all 23 fixtures;
    `max(floor, lastObservedCost)` auto-widens. Governs the GraphQL *points*
    bucket only; the REST fallback draws the separate REST bucket (limitation).
  - `MemoryRateBudget` and `RateBudgetDO` share the pure `normalize` / `admit` /
    `applyReconcile` (H7 adds `applyRecovery`); the DO uses SQLite tables
    `budget_state`, `reservations` (with an `indeterminate` flag) and `recovery`
    (H7, single-flight marker), each mutation in one `transactionSync`, and is
    the serialization boundary. Adapter `durableObjectRateBudget()` is
    fail-closed.
- **H5** — `src/worker/index.ts` (Worker entrypoint, reuses `createApp`) and
  `wrangler.jsonc` (compat date `2026-08-04`, `nodejs_compat`, SQLite DO binding
  + `new_sqlite_classes` migration, Base-Sepolia-only enforced in code).
  **Wrangler is not installed** — `wrangler deploy --dry-run` bundle-size check
  is OUTSTANDING (stopped before installing, per instruction).
- **H6** — 145 tests (was 113) + typecheck + evaluation all green; false-GO 0
  (this count is pre-H7; see H7 for the current 160).

- **H7 / round-3 remediation (Codex NO-SHIP → three HIGH)** — closes the three
  HIGH findings without changing product scope, x402 price/network, or deploying
  anything. Files: `src/rate-budget.ts`, `src/worker/rate-budget-do.ts`,
  `src/github.ts`, `src/app.ts` + `test/rate-budget.test.ts`,
  `test/app.test.ts`, `test/payments.test.ts`, doc lines in `src/config.ts`.

  - **HIGH 1 — possibly-charged reservation must not fail-open on a short TTL.**
    `normalize` now holds **every** outstanding reservation (plain or
    indeterminate) until the known window's `resetAtMs` — the 30 s
    `RESERVATION_TTL_MS` path applies *only* while no window is known (a genuine
    orphan with nothing to bound it). A failed `reconcile` therefore over-blocks
    to the reset, never re-admits against a stale-high `remaining`.

  - **HIGH 2 — no chargeable GraphQL discovery probe.** The GraphQL points budget
    is learned only from GitHub's non-chargeable `GET /rate_limit`
    (`resources.graphql.remaining` / `.reset`, `src/github.ts` `fetchRateLimit`).
    While the budget is UNKNOWN (cold start, post-reset, store wipe) `admit`
    NEVER returns `{ ok: true }`: it elects exactly one caller
    (`{ ok:false, recover:true }`, single-flight via `recoveryStartedAtMs`,
    self-clearing after `RECOVERY_TTL_MS` = 15 s if the elector crashes); every
    other caller waits. The app then calls `GET /rate_limit` once and feeds it
    back through `RateBudget.recover(...)` / pure `applyRecovery`. A **failed**
    recovery admits ZERO assessments and returns 503 with a conservative
    back-off (honours a secondary-limit `Retry-After`). An elapsed window drops
    to UNKNOWN → the same recovery gate applies before any new assessment.
    `INDETERMINATE_PROBE_TTL_MS` and the "one fresh chargeable probe" path are
    removed.

  - **HIGH 3 — atomic `RateBudgetDO` persistence.** `#save` wraps the whole
    budget-row + reservation-set + recovery-marker mutation in one
    `state.storage.transactionSync(...)`; any failed statement rolls the entire
    block back (no empty/partial reservation set). New `recovery` table (0..1
    row) persists the single-flight marker.

  - **Preserved out-of-order rules** (unchanged in `applyReconcile`): same
    window → `min(remaining)`; older window → ignored; newer window → adopted,
    dropping now-superseded indeterminate debits. A "149" then delayed "151"
    stays blocked. GraphQL points and REST core stay separate counters.

  - **Reservations crossing a reset boundary.** Rule: a reservation is dropped
    only when its window resets (its GraphQL charge, if any, was against the
    now-refilled old window) — and NO new assessment is admitted until
    `GET /rate_limit` re-establishes the new window's budget. `applyRecovery`
    itself never erases an outstanding reservation; it only ever adds them to
    what it debits (temporary over-block, never quota reuse).

  - `MemoryRateBudget` / `RateBudgetDO` still share the pure
    `normalize` / `admit` / `applyReconcile` / `applyRecovery`. Offline
    fixture-replay mode (`IVA_DEV_FIXTURES`) pre-seeds a synthetic known budget
    (no cold-start recovery, no GitHub call).

  - **160 tests** (was 145) + typecheck + evaluation all green; false-GO 0.
    New failure-injection coverage: cold start ≤ 1 `GET /rate_limit`; 20
    concurrent cold-start callers → 1 recovery; failed recovery admits 0
    assessments; secondary-limited recovery honours `Retry-After`; old-window
    expiry requires recovery before a new assessment; SQL failure mid-`#save`
    rolls back; possibly-charged request + reconcile failure held to the reset
    (not a 30 s/60 s TTL). Retained: reversed order, cross-reset late response,
    50-way parallel admission, indeterminate held to reset, x402 / false-GO.

- **H8 / round-4 remediation (Codex NEEDS-ATTENTION → recovery races)** — gives
  the `GET /rate_limit` recovery path the same ownership + monotonic + backoff
  discipline the normal `reconcile` path already has. No product-scope, x402
  price/network, or deployment change. Files: `src/rate-budget.ts`,
  `src/worker/rate-budget-do.ts`, `src/app.ts`, doc lines in `src/config.ts` +
  `README.md`, and `test/rate-budget.test.ts` / `test/app.test.ts`.

  - **R4-1 (DEFECT) — duplicate recovery after the lease TTL.** The election
    marker was timestamp-only, so if an elected caller's `GET /rate_limit`
    outlived `RECOVERY_TTL_MS` (15 s) a second caller was elected while the
    first request was still in flight. Fix: every election now mints a
    collision-resistant **owner token** (`crypto.randomUUID()`, generated inside
    `MemoryRateBudget` / `RateBudgetDO` — never from HTTP input). `admit`
    persists `recovery = { token, startedAtMs }`; `applyRecovery(token, …)` is a
    complete **no-op** unless `token` is the current lease token. A stalled
    caller's later success or failure can no longer overwrite the budget, clear
    the new owner's lease, or change the backoff.

  - **R4-2 (DEFECT) — `applyRecovery` blindly replaced `authoritative`.** It now
    folds an `observed` recovery in with the *same* monotonic, window-aware
    rules as `applyReconcile`'s `observed`: same window → `min(remaining)` and
    `cost` never decreases; a strictly older window is ignored; a strictly newer
    window is adopted. A delayed higher `remaining` can no longer reopen
    capacity (`149/W` then stale `151/W` stays `149/W`).

  - **R4-3 (caveat under a HOLD) — no persisted recovery backoff.** A failed /
    secondary-limited recovery (current owner) now persists
    `recoveryNotBeforeMs = now + (server Retry-After | FALLBACK_RETRY_MS 60 s)`.
    Until it elapses, `admit` elects **no** recovery caller and admits **no**
    assessment — a non-compliant client can no longer drive repeated serial
    `GET /rate_limit` calls. It is cleared only by the passage of time
    (`normalize`) or a healthy current-owner `observed` recovery, and it
    deliberately **survives a primary-window reset** (a secondary/abuse limit is
    not bound to that window).

  - **DO persistence.** `recovery` gains a `token` column; a new
    `recovery_backoff` (0..1 row) holds `not_before_ms`. Both are written inside
    the existing single `state.storage.transactionSync(…)` in `#save`, so a
    failed statement rolls the whole budget + reservations + lease + backoff
    mutation back (no partial state).

  - **Preserved.** All round-3 rules (`min(remaining)` same window, older window
    ignored, newer window adopted, GraphQL points vs REST core separate,
    possibly-charged reservations held to the reset) are unchanged.

  - **173 tests** (was 160) + typecheck + evaluation all green; false-GO 0. New
    coverage: stale token inert (success *and* failure); `149/W` survives a
    stale `151/W`; monotonic same-window `min` + `cost` never down on recovery;
    older/newer-window recovery; `Retry-After=120` persists a 120 s backoff;
    generic failure persists `FALLBACK_RETRY_MS`; 20 callers during a backoff →
    0 `GET /rate_limit` + 0 assessments; a backoff clears then exactly one fresh
    election; DO rollback when the lease/backoff write fails; cross-isolate stale
    token still lets the current owner resolve.

Pre-Step-F (baseline commit):

- **V1** — HTTP slug validation delegates to `parseRepoSlug` (single source of
  truth), so a malformed slug like `owner/name!` returns the documented 400
  instead of an untyped throw surfacing as 502.
- **V2** — the closed-issue reason trim in `src/decision.ts` keys on rule `id`
  (`RULES` is exported), not on matching human-readable reason wording.

Step-F remediation (this commit):

- **F1** — every REST-derived `Signals` is now `dataQuality: "partial"`
  unconditionally (REST has no `willCloseTarget`/high-confidence evidence), so
  an otherwise-clean REST result assesses to `CAUTION`, never `GO`.
  `timelineTruncated` stays independently reported.
- **F2** — `parseGraphQL` marks `dataQuality: "partial"` whenever the response
  carried a non-empty `errors` array, or a required collection
  (`timelineItems` / `assignees`) came back null. A would-be `GO` becomes
  `CAUTION`; a failed field is never treated as clean evidence.
- **F3** — `isBotAuthor` → `isIgnoredMaintenanceBot`: only the explicit
  maintenance allowlist (Dependabot, Renovate, …) is excluded from competitor
  logic. `__typename === "Bot"` and a `"[bot]"` login suffix are no longer
  sufficient on their own, so an unknown coding-agent bot's active
  high-confidence closing PR now drives `REJECT`. `CompetitorPr.authorIsBot`
  renamed to `authorIsIgnoredBot`.
- **F4** — `getJson` (REST) accepts only 2xx (and a deliberate 404). 401 / other
  4xx / 5xx become typed `GitHubUpstreamError`; 403/429 with `remaining === 0`
  OR a `Retry-After` header OR a rate-limit message become
  `GitHubRateLimitedError` (primary and secondary limits). A JSON error body
  can no longer reach `parseRest` as repository/issue data.
- **F5** — `CONFIG.RATE_LIMIT_FLOOR` was flagged as unused-but-implied-enforced.
  Step-F left it documented as not enforced; **Step G (G4) then implemented
  enforcement** via the `RateBudget` abstraction. See G4 above and limitation #9.

Step F (independent GPT-5.6 diff review) has been performed; its findings are
remediated above. Step G is implemented locally (see "Step G" above) but
**not deployed**.

## FILES

New project at `issue-viability-api/` (the working directory was not a git repo;
two unrelated projects sit beside it and were not touched).

```
src/config.ts      decision constants (COMPET_DAYS=14, REPO_DAYS=90, ASSIGN_STALE_DAYS=45,
                   ISSUE_STALE_DAYS=365, cache 600/3600s) — the whole public contract
src/types.ts       Signals / Assessment / CompetitorPr + typed errors
src/dates.ts       UTC-day-truncated age helpers (determinism lives here)
src/bots.ts        maintenance-bot allowlist (isIgnoredMaintenanceBot); unknown bots compete
src/query.ts       the single GraphQL query (issueOrPullRequest union, willCloseTarget,
                   connect/disconnect, assign/unassign, rateLimit)
src/parse.ts       parseGraphQL + parseRest -> Signals (competitor confidence resolution)
src/github.ts      fetchSignals: GraphQL first, REST fallback, typed error propagation
src/decision.ts    assess(signals, today) -> Assessment  (pure, ordered rule engine)
src/cache.ts       MemoryCache + fresh/stale/expired contract + GO->CAUTION stale downgrade
src/rate-budget.ts RateBudget (atomic reserve/reconcile/recover; observed|indeterminate|not-sent + GET /rate_limit authoritative recovery) + pure normalize/admit/applyReconcile/applyRecovery + MemoryRateBudget
src/app.ts         Hono app factory: POST /v1/check, GET /health, GET / ; x402 gate + rate budget
src/payments.ts    x402 V2 payment gate (Base Sepolia only), Bazaar discovery, offline-injectable
src/server.ts      @hono/node-server entrypoint (npm run dev), passes X402_* env
src/worker/index.ts        Cloudflare Worker entrypoint (LOCAL ONLY, not deployed)
src/worker/rate-budget-do.ts  SQLite Durable Object RateBudgetDO + fail-closed adapter
wrangler.jsonc     Worker config: compat 2026-08-04, nodejs_compat, SQLite DO binding + migration

test/helpers.ts        Signals/Competitor factories, fixed TODAY
test/expect.ts         tiny assertion shim over node:assert (no vitest/vite dependency)
test/dates.test.ts     7  cases
test/parse.test.ts     20 cases
test/decision.test.ts  25 cases (rule matrix + determinism + id-keyed trim + bot allowlist/G0)
test/github.test.ts    11 cases (orchestration: fallback, rate-limit primary+secondary, 401/404)
test/app.test.ts       26 cases (HTTP status mapping, cache fresh/stale, fixtures, slug, floor enforcement + authoritative recovery + owner-token backoff + fail-closed)
test/degraded.test.ts  3  cases (F1 REST->CAUTION, F2 GraphQL-errors->CAUTION, clean->GO)
test/payments.test.ts  7  cases (x402 off by default, 402 when on, /health+/ ungated, bad payTo throws, bazaar)
test/rate-budget.test.ts 50 cases (pure fns, concurrency + out-of-order, GET /rate_limit recovery (cold start / single-flight / failed / old-window / owner-token / persisted backoff), monotonic recovery fold, stale-token inert, indeterminate accounting, MemoryRateBudget, RateBudgetDO vs SQL fake incl. transaction rollback, fail-closed adapter)
test/evaluation.test.ts 24 cases (23 real fixtures + false-GO gate)
                       -- 173 subtests total, all passing
test/fixtures/cases.json          case list + human labels + recorded_at
test/fixtures/raw/*.json          23 real GitHub GraphQL responses, captured 2026-08-30
scripts/record-fixtures.mjs       re-capture fixtures via the gh CLI
scripts/inspect.mjs               dev: print parse+assess for every fixture

package.json  tsconfig.json  .gitignore  README.md  HANDOFF.md
```

Runtime deps: `hono`, `@hono/node-server`, and the x402 V2 stack pinned to exact
`2.24.0` — `@x402/hono`, `@x402/core`, `@x402/evm`, `@x402/extensions` (pulls in
`viem`, `zod`). The optional `@x402/paywall` browser wallet UI is **not**
installed (agent-first; dropping it cut `node_modules` from ~1.1 GB to ~133 MB
and `package-lock.json` from ~12k lines to ~480). Dev: `typescript`,
`@types/node`. No test framework (uses `node:test`). `wrangler` is **not**
installed — see "STEP-G — REMAINING FOR TESTNET".

## TESTS

```
npm run typecheck   -> tsc --noEmit, exit 0
npm test            -> # tests 173   # pass 173   # fail 0
```

Runner is `node --experimental-strip-types --test 'test/*.test.ts'` (Node
v22.23). Vitest was removed: a stray 0-byte `~/package.json` on this machine
crashes Vite/esbuild's config loader; that file is out of scope and was left
alone.

## REAL-WORLD CASES

23 real public GitHub issues recorded as GraphQL fixtures on 2026-08-30 and
replayed through the real parser + engine. Age windows evaluated against the
capture date.

| scenario | example | expected | engine |
|---|---|---|---|
| closed issue | rust-lang/rust#1, flask#1, go#1, k8s#1 (9 total) | REJECT | REJECT |
| closed + huge truncated timeline (>100 items) | rust-lang/rust#1,#2, k8s#1 | REJECT | REJECT |
| number is a pull request | nodejs/node#1, facebookarchive/draft-js#3182 | NOT_AN_ISSUE | NOT_AN_ISSUE |
| repo has issues disabled | torvalds/linux#1 | NOT_FOUND | NOT_FOUND |
| repository not found | octocat/this-repo-does-not-exist-xyz#1 | NOT_FOUND | NOT_FOUND |
| archived repo, open issue | facebookarchive/draft-js#3181 | REJECT | REJECT |
| open issue, active high-confidence closing PR | rust-lang/rust#161989 | REJECT | REJECT |
| open, assigned, mixed PRs | cli/cli#13991 | CAUTION | CAUTION |
| open, old and inactive | rust-lang/rust#44975, #29563 | CAUTION | CAUTION |
| open, merged non-closing reference | rust-lang/rust#90950 | CAUTION | CAUTION |
| open, stale assignee, non-recent high-confidence PR | rust-lang/rust#147931 | CAUTION | CAUTION |
| open tracking issue, draft high-confidence PR + many refs | rust-lang/rust#110011 | CAUTION | CAUTION |
| fresh open, unassigned, no PRs, active repo | cli/cli#14297, #14293 | GO | GO |

Label mismatches: 0.

## FALSE GO COUNT

**0.** No case where a human sees a blocker (closed / archived / assigned /
competing PR / not-an-issue / not-found) and the engine returns `GO`. The two
`GO` outputs are both genuine true negatives. `test/evaluation.test.ts` asserts
`false_go === 0` as a hard gate.

False REJECT count: 0 (no clean issue misclassified as REJECT).

## KNOWN LIMITATIONS

1. **Unlinked competing PRs are invisible.** A PR that implements the issue but
   never references `#N` produces no timeline entry. `GO` stays advisory. (Design
   risk #1; accepted.)
2. **Draft high-confidence PRs do not trigger REJECT** — only CAUTION (rule 6),
   per review delta #2 (a draft is not "active competing implementation"). Seen
   live in rust-lang/rust#110011.
3. **Non-recent high-confidence PRs → CAUTION, not REJECT** (rule 4 needs an
   update within 14 days). rust-lang/rust#147931 is the live example.
4. **REST fallback never emits a clean `GO`** — no `willCloseTarget` over REST
   and its `connected` events are opaque, so every REST result is
   `data_quality: "partial"` and any would-be `GO` is downgraded to `CAUTION`
   (F1). REST competitors are also all low-confidence, so REST can never
   hard-REJECT. Conservative by design.
5. **Timeline truncated at 100 items** on heavily-referenced issues →
   `data_quality: "partial"` and any `GO` becomes `CAUTION`. Older `ConnectedEvent`
   links on such issues can be missed; the closed-issue cases here hit this but
   the closure rule dominates so the verdict is unaffected.
6. **Time-relative determinism.** Same GitHub state on a different UTC date can
   give a different answer as the 14/90/365-day windows roll. Within a day the
   answer is fixed. Fixtures pin `recorded_at` for this reason.
7. **Fixture drift.** cli/cli#14297 / #14293 were GO on 2026-08-30; if re-recorded
   later they may acquire PRs/assignees and the labels in `cases.json` will need
   review. `scripts/record-fixtures.mjs` re-stamps `recorded_at`.
8. **`fetchSignals` live path** is covered by mocked-transport unit tests plus one
   manual live call on 2026-08-30 (rust-lang/rust#44975 → CAUTION via `source=graphql`;
   NOT_AN_ISSUE and NOT_FOUND propagated). No automated live test (would need a
   token in CI and would be non-deterministic).
9. **`RATE_LIMIT_FLOOR`: atomic within a store; default store is per process;
   GraphQL bucket only** (G4 / H4 / H7 / **H8**). The reservation + authoritative-
   recovery model (`src/rate-budget.ts`) closes the concurrency gap, the
   ambiguous-attempt gap, (H7) the chargeable-probe and short-TTL fail-open
   gaps, and (H8) the recovery-race gaps — duplicate recovery after the lease
   TTL, an out-of-order recovery reopening capacity, and an un-throttled failed
   recovery — *within* whichever store is used. The default `MemoryRateBudget`
   is per process — fine for a single `npm run dev`. A multi-instance / Worker
   deployment must inject `RateBudgetDO` (`src/worker/rate-budget-do.ts`, a
   SQLite Durable Object — the serialization boundary); that DO **has not been
   deployed**. Residual, by design: (a) while the budget is unknown one caller
   holds an owner-token lease to run a non-chargeable `GET /rate_limit`; a
   failed recovery persists a backoff (`Retry-After` or 60 s) during which
   assessments and further recovery elections are blocked — zero chargeable
   assessments; (b) any reservation for a possibly-dispatched request holds its
   1-point debit until the window resets (temporary over-block, chosen over a
   bypass); (c) the floor governs the GraphQL **points** bucket only — the REST
   fallback's request-bucket load is not floor-protected (would need its own
   counter from `resources.core`); (d) a failed `reconcile` RPC leaves the
   reservation held to the reset window (no short TTL on a known window).
10. **GraphQL partial-error heuristic is coarse** (F2): *any* non-empty `errors`
   array degrades the result to `partial`, even an error on a field the
   assessment does not use. Deliberately conservative (favours `CAUTION`).
11. **x402 gate needs the facilitator to build a 402** (G). With the gate on, an
   unpaid request triggers one GET to `X402_FACILITATOR_URL/supported`
   (cached after first success). If the facilitator is unreachable the middleware
   returns a facilitator error, not a 402. Tests inject an offline stub.
12. **x402 verify/settle is unproven end-to-end.** No real Base Sepolia payment
   has been made (needs a funded testnet wallet + a paying client). Only the
   402 / discovery / config paths are exercised. The Bazaar extension shape is
   produced by the official `declareDiscoveryExtension` helper but has not been
   validated against a live Bazaar indexer.
13. **Cross-reset dispatch timing (theory, Codex round-4 finding #1).** A
   pre-reset dispatched GraphQL request may theoretically be processed after the
   local reset boundary after its old-window reservation has been discarded.
   This has not been reproduced and remains a timing assumption. No bound on the
   number of such in-flight requests, and no maximum error, has been proven. Not
   redesigned around in this round.

## CLAUDE VERDICT

Steps A–E are complete, independently re-verified, and green. Step F (independent
GPT-5.6 diff review) has been performed; findings F1–F5 are remediated in this
commit with regression tests. The engine is deterministic, the real-data
false-GO rate is 0/23, all failure modes map to the designed HTTP codes, and no
`GO` now survives a REST fallback, a GraphQL partial error, incomplete/truncated
data, or an unknown-bot competing PR. No fundamental blocker remains.

Step G (Base-Sepolia x402 V2) is **implemented locally and verified locally**:
G0 bot-handling tightened, the gate wired on `POST /v1/check` for
`eip155:84532` only at `$0.005`, `RATE_LIMIT_FLOOR` enforced, Bazaar discovery
declared. The G-hardening pass (H1–H8) then dropped the browser-wallet
dependency (node_modules 1.1 GB → 133 MB), pinned all x402 deps to exact
`2.24.0`, moved the rate-budget behind an async `RateBudget` interface with a
SQLite Durable Object implementation + fail-closed adapter, added a local-only
Cloudflare Worker entrypoint + `wrangler.jsonc`, (H7, round-3 remediation)
replaced the chargeable discovery probe with non-chargeable `GET /rate_limit`
authoritative recovery, held possibly-charged reservations to the window reset,
and made the DO persistence transactional, then (H8, round-4 remediation) gave
that recovery path an owner-token lease, monotonic out-of-order handling, and a
persisted failure backoff so it cannot double-fire or reopen capacity. 173 tests
+ typecheck + evaluation green; false-GO 0.

**Nothing is deployed. No wallet, no funds, no account. Wrangler is not
installed; the dry-run bundle-size check is outstanding.** Deploying to Base
Sepolia, the DO, and any real payment remain gated on Perry — see "STEP-G —
REMAINING FOR TESTNET".

The H1–H8 changes are **uncommitted** pending review.

## STEP-F REVIEW — OUTCOME

Reviewed: the entire `issue-viability-api/src/` tree plus `test/`. Findings and
their remediation (all in the Step-F commit):

| # | Finding | Fix |
|---|---|---|
| F1 | REST results could assess to a clean `GO` despite REST being structurally low-evidence | `parseRest` → `dataQuality: "partial"` always; regression tests in `test/degraded.test.ts`, `test/parse.test.ts` |
| F2 | GraphQL `data.repository` + `errors` (nulled fields) could still produce `GO` | `parseGraphQL` → `partial` on any non-empty `errors` or a null required collection; `test/degraded.test.ts` |
| F3 | every `__typename === "Bot"` / `[bot]` author was ignored → an autonomous coding bot's closing PR could yield `GO` | `isIgnoredMaintenanceBot` (allowlist only); `test/decision.test.ts`, `test/parse.test.ts` |
| F4 | REST `getJson` let 401/secondary-403 bodies through as data | strict 2xx-only + primary/secondary rate-limit classification; `test/github.test.ts` |
| F5 | `RATE_LIMIT_FLOOR` unused but implied enforced | documented as a Step-G requirement in `src/config.ts` + limitation #9; not claimed as enforced |

Note: F5 is now **implemented** in Step G (G4) — see limitation #9 for the
remaining per-process caveat.

## STEP-G — REMAINING FOR TESTNET (needs Perry)

The local implementation is done. To actually run on Base Sepolia, the
following require Perry's decision and/or external action — none taken:

1. **A Base Sepolia recipient address** for `X402_PAY_TO`. Any EVM address
   works; testnet USDC has no real value. Perry supplies it.
2. **A deploy target.** Nothing is deployed. Options, in order of least
   commitment: run `npm run dev` on an existing box behind a tunnel; the
   Cloudflare Worker (`src/worker/index.ts` + `wrangler.jsonc` are ready) on the
   Workers Free plan; any other host. For Cloudflare, Perry must authorize
   `wrangler` install, then `wrangler login` (an account action).
3. **Wrangler bundle-size dry run — OUTSTANDING.** `wrangler` is not installed;
   per instruction I stopped before installing it. Once installed,
   `wrangler deploy --dry-run` (no login, no upload) will report the compressed
   bundle size — needed to confirm the x402 + viem tree fits the Worker size
   limit. Not yet obtained.
4. **The `RateBudgetDO` Durable Object is not deployed.** It is implemented and
   unit-tested against an in-memory SQL fake, and wired via `wrangler.jsonc`
   (`new_sqlite_classes` migration, Workers-Free-compatible). It only runs once
   the Worker is deployed.
5. **An end-to-end payment test** needs a funded Base Sepolia wallet and a
   paying x402 client (e.g. `x402-fetch` with a testnet key). Getting testnet
   ETH/USDC from a faucet and using a wallet key are external actions — STOP
   and ask first (G7).
6. **Facilitator choice.** Default is the public `https://x402.org/facilitator`
   (keyless for base-sepolia). If a CDP-hosted facilitator is wanted instead it
   needs a CDP API key (paid-account adjacent) — not configured.
7. **Bazaar listing.** The route declares the discovery extension; whether it
   actually appears in a Bazaar index depends on the deployed `resource` URL
   being reachable and indexed. Unverified.
