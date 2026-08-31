# Issue Viability API — Phase 1 handoff (steps A–F)

## BUILD STATUS

Steps A–E complete and green, independently re-verified, with two pre-Step-F
review fixes applied:

- **V1** — HTTP slug validation now delegates to `parseRepoSlug` (single source
  of truth), so a malformed slug like `owner/name!` returns the documented 400
  instead of an untyped throw surfacing as 502.
- **V2** — the closed-issue reason trim in `src/decision.ts` keys on rule `id`
  (`RULES` is now exported), not on matching human-readable reason wording.

Step F (independent GPT-5.6 diff review) is the next action and is **not**
something this build can perform itself. Step G (testnet x402) not started, as
instructed.

## FILES

New project at `issue-viability-api/` (the working directory was not a git repo;
two unrelated projects sit beside it and were not touched).

```
src/config.ts      decision constants (COMPET_DAYS=14, REPO_DAYS=90, ASSIGN_STALE_DAYS=45,
                   ISSUE_STALE_DAYS=365, cache 600/3600s) — the whole public contract
src/types.ts       Signals / Assessment / CompetitorPr + typed errors
src/dates.ts       UTC-day-truncated age helpers (determinism lives here)
src/bots.ts        static bot-author allowlist
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
test/parse.test.ts     17 cases
test/decision.test.ts  22 cases (full rule matrix + determinism + id-keyed trim)
test/github.test.ts    8  cases (orchestration: fallback, rate-limit, error mapping)
test/app.test.ts       13 cases (HTTP status mapping, cache fresh/stale, fixture mode, slug validation)
test/evaluation.test.ts 24 cases (23 real fixtures + false-GO gate)
                       -- 91 subtests total, all passing
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
npm test            -> # tests 91   # pass 91   # fail 0
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
4. **REST fallback cannot hard-REJECT on competitors** — no `willCloseTarget`
   over REST, so every REST competitor is low-confidence. Conservative by design.
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

## CLAUDE VERDICT

Steps A–F deliverables are complete through E; F is Perry's to run. The engine is
deterministic, the real-data false-GO rate is 0/23, all failure modes map to the
designed HTTP codes, and no `GO` survives incomplete or stale data. No
fundamental blocker found. **Recommend proceeding to step F** (independent
GPT-5.6 diff review of `src/`), then step G (Base-Sepolia x402 V2) only if F
passes.

## FOR THE STEP-F REVIEWER

Diff to review = the entire `issue-viability-api/src/` tree (11 files, ~900 LOC)
plus `test/`. Focus areas:

- `src/decision.ts` — rule order and the closed-issue reason trim; is any
  ordering wrong, any rule missing, any `GO` path under-guarded?
- `src/parse.ts` — competitor confidence resolution (connect/disconnect race,
  `willCloseTarget`, bot filtering, `lastAssignedAt` when the timeline is
  truncated).
- `src/github.ts` — which errors trigger the REST fallback vs. propagate; the
  rate-limit detection heuristics.
- `src/dates.ts` — the UTC-day truncation is the whole determinism guarantee.
- `test/fixtures/cases.json` — are any of the 23 human labels wrong?
