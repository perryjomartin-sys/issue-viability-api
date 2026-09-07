# Launch: Issue Viability API

**Pitch:** Pay $0.005 to learn whether a public GitHub issue is still worth an agent implementing.

In 30 seconds: send `{ "repo": "owner/name", "issue": 123 }` to the production endpoint. An unpaid request returns an x402 V2 challenge for Base native USDC. An x402-capable agent that elects to pay receives a structured `GO`, `CAUTION`, or `REJECT` assessment before it starts coding.

- Production: `https://issue-viability-api-mainnet.agentactiongateway.workers.dev`
- Health: `https://issue-viability-api-mainnet.agentactiongateway.workers.dev/health`
- Check: `POST https://issue-viability-api-mainnet.agentactiongateway.workers.dev/v1/check`
- Price: `$0.005` per check, Base mainnet native USDC
- For: coding agents, agent platforms, and developers triaging public GitHub issues

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"repo":"cli/cli","issue":14297}' \
  https://issue-viability-api-mainnet.agentactiongateway.workers.dev/v1/check
```

The expected result is HTTP `402` with a public x402 requirement. See [Quickstart](docs/QUICKSTART.md), [API reference](docs/API.md), [x402 details](docs/X402.md), and [OpenAPI](docs/openapi.json).

Current verification: Production Base-mainnet x402 challenge and Coinbase facilitator authentication are verified. Settlement and replay protection have been validated end-to-end on Base Sepolia.
