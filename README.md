# Issue Viability API

Issue Viability API helps AI coding agents decide whether a public GitHub issue
is still worth implementing before they spend tokens writing a patch. It returns
a structured `GO`, `CAUTION`, or `REJECT` assessment from issue state,
repository activity, assignments, and competing pull-request signals.

One assessment costs **$0.005 USDC** through x402 on **Base mainnet**. There
are no accounts or dashboard.

## Production

- API: `https://issue-viability-api-mainnet.agentactiongateway.workers.dev`
- Health: `https://issue-viability-api-mainnet.agentactiongateway.workers.dev/health`
- Contract: [`docs/openapi.json`](docs/openapi.json)

`GET /health` is public. `POST /v1/check` is x402-protected.

```bash
curl --request POST \
  --header 'content-type: application/json' \
  --data '{"repo":"cli/cli","issue":14297}' \
  https://issue-viability-api-mainnet.agentactiongateway.workers.dev/v1/check
```

An unpaid request returns HTTP `402` with a `payment-required` x402 V2 header.
The production challenge specifies Base (`eip155:8453`), native USDC
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), and `$0.005` / `5000` base
units. An x402-capable client can apply its own payment policy and retry the
same request after payment. This project does not provide a wallet, payer, or
browser paywall.

See [Quickstart](docs/QUICKSTART.md), [API reference](docs/API.md), and
[x402 details](docs/X402.md).

## Results

| Recommendation | Meaning |
| --- | --- |
| `GO` | No blocking evidence was found in the available public data. |
| `CAUTION` | Review the listed activity, assignment, competing-work, stale-data, or incomplete-data signals. |
| `REJECT` | The issue is closed, already addressed, or the repository is not a viable target. |

`risk` maps to the recommendation (`low` / `medium` / `high`). Every response
also includes the observed counts, `reasons`, `data_quality`, and UTC
`checked_at`. Stale or incomplete data is never promoted to `GO`.

## Agent integration

Call the endpoint before creating an implementation plan:

```ts
const response = await fetch(
  "https://issue-viability-api-mainnet.agentactiongateway.workers.dev/v1/check",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: "owner/repository", issue: 123 }),
  },
);

if (response.status === 402) {
  // Parse payment-required, apply your payment policy, and retry only if allowed.
}
```

The service evaluates public GitHub issues; callers never provide a GitHub
token, private-repository credential, wallet key, or Coinbase credential.

## Errors and privacy boundaries

| HTTP | Meaning |
| --- | --- |
| `400` | Invalid JSON, repository slug, or issue number. |
| `402` | x402 payment required before assessment. |
| `404` | Public repository or issue not found. |
| `422` | The requested number is a pull request. |
| `502` | GitHub upstream unavailable and no usable cache exists. |
| `503` | Safe GitHub rate-limit floor unavailable; observe `Retry-After`. |

A stale cached assessment may return `200` with `x-cache: stale` and is
conservatively downgraded from `GO` to `CAUTION`. The shared cache contains
only public `repo`/`issue`/UTC-date assessment data. Runtime facilitator
credentials are Worker secrets and are not in this repository.

## Verification status

Production Base-mainnet x402 challenge and Coinbase facilitator authentication
are verified. Settlement and replay protection have been validated end-to-end
on Base Sepolia.

## Local development

```bash
npm ci
npm test
npm run typecheck
npm run verify-config
```

For offline fixture development:

```bash
IVA_DEV_FIXTURES="$PWD/test/fixtures/raw" IVA_NOW=2026-08-30T12:00:00Z npm run dev
```

The default local profile is Base Sepolia. Mainnet is a separately approved
Worker environment; see [AUTOMATION.md](AUTOMATION.md).

## License and contributions

No license or contribution policy is currently published. Do not assume source
reuse permission. See [LAUNCH.md](LAUNCH.md) for the public launch summary.
