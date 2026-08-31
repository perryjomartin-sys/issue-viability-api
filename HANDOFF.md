# Issue Viability API — Phase 1 handoff (steps A–G)

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
- **G4** — `CONFIG.RATE_LIMIT_FLOOR` is now **enforced** in `src/app.ts`: once a
  fetch reports `rateLimit.remaining` below the floor, no further live calls
  until `resetAt` — serve a valid stale cache, else 503 + `Retry-After`.
- **G5** — x402 Bazaar discovery extension via
  `declareDiscoveryExtension` (`@x402/extensions/bazaar`), plus `serviceName` /
  `description` / `tags` / `mimeType` / `resource` route metadata.
- **G6** — proven locally: 113 unit tests (offline facilitator stub) + one live
  smoke test against `https://x402.org/facilitator` returning a valid 402.
- **G7/G8** — no account created, no wallet, no funds, no deployment.

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
- **F5** — `CONFIG.RATE_LIMIT_FLOOR` is documented as **not enforced** in this
  build; enforcement is a Step-G requirement in the production Worker/KV layer
  (see the constant's doc comment and "Step G" below). No false claim of
  enforcement anywhere.

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
src/app.ts         Hono app factory: POST /v1/check, GET /health, GET / ; x402 gate + RATE_LIMIT_FLOOR
src/payments.ts    x402 V2 payment gate (Base Sepolia only), Bazaar discovery, offline-injectable
src/server.ts      @hono/node-server entrypoint (npm run dev), passes X402_* env

test/helpers.ts        Signals/Competitor factories, fixed TODAY
test/expect.ts         tiny assertion shim over node:assert (no vitest/vite dependency)
test/dates.test.ts     7  cases
test/parse.test.ts     20 cases
test/decision.test.ts  25 cases (rule matrix + determinism + id-keyed trim + bot allowlist/G0)
test/github.test.ts    11 cases (orchestration: fallback, rate-limit primary+secondary, 401/404)
test/app.test.ts       16 cases (HTTP status mapping, cache fresh/stale, fixtures, slug, RATE_LIMIT_FLOOR)
test/degraded.test.ts  3  cases (F1 REST->CAUTION, F2 GraphQL-errors->CAUTION, clean->GO)
test/payments.test.ts  7  cases (x402 off by default, 402 when on, /health+/ ungated, bad payTo throws, bazaar)
test/evaluation.test.ts 24 cases (23 real fixtures + false-GO gate)
                       -- 113 subtests total, all passing
test/fixtures/cases.json          case list + human labels + recorded_at
test/fixtures/raw/*.json          23 real GitHub GraphQL responses, captured 2026-08-30
scripts/record-fixtures.mjs       re-capture fixtures via the gh CLI
scripts/inspect.mjs               dev: print parse+assess for every fixture

package.json  tsconfig.json  .gitignore  README.md  HANDOFF.md
```

Runtime deps: `hono`, `@hono/node-server`, and the x402 V2 stack pinned to
`2.24.0` — `@x402/hono`, `@x402/core`, `@x402/evm`, `@x402/extensions`,
`@x402/paywall` (pulls in `viem`, `zod`). Dev: `typescript`, `@types/node`. No
test framework (uses `node:test`). No `wrangler`. `node_modules` grows ~160 MB
with the x402 + viem trees.

## TESTS

```
npm run typecheck   -> tsc --noEmit, exit 0
npm test            -> # tests 113   # pass 113   # fail 0
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
9. **`RATE_LIMIT_FLOOR` enforcement is per process** (G4). `src/app.ts` tracks
   the last-seen `rateLimit.remaining` / `resetAt` in a closure and stops live
   calls below the floor. A multi-instance / Worker deployment needs this state
   in KV or a Durable Object; the current mechanism protects a single process
   only, and the very first request per process always goes through (budget is
   unknown until a response arrives).
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
declared, 113 tests + one live facilitator smoke test green. **Nothing is
deployed. No wallet, no funds, no account.** Deploying to Base Sepolia, and any
real payment, remain gated on Perry — see "STEP-G — REMAINING FOR TESTNET".

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
   commitment: run `npm run dev` on an existing box behind a tunnel; a free
   Cloudflare Worker (`wrangler` not yet installed, no account configured); any
   other host. Each needs Perry to choose and, for Cloudflare, to authorize
   `wrangler` install + `wrangler login` (an account action).
3. **An end-to-end payment test** needs a funded Base Sepolia wallet and a
   paying x402 client (e.g. `x402-fetch` with a testnet key). Getting testnet
   ETH/USDC from a faucet and using a wallet key are external actions — STOP
   and ask first (G7).
4. **Facilitator choice.** Default is the public `https://x402.org/facilitator`
   (keyless for base-sepolia). If a CDP-hosted facilitator is wanted instead it
   needs a CDP API key (paid-account adjacent) — not configured.
5. **Bazaar listing.** The route declares the discovery extension; whether it
   actually appears in a Bazaar index depends on the deployed `resource` URL
   being reachable and indexed. Unverified.
