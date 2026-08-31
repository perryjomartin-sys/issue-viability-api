# Issue Viability API

A very small HTTP API that tells an AI coding agent whether a **public GitHub
issue** is still rational to work on before it spends tokens implementing it.

No accounts. No dashboard. No database. One `POST` endpoint.

```
POST /v1/check
{ "repo": "owner/name", "issue": 123 }
```
```json
{
  "issue_state": "open",
  "assigned": false,
  "open_competing_prs": 0,
  "recent_competitors": 0,
  "repo_active": true,
  "last_activity": "2026-08-28T14:02:11.000Z",
  "risk": "low",
  "recommendation": "GO",
  "reasons": ["issue is open, unassigned, has no competing PRs, and the repository is active"],
  "data_quality": "ok",
  "checked_at": "2026-08-30"
}
```

`recommendation` is one of `GO` / `CAUTION` / `REJECT`; `risk` is `low` / `medium`
/ `high` and maps 1:1 to it. The response is **deterministic**: a pure function
of `(repo, issue, GitHub state, UTC date)`.

## Status

Phase-1 build, steps **A–F** of the agreed plan. Steps done:

| Step | What | State |
|---|---|---|
| A | Deterministic GitHub client (`src/github.ts`, `src/parse.ts`, `src/query.ts`) | done |
| B | Decision engine (`src/decision.ts`) | done |
| C | Unit tests (`test/*.test.ts`, `node:test`) | 100 passing |
| D | Real-world evaluation (`test/evaluation.test.ts`, 23 recorded GitHub fixtures) | false-GO = 0 |
| E | Local endpoint (`src/app.ts` + `src/server.ts`, Hono, **payments OFF**) | runs |
| F | Independent GPT-5.6 diff review | **done — findings F1–F5 remediated (see HANDOFF.md)** |
| G | Base-Sepolia x402 V2 | **not started (awaiting go-ahead)** |

No deployment. No paid Cloudflare plan. No `@x402/*` packages installed yet.

## Run it locally

```bash
npm install

# 1. offline, using the recorded real-GitHub fixtures (no token needed)
IVA_DEV_FIXTURES="$PWD/test/fixtures/raw" IVA_NOW=2026-08-30T12:00:00Z npm run dev
curl -s localhost:8787/v1/check -H 'content-type: application/json' \
  -d '{"repo":"cli/cli","issue":14293}' | jq

# 2. live GitHub (needs a read-only token in the env)
GITHUB_TOKEN=ghp_xxx npm run dev
```

Other scripts:

```bash
npm test              # node --test, no vite/vitest
npm run typecheck     # tsc --noEmit
npm run record-fixtures   # refresh test/fixtures/raw/*.json via the gh CLI
```

## How it decides

One authenticated **GraphQL** request per uncached call
(`src/query.ts`) returns repo activity, issue state, assignees, and the issue
timeline (cross-references with `willCloseTarget`, connect/disconnect,
assign/unassign). A REST fallback (`parseRest`) covers GraphQL outages; REST
cannot see `willCloseTarget` and its `connected` events are opaque, so every
REST result is `data_quality: "partial"` — a REST competitor is always
low-confidence (never `REJECT`) and an otherwise-clean REST result is
downgraded from `GO` to `CAUTION`.

A GraphQL response that returns usable `data.repository` alongside a non-empty
`errors` array (or a null `timelineItems` / `assignees`) is likewise treated as
`partial`: a failed field is never read as clean evidence.

**Competitor confidence (per the review):**

- *high confidence* = the PR is officially linked (`ConnectedEvent`, not later
  disconnected) **or** a cross-reference with `willCloseTarget = true`
  ("Fixes #N" style).
- *low confidence* = a bare mention.

**Rules** (first match sets the recommendation; every matched rule adds a reason):

| # | Condition | Result |
|---|---|---|
| 1 | issue is closed | REJECT |
| 2 | a **merged** high-confidence PR exists | REJECT |
| 3 | repo archived or disabled | REJECT |
| 4 | a high-confidence PR is open, non-draft, updated ≤ 14 days | REJECT |
| 5 | a **merged** low-confidence PR references the issue | CAUTION |
| 6 | any open PR references the issue | CAUTION |
| 7 | issue is assigned (assignment ≤ 45 days) | CAUTION |
| 8 | issue is assigned (assignment older / unknown) | CAUTION |
| 9 | repo inactive > 90 days | CAUTION |
| 10 | issue older than 365 days and quiet > 90 days | CAUTION |
| 11 | data incomplete (timeline truncated / REST / stale cache) | CAUTION |
| — | none of the above | GO |

A `GO` is **never** emitted on incomplete or stale data — it is downgraded to
`CAUTION`. Only PRs from an allowlist of **maintenance** bots (Dependabot,
Renovate, …) are excluded from competitor counts (`isIgnoredMaintenanceBot`,
`src/bots.ts`); an unknown bot — e.g. an autonomous coding agent — counts as a
real competitor, so its active high-confidence closing PR can still drive
`REJECT`.

Tunable constants live in one place: `src/config.ts`.

## Failure behaviour

| Situation | HTTP |
|---|---|
| malformed body / bad slug / issue ≤ 0 | 400 |
| number is a pull request | 422 |
| repo or issue not found / private | 404 |
| GitHub rate-limited, no usable cache | 503 + `Retry-After` |
| GitHub unreachable, no usable cache | 502 |
| GitHub unreachable, stale cache available | 200, `x-cache: stale`, `GO`→`CAUTION` |

## Caching

`v1:{repo}:{issue}:{utc-date}` — no per-caller data, so the cache is shared
across all callers. `0–600 s` served fresh; `600–3600 s` used only as a stale
fallback when GitHub fails; older is discarded. `src/cache.ts` has an in-memory
implementation for local runs; production swaps in Workers KV with the same
contract.

## Deployment (step G — not done)

Target: one Cloudflare Worker, Hono, Workers KV for the cache, native Rate
Limiting binding, x402 **V2** payment middleware (`@x402/hono`, headers
`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`) on `POST /v1/check`
priced at `$0.005`, `base-sepolia` (`eip155:84532`) first. See `HANDOFF.md`.

`CONFIG.RATE_LIMIT_FLOOR` (150) is **defined but not enforced** in this build —
enforcing it (serve cache-only once the token's `rateLimit.remaining` drops
below the floor, until `resetAt`) is a step-G task for the Worker/KV layer.
