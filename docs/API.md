# API reference

Base URL: `https://issue-viability-api-mainnet.agentactiongateway.workers.dev`

The machine-readable contract is [`openapi.json`](openapi.json).

## `GET /health`

Public, unpaid health and payment-network check:

```json
{"status":"ok","service":"issue-viability-api","payments":"x402:eip155:8453"}
```

## `POST /v1/check`

Request body:

```json
{ "repo": "owner/repository", "issue": 123 }
```

`repo` must name a public GitHub repository and `issue` must be a positive integer referring to an issue, not a pull request.

### Unpaid response

Production returns HTTP `402` before evaluating the issue. The JSON body identifies `payment_required`; the `payment-required` response header is the authoritative x402 V2 requirement.

### Successful assessment

After valid payment, HTTP `200` returns:

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

`GO` means no blocking evidence was found; `CAUTION` means review listed signals; `REJECT` means the issue is closed, superseded, or not viable. Results are based on current public GitHub data and are not a guarantee of acceptance.

| HTTP | Meaning |
| --- | --- |
| `400` | Invalid JSON, repository slug, or issue number. |
| `402` | x402 payment required. |
| `404` | Repository or issue not found. |
| `422` | Requested number is a pull request. |
| `502` | GitHub upstream unavailable. |
| `503` | Safe GitHub rate-limit floor unavailable; observe `Retry-After`. |

A cached stale result can be `200` with `x-cache: stale` and is downgraded from `GO` to `CAUTION`.
