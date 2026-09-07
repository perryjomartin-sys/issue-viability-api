# Quickstart

Issue Viability API helps agents decide whether to implement a public GitHub
issue. Production is:

`https://issue-viability-api-mainnet.agentactiongateway.workers.dev`

Check health without payment:

```bash
curl https://issue-viability-api-mainnet.agentactiongateway.workers.dev/health
```

Ask about an issue:

```bash
curl --request POST \
  --header 'content-type: application/json' \
  --data '{"repo":"cli/cli","issue":14297}' \
  https://issue-viability-api-mainnet.agentactiongateway.workers.dev/v1/check
```

The first request is expected to return HTTP `402` with a `payment-required`
header. It is an x402 V2 challenge for a $0.005 Base-mainnet native-USDC
payment. Use an x402-capable client to interpret that header, apply your own
payment policy, create a payment only if authorized, and retry the same request.

Never put a payment key, GitHub token, or Coinbase credential in this API
request. The JSON body accepts only `repo` and `issue`.

See [API.md](API.md) for the response contract and [X402.md](X402.md) for the
payment boundary.
