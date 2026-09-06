# Automation and release procedures

CI, deployment and monitoring operate only on the current Base Sepolia
contract (`eip155:84532`, `$0.005`). They do not require wallet credentials.

## Toolchain and local gates

Use Node **22.23.2** (`.node-version` and `package.json` engines).
The earlier handoff required Node 22.23 and the local runtime is 22.23.2.
Wrangler **4.124.0** is pinned exactly in package.json/package-lock.json,
matching the existing gateway lockfile. Its original executable was missing
in this session; the pinned project installation replaces that filesystem
dependency. No Wrangler upgrade was made.

```sh
npm ci
npm run typecheck
npm test
node scripts/test-report.mjs
npm run verify-config
npm run dry-run
npm run smoke:production
node scripts/smoke-production.mjs --monitor
git diff --check
```

`test-report.mjs` runs `npm test` with the explicit TAP reporter configured in
the package script. It extracts the actual total and requires every test to
pass (no skipped/cancelled tests counted as success). No historical count is
used as a gate. Automation regression tests use offline fetch stubs.

`verify-config.mjs` parses JSONC and checks the exact Sepolia and separately
named mainnet profiles: network, native USDC, facilitator, `$0.005`, approval
flag, Worker identity, and isolated DO/KV bindings. Errors never print config
values. `audit-facilitator-support.mjs` checks parsed `kinds[].network` values
with exact equality; it never infers `eip155:8453` from `eip155:84532`.

`.github/workflows/deploy-mainnet.yml` is `workflow_dispatch` only. It requires
the immutable 40-character event SHA and `ENABLE_BASE_MAINNET_8453`, validates
the mainnet profile, tests, typechecks, checks whitespace, and performs only a
Wrangler dry-run before the dedicated `issue-viability-mainnet` environment
approval. It does not run from a push. The all-zero mainnet KV placeholder makes
deployment fail closed until isolated Cloudflare resources are deliberately set.

`wrangler-run.mjs dry-run` invokes the locked CLI with `deploy --dry-run`:
bundle only, no upload/deployment. Raw Wrangler output is suppressed, including
on failure, because bindings and diagnostics can contain configuration.
No raw Wrangler logs are uploaded as artifacts. Investigate a failure locally
without publishing raw diagnostics. The deploy mode is restricted to the
manual master workflow context and requires the two Cloudflare credentials.
Do not emulate its approval environment locally.

Smoke requests use plain fetch, fixed public URLs, no redirects, a 45-second
per-request timeout, and no retries. They never load a wallet or use an x402
paying client. Full smoke checks health (200, payments enabled on testnet),
root (200), unpaid POST (402, exact network/price, no recommendation anywhere
in JSON), and deliberately malformed non-wallet payment input (400/402, JSON,
no recommendation). A 5xx is a smoke failure even if access was rejected.
A failure stops further requests. Exit 0 means all requested checks passed;
1 means failure; 2 means invalid CLI arguments. Bodies/headers are never logged.
The monitor mode omits the malformed request. Unpaid requests terminate at
the payment boundary before GitHub assessment. If a future regression removes
that boundary, smoke will fail; health is checked first to reduce this risk.

## CI

`.github/workflows/ci.yml` runs on pull requests targeting master, pushes to
master, and manual dispatch. It uses `contents: read`, a clean checkout,
`npm ci`, typecheck, full tests with dynamic count, configuration verification,
whitespace validation and Wrangler dry-run. Any failure stops later gates.
Pushes never initiate deployment.

## Configure GitHub before the first deployment

1. Create the **production** GitHub Environment. Configure **required reviewers**,
   preferably prevent self-review and disable administrator bypass. Restrict
   deployment branches to **master**. Verify your repository/plan supports
   these protections. Merely naming an environment in YAML does **not** set
   required reviewers; do not enable deployment credentials until configured.
2. Add environment secrets named **CLOUDFLARE_API_TOKEN** and
   **CLOUDFLARE_ACCOUNT_ID**. Scope the API token to the existing Worker account
   with Workers deployment permissions (including access to the existing KV
   binding as needed); no zone route permissions are needed for this workers.dev
   target. Use Cloudflare's Edit Cloudflare Workers template as the starting
   point and narrow its resource scope. Neither secret is created by this task.
3. Keep existing runtime secrets in Cloudflare. Do not copy GitHub assessment
   credentials, recipient configuration or wallet material into Actions.
4. Protect master and require the CI verification check before merging.

Cloudflare documents these credential names in its
[GitHub Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
GitHub documents [required reviewers and environment setup](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
No repository/environment settings were changed or verified remotely here.

## Manual production deployment and report

`.github/workflows/deploy-production.yml` runs **only on workflow_dispatch**.
Select master and paste its full commit SHA into `confirm_sha`. It must equal
the event SHA, so a branch advancing before dispatch requires a new explicit
confirmation. Both jobs check out that immutable event SHA; other branches
are skipped. Re-runs continue to use the original SHA.

The first job installs dependencies, typechecks, runs all tests, checks config
and whitespace, and completes a dry-run **without deployment credentials**.
The second job then waits for the configured production environment reviewer.
The reviewer should check the selected SHA and successful validation job.
After approval it checks out the same SHA, installs the lockfile, rechecks
config, deploys, and runs full unpaid smoke. Concurrent deployments are
serialized and running deployments are never auto-cancelled.

Only the deploy step receives the Cloudflare secrets. Manual dispatch and SHA
confirmation provide an explicit human initiation boundary; required reviewers
provide the separate post-validation approval boundary and must be configured
before use. No automatic deploy-on-push or mainnet path exists.

The job summary reports SHA, dynamically measured test count, gate results,
Worker Version ID (or unavailable if Wrangler did not expose it), deployment
UTC timestamp, safe smoke statuses, network and price. It is ephemeral Actions
run metadata, not a per-deployment repository file. Failed smoke fails the job;
a final summary still records failure. A smoke failure does **not** undo a
completed deployment: investigate and separately authorize any rollback.
Public smoke verifies behavior, not the served Worker Version ID; the latter
is obtained from Wrangler's deployment output.

## Monitoring and remaining release boundaries

`.github/workflows/monitor-production.yml` runs at **00:17, 06:17, 12:17 and
18:17 UTC** (`17 */6 * * *`) and manual dispatch. GitHub schedules can be delayed.
It needs no secrets or dependency installation. It checks only health, root
and unpaid POST. Actions failure notifications are sufficient; no issues are
created. Workflows become available after a separately authorized push;
none were pushed or run on GitHub during this task.

**TESTNET:** `eip155:84532`. The first funded Base Sepolia settlement remains
**UNVERIFIED** and is a deliberate, separately authorized manual integration
test. No CI wallet, private key request/storage/generation, funded transaction,
or fund movement is implemented. Future payment automation is considered only
after the one-time funded test proves settlement.

**REAL-MONEY:** any future Base mainnet configuration requires a separate,
explicitly authorized task and human approval. Mainnet remains **DISABLED**.
Neither master pushes nor any current workflow can activate it by configuration.
