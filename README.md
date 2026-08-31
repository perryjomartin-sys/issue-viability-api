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

Phase-1 build, steps **A–G** of the agreed plan. Steps done:

| Step | What | State |
|---|---|---|
| A | Deterministic GitHub client (`src/github.ts`, `src/parse.ts`, `src/query.ts`) | done |
| B | Decision engine (`src/decision.ts`) | done |
| C | Unit tests (`test/*.test.ts`, `node:test`) | 113 passing |
| D | Real-world evaluation (`test/evaluation.test.ts`, 23 recorded GitHub fixtures) | false-GO = 0 |
| E | Local endpoint (`src/app.ts` + `src/server.ts`, Hono) | runs |
| F | Independent GPT-5.6 diff review | **done — findings F1–F5 remediated (see HANDOFF.md)** |
| G | Base-Sepolia x402 V2 payment gate (`src/payments.ts`) | **local implementation done; not deployed** |

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
`CAUTION`. Maintenance-bot filtering (`isIgnoredMaintenanceBot`, `src/bots.ts`)
suppresses only **low-confidence incidental mentions** from an allowlist
(Dependabot, Renovate, …). A **high-confidence** competitor — officially linked
or a `willCloseTarget` closing reference — always counts, whoever opened it:
Dependabot or an autonomous coding agent with a real closing PR still drives
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

## x402 V2 payment gate (step G)

`POST /v1/check` can be gated behind an [x402](https://x402.org) V2 payment on
**Base Sepolia testnet** (`eip155:84532`). OFF unless `X402_ENABLED` is set.
No mainnet, no real USDC — the network is hard-coded and the code refuses any
other.

```bash
X402_ENABLED=true \
X402_PAY_TO=0xYourBaseSepoliaAddress \
X402_PRICE='$0.005' \
X402_RESOURCE_URL=https://your-host/v1/check \
GITHUB_TOKEN=ghp_xxx \
npm run dev
```

| env | meaning | default |
|---|---|---|
| `X402_ENABLED` | turn the gate on (`true`/`1`) | off |
| `X402_PAY_TO` | EVM address that receives testnet USDC (**required when on**) | — |
| `X402_PRICE` | price per call | `$0.005` |
| `X402_FACILITATOR_URL` | x402 facilitator | `https://x402.org/facilitator` |
| `X402_RESOURCE_URL` | public URL, for discovery metadata | — |
| `X402_BAZAAR` | emit the x402 Bazaar discovery extension | on |

Unpaid API requests get **402** with a `Payment-Required` header (x402 V2) and a
JSON body; browsers get the paywall page. `GET /` and `GET /health` are never
gated. Built on `@x402/hono`, `@x402/core`, `@x402/evm`, `@x402/extensions`
(Bazaar), `@x402/paywall` — all pinned to `2.24.0`.

### Rate-limit floor (enforced)

Once a fetch reports the GitHub token's remaining GraphQL budget below
`CONFIG.RATE_LIMIT_FLOOR` (150), the app stops making live calls until the rate
window resets: it serves a valid **stale cache** if one exists, otherwise
**503 + `Retry-After`**. State is per process here; a production Worker would
hold it in KV / a Durable Object.

## Deployment (not done)

Target: one Cloudflare Worker, Hono, Workers KV for the cache, native Rate
Limiting binding, the x402 V2 middleware above on `POST /v1/check`,
`base-sepolia` first. Not deployed — see `HANDOFF.md`.
