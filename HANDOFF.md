# Issue Viability API — Phase 1 handoff (steps A–F)

## BUILD STATUS

Steps A–E complete and green, independently re-verified. Two pre-Step-F fixes
(V1, V2) plus the Step-F review remediation (F1–F5) are applied.

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
remediated above. Step G (testnet x402) not started, as instructed.

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
src/app.ts         Hono app factory: POST /v1/check, GET /health, GET /  (payments OFF)
src/server.ts      @hono/node-server entrypoint (npm run dev)

test/helpers.ts        Signals/Competitor factories, fixed TODAY
test/expect.ts         tiny assertion shim over node:assert (no vitest/vite dependency)
test/dates.test.ts     7  cases
test/parse.test.ts     19 cases
test/decision.test.ts  23 cases (full rule matrix + determinism + id-keyed trim + unknown-bot)
test/github.test.ts    11 cases (orchestration: fallback, rate-limit primary+secondary, 401/404)
test/app.test.ts       13 cases (HTTP status mapping, cache fresh/stale, fixture mode, slug validation)
test/degraded.test.ts  3  cases (F1 REST->CAUTION, F2 GraphQL-errors->CAUTION, clean->GO)
test/evaluation.test.ts 24 cases (23 real fixtures + false-GO gate)
                       -- 100 subtests total, all passing
test/fixtures/cases.json          case list + human labels + recorded_at
test/fixtures/raw/*.json          23 real GitHub GraphQL responses, captured 2026-08-30
scripts/record-fixtures.mjs       re-capture fixtures via the gh CLI
scripts/inspect.mjs               dev: print parse+assess for every fixture

package.json  tsconfig.json  .gitignore  README.md  HANDOFF.md
```

Dependencies installed: `hono`, `@hono/node-server` (runtime); `typescript`,
`@types/node` (dev). No test framework (uses `node:test`). No `wrangler`, no
`@x402/*`.

## TESTS

```
npm run typecheck   -> tsc --noEmit, exit 0
npm test            -> # tests 100   # pass 100   # fail 0
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
9. **`RATE_LIMIT_FLOOR` is not enforced** in this build (F5). Cross-request
   budget management needs durable shared state; it is a Step-G requirement for
   the production Worker/KV layer. `fetchSignals` already surfaces
   `signals.rateLimit` (`cost` / `remaining` / `resetAt`) on every GraphQL
   result for that layer to act on.
10. **GraphQL partial-error heuristic is coarse** (F2): *any* non-empty `errors`
   array degrades the result to `partial`, even an error on a field the
   assessment does not use. This is deliberately conservative (favours `CAUTION`
   over `GO`); it can produce a `CAUTION` where a `GO` would have been safe.

## CLAUDE VERDICT

Steps A–E are complete, independently re-verified, and green. Step F (independent
GPT-5.6 diff review) has been performed; findings F1–F5 are remediated in this
commit with regression tests. The engine is deterministic, the real-data
false-GO rate is 0/23, all failure modes map to the designed HTTP codes, and no
`GO` now survives a REST fallback, a GraphQL partial error, incomplete/truncated
data, or an unknown-bot competing PR. No fundamental blocker remains.

Step G (Base-Sepolia x402 V2) is **not started** and remains gated on Perry's
go-ahead. Do not begin x402 / testnet / deployment work without it.

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
