import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { createApp } from "../src/app.ts";
import { MemoryCache } from "../src/cache.ts";
import {
  GitHubNotAnIssueError,
  GitHubNotFoundError,
  GitHubRateLimitedError,
  GitHubUpstreamError,
  type Signals,
} from "../src/types.ts";
import { makeSignals } from "./helpers.ts";
import { MemoryRateBudget } from "../src/rate-budget.ts";

const TODAY = new Date("2026-08-30T12:00:00Z");

const NEVER = 4_102_444_800_000; // 2100-01-01 — a reset far past any test clock
const HOUR = 3_600_000;

/** Healthy authoritative-recovery stub: plenty of GraphQL budget, "never" resets. */
const FULL_BUDGET = () => Promise.resolve({ graphqlRemaining: 5_000, graphqlResetAtMs: NEVER });

/**
 * `createApp` with an already-known, ample rate budget so tests that only care
 * about assessment / cache / error behaviour are not gated on authoritative
 * recovery. A test that exercises the rate budget passes its own `rateBudget`
 * and/or `rateLimitSource`.
 */
function mk(
  env: Parameters<typeof createApp>[0] = {},
  deps: Parameters<typeof createApp>[1] = {},
) {
  return createApp(env, {
    rateLimitSource: FULL_BUDGET,
    rateBudget: new MemoryRateBudget({ remaining: 5_000, resetAtMs: NEVER, cost: 1 }),
    ...deps,
  });
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.fetch(
    new Request("http://x/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("http app", () => {
  it("GET / returns the info page", async () => {
    const res = await createApp().fetch(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect((await res.text()).includes("Issue Viability API")).toBe(true);
  });

  it("GET /health reports config", async () => {
    const res = await createApp({}, { now: () => TODAY }).fetch(new Request("http://x/health"));
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.payments).toBe("disabled");
    expect(body.utc_date).toBe("2026-08-30");
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await post(createApp(), "not json");
    expect(res.status).toBe(400);
  });

  it("rejects a bad repo slug with 400", async () => {
    const res = await post(createApp(), { repo: "not-a-slug", issue: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive issue number with 400", async () => {
    const res = await post(createApp(), { repo: "a/b", issue: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects slugs that parseRepoSlug would reject with 400, without calling the signal source", async () => {
    // These all pass a naive "one slash, no whitespace" check but are not valid
    // GitHub slugs. Before V1 they slipped past validation and threw an untyped
    // Error inside the signal source, surfacing as a misleading 502.
    let signalSourceCalled = false;
    const app = createApp(
      {},
      {
        signalSource: async () => {
          signalSourceCalled = true;
          throw new Error("signal source must not be reached for an invalid slug");
        },
      },
    );
    for (const repo of ["owner/name!", "-owner/name", "a!b/c", "owner/na@me"]) {
      const res = await post(app, { repo, issue: 1 });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe("invalid_request");
    }
    expect(signalSourceCalled).toBe(false);
  });

  it("returns an assessment and then serves it from fresh cache", async () => {
    let calls = 0;
    const app = mk(
      {},
      {
        now: () => TODAY,
        signalSource: async () => {
          calls++;
          return makeSignals();
        },
      },
    );
    const r1 = await post(app, { repo: "octocat/hello", issue: 7 });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-cache")).toBe("miss");
    const b1 = (await r1.json()) as any;
    expect(b1.recommendation).toBe("GO");

    const r2 = await post(app, { repo: "octocat/hello", issue: 7 });
    expect(r2.headers.get("x-cache")).toBe("fresh");
    expect(calls).toBe(1);
  });

  it("maps not-found to 404", async () => {
    const app = mk({}, { signalSource: async () => { throw new GitHubNotFoundError(); } });
    const res = await post(app, { repo: "a/b", issue: 1 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("not_found");
  });

  it("maps is-a-PR to 422", async () => {
    const app = mk({}, { signalSource: async () => { throw new GitHubNotAnIssueError(); } });
    const res = await post(app, { repo: "a/b", issue: 1 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error).toBe("not_an_issue");
  });

  it("maps rate-limit with no cache to 503 + Retry-After", async () => {
    const app = mk({}, { signalSource: async () => { throw new GitHubRateLimitedError(42); } });
    const res = await post(app, { repo: "a/b", issue: 1 });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("42");
  });

  it("maps upstream failure with no cache to 502", async () => {
    const app = mk({}, { signalSource: async () => { throw new GitHubUpstreamError(); } });
    const res = await post(app, { repo: "a/b", issue: 1 });
    expect(res.status).toBe(502);
  });

  it("serves stale cache (GO downgraded to CAUTION) when GitHub later fails", async () => {
    const cache = new MemoryCache();
    let clock = TODAY.getTime();
    let mode: "ok" | "fail" = "ok";
    const app = mk(
      {},
      {
        cache,
        now: () => new Date(clock),
        signalSource: async () => {
          if (mode === "fail") throw new GitHubUpstreamError();
          return makeSignals(); // clean => GO
        },
      },
    );

    const fresh = await post(app, { repo: "a/b", issue: 1 });
    expect(((await fresh.json()) as any).recommendation).toBe("GO");

    // advance 700s: inside stale window (600..3600), and break GitHub
    clock += 700_000;
    mode = "fail";
    const stale = await post(app, { repo: "a/b", issue: 1 });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-cache")).toBe("stale");
    const body = (await stale.json()) as any;
    expect(body.recommendation).toBe("CAUTION");
    expect(body.data_quality).toBe("stale");
  });

  it("loads fixtures when IVA_DEV_FIXTURES is set", async () => {
    const dir = fileURLToPath(new URL("./fixtures/raw", import.meta.url));
    const app = createApp({ IVA_DEV_FIXTURES: dir, IVA_NOW: "2026-08-30T12:00:00Z" });
    const res = await post(app, { repo: "cli/cli", issue: 14293 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).recommendation).toBe("GO");
  });
});

describe("RATE_LIMIT_FLOOR enforcement (atomic reservation + authoritative recovery)", () => {
  /** A GET /rate_limit stub reporting `remaining`, resetting `resetAtMs`. */
  const rl = (remaining: number, resetAtMs: number) => async () => ({
    graphqlRemaining: remaining,
    graphqlResetAtMs: resetAtMs,
  });

  it("cold start: the first request bounces 503 while it learns the budget, then assessments flow", async () => {
    let rlCalls = 0;
    let sigCalls = 0;
    const clock = TODAY.getTime();
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: async () => { rlCalls++; return { graphqlRemaining: 5_000, graphqlResetAtMs: clock + HOUR }; },
        signalSource: async () => { sigCalls++; return makeSignals(); },
      },
    );

    const first = await post(app, { repo: "a/b", issue: 1 });
    expect(first.status).toBe(503);
    expect(((await first.json()) as any).error).toBe("rate_limited");
    expect(rlCalls).toBe(1);
    expect(sigCalls).toBe(0); // NO chargeable assessment is used to discover the budget

    const second = await post(app, { repo: "a/b", issue: 1 });
    expect(second.status).toBe(200);
    expect(sigCalls).toBe(1);
    expect(rlCalls).toBe(1); // budget already known — no second GET /rate_limit
  });

  it("20 concurrent cold-start requests trigger exactly ONE GET /rate_limit; none is admitted", async () => {
    let rlCalls = 0;
    const clock = TODAY.getTime();
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: async () => { rlCalls++; await Promise.resolve(); return { graphqlRemaining: 5_000, graphqlResetAtMs: clock + HOUR }; },
        signalSource: async () => makeSignals(),
      },
    );

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(app, { repo: "a/b", issue: i + 1 })),
    );
    expect(rlCalls).toBe(1);
    expect(results.every((r) => r.status === 503)).toBe(true);
  });

  it("blocks a live call with 503 + Retry-After once reserving one would breach the floor", async () => {
    let calls = 0;
    const clock = TODAY.getTime();
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: rl(100, clock + 30 * 60_000), // recovery learns remaining = 100
        signalSource: async () => { calls++; return makeSignals(); },
      },
    );

    // request 1: recovery election -> learns 100 -> 503
    expect((await post(app, { repo: "a/b", issue: 1 })).status).toBe(503);

    // request 2: 100 - 1 < 150 -> blocked, GitHub untouched
    const blocked = await post(app, { repo: "a/b", issue: 2 });
    expect(blocked.status).toBe(503);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await blocked.json()) as any).error).toBe("rate_limited");
    expect(calls).toBe(0);
  });

  it("below the floor, serves a valid stale cache instead of 503", async () => {
    let clock = TODAY.getTime();
    const resetAtMs = clock + HOUR;
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: rl(151, resetAtMs), // one call of headroom above the floor
        signalSource: async () =>
          makeSignals({ rateLimit: { cost: 1, remaining: 100, resetAt: new Date(resetAtMs).toISOString() } }),
      },
    );

    expect((await post(app, { repo: "a/b", issue: 1 })).status).toBe(503); // recovery -> 151
    const ok = await post(app, { repo: "a/b", issue: 1 }); // admitted; caches; folds 100 in (same window)
    expect(ok.status).toBe(200);

    clock += 700_000; // into the stale window; budget is now 100 < floor
    const stale = await post(app, { repo: "a/b", issue: 1 });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-cache")).toBe("stale");
    const body = (await stale.json()) as any;
    expect(body.recommendation).toBe("CAUTION"); // GO downgraded for stale delivery
    expect(body.data_quality).toBe("stale");
  });

  it("a failed GET /rate_limit recovery admits ZERO assessments and returns 503 + backoff", async () => {
    let sigCalls = 0;
    const app = createApp(
      {},
      {
        now: () => TODAY,
        rateLimitSource: async () => { throw new GitHubUpstreamError("rate_limit unreachable"); },
        signalSource: async () => { sigCalls++; return makeSignals(); },
      },
    );

    const r1 = await post(app, { repo: "a/b", issue: 1 });
    expect(r1.status).toBe(503);
    expect(((await r1.json()) as any).error).toBe("rate_limited");
    expect(Number(r1.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(sigCalls).toBe(0);

    // a subsequent attempt still never falls back to a chargeable assessment
    expect((await post(app, { repo: "a/b", issue: 2 })).status).toBe(503);
    expect(sigCalls).toBe(0);
  });

  it("a secondary-limited GET /rate_limit honours the server's conservative Retry-After", async () => {
    const app = createApp(
      {},
      {
        now: () => TODAY,
        rateLimitSource: async () => { throw new GitHubRateLimitedError(120); },
        signalSource: async () => makeSignals(),
      },
    );
    const r = await post(app, { repo: "a/b", issue: 1 });
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("120");
  });

  it("after the window resets, a fresh GET /rate_limit is required before the next assessment", async () => {
    let rlCalls = 0;
    let sigCalls = 0;
    let clock = TODAY.getTime();
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: async () => { rlCalls++; return { graphqlRemaining: 5_000, graphqlResetAtMs: clock + HOUR }; },
        // observed rateLimit stays in the recovered window (no window advance)
        signalSource: async () => {
          sigCalls++;
          return makeSignals({ rateLimit: { cost: 1, remaining: 5_000, resetAt: new Date(clock + HOUR).toISOString() } });
        },
      },
    );

    expect((await post(app, { repo: "a/b", issue: 1 })).status).toBe(503); // recovery #1
    expect((await post(app, { repo: "a/b", issue: 1 })).status).toBe(200); // assessment
    expect(rlCalls).toBe(1);
    expect(sigCalls).toBe(1);

    clock += HOUR + 1; // window elapsed
    const afterReset = await post(app, { repo: "a/b", issue: 2 });
    expect(afterReset.status).toBe(503); // must recover again, NOT assess
    expect(sigCalls).toBe(1); // no chargeable assessment on expiry
    expect(rlCalls).toBe(2); // a second GET /rate_limit

    expect((await post(app, { repo: "a/b", issue: 2 })).status).toBe(200);
    expect(sigCalls).toBe(2);
  });

  it("a reserveLiveCall store failure blocks the request — never bypasses the floor", async () => {
    let signalCalls = 0;
    const app = createApp(
      {},
      {
        now: () => TODAY,
        rateBudget: {
          reserveLiveCall: async () => { throw new Error("budget store down"); },
          reconcile: async () => {},
          recover: async () => {},
        },
        signalSource: async () => { signalCalls++; return makeSignals(); },
      },
    );
    const res = await post(app, { repo: "a/b", issue: 1 });
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(signalCalls).toBe(0);
  });

  it("HIGH 1: a possibly-charged request whose reconcile fails is held to the window reset, not a short TTL", async () => {
    const inner = new MemoryRateBudget();
    let clock = TODAY.getTime();
    let failReconcile = false;
    let mode: "ok" | "throw" = "ok";
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: async () => ({ graphqlRemaining: 151, graphqlResetAtMs: clock + HOUR }),
        rateBudget: {
          reserveLiveCall: (n) => inner.reserveLiveCall(n),
          reconcile: async (id, result, n) => {
            if (failReconcile) throw new Error("reconcile store down");
            return inner.reconcile(id, result, n);
          },
          recover: (t, r, n) => inner.recover(t, r, n),
        },
        signalSource: async () => {
          if (mode === "throw") throw new GitHubUpstreamError();
          return makeSignals({ rateLimit: { cost: 1, remaining: 151, resetAt: new Date(clock + HOUR).toISOString() } });
        },
      },
    );

    // req 1: recovery election -> learns 151 (one call of headroom) -> 503
    expect((await post(app, { repo: "a/b", issue: 1 })).status).toBe(503);

    // req 2: admitted (151 - 1 = 150). The GraphQL request is dispatched (maybe
    // charged), then BOTH the fetch fails AND the indeterminate reconcile write
    // fails (swallowed). The reservation stays plain.
    mode = "throw";
    failReconcile = true;
    expect((await post(app, { repo: "a/b", issue: 2 })).status).toBe(502);
    failReconcile = false;
    mode = "ok";

    // The window is known, so normalize holds that plain reservation to the
    // reset. 151 - (1 held + 1 new) = 149 < 150 -> blocked.
    expect((await post(app, { repo: "a/b", issue: 3 })).status).toBe(503);

    // Well past any short orphan TTL: STILL blocked. Under the bug the plain
    // reservation would have been pruned and a call re-admitted while real
    // GitHub remaining is already 150.
    clock += 10 * 60_000;
    expect((await post(app, { repo: "a/b", issue: 4 })).status).toBe(503);

    // Once the window resets the state returns to recovery-required — never a
    // silent re-admit against a stale-high budget.
    clock += HOUR;
    const afterReset = await post(app, { repo: "a/b", issue: 5 });
    expect(afterReset.status).toBe(503);
    expect(((await afterReset.json()) as any).error).toBe("rate_limited");
  });

  it("an ambiguous GitHub failure keeps its reserved cost debited until the window resets", async () => {
    let clock = TODAY.getTime();
    let mode: "ok" | "throw" = "ok";
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: async () => ({ graphqlRemaining: 151, graphqlResetAtMs: clock + HOUR }),
        signalSource: async () => {
          if (mode === "throw") throw new GitHubUpstreamError(); // timeout / transport loss
          return makeSignals({ rateLimit: { cost: 1, remaining: 151, resetAt: new Date(clock + HOUR).toISOString() } });
        },
      },
    );

    expect((await post(app, { repo: "a/b", issue: 1 })).status).toBe(503); // recovery -> 151

    // req 2: the GraphQL call may have been charged but we got nothing back
    mode = "throw";
    expect((await post(app, { repo: "a/b", issue: 2 })).status).toBe(502);

    // req 3: 151 - (1 indeterminate + 1 new) = 149 < 150 -> blocked.
    // Under a released-on-failure bug this would be 151 - 1 = 150 -> admitted.
    mode = "ok";
    expect((await post(app, { repo: "a/b", issue: 3 })).status).toBe(503);

    // still blocked well past any short interval (the debit is held to the reset)
    clock += 10 * 60_000;
    expect((await post(app, { repo: "a/b", issue: 4 })).status).toBe(503);

    // past resetAt: window refills -> recovery-required again, then admitted
    clock += HOUR;
    expect((await post(app, { repo: "a/b", issue: 5 })).status).toBe(503); // fresh recovery
    expect((await post(app, { repo: "a/b", issue: 5 })).status).toBe(200);
  });

  it("resumes assessments after the rate-limit window resets", async () => {
    let sigCalls = 0;
    let remaining = 10;
    let clock = TODAY.getTime();
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: async () => ({ graphqlRemaining: remaining, graphqlResetAtMs: clock + 1_000_000 }),
        signalSource: async () => { sigCalls++; return makeSignals(); },
      },
    );

    expect((await post(app, { repo: "a/b", issue: 1 })).status).toBe(503); // recovery -> remaining 10
    expect((await post(app, { repo: "a/b", issue: 2 })).status).toBe(503); // 10 - 1 < 150
    expect(sigCalls).toBe(0);

    clock += 1_000_001; // past resetAt
    remaining = 5_000; // budget refilled on the new window
    expect((await post(app, { repo: "a/b", issue: 3 })).status).toBe(503); // fresh recovery election
    expect((await post(app, { repo: "a/b", issue: 3 })).status).toBe(200); // admitted
    expect(sigCalls).toBe(1);
  });

  it("round 4: a failed recovery persists a backoff — later callers cause zero GET /rate_limit and zero assessments", async () => {
    let rlCalls = 0;
    let sigCalls = 0;
    let clock = TODAY.getTime();
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: async () => { rlCalls++; throw new GitHubUpstreamError("rate_limit unreachable"); },
        signalSource: async () => { sigCalls++; return makeSignals(); },
      },
    );

    // first request: one election -> one GET /rate_limit -> fails -> backoff persisted
    expect((await post(app, { repo: "a/b", issue: 1 })).status).toBe(503);
    expect(rlCalls).toBe(1);

    // 20 more callers a few seconds later, still inside the ~60s backoff
    clock += 5_000;
    const during = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(app, { repo: "a/b", issue: i + 2 })),
    );
    expect(during.every((r) => r.status === 503)).toBe(true);
    expect(rlCalls).toBe(1); // NO new GET /rate_limit while the backoff holds
    expect(sigCalls).toBe(0); // and never a chargeable assessment
  });

  it("round 4: a secondary-limited recovery persists the server Retry-After as the backoff window", async () => {
    let rlCalls = 0;
    let clock = TODAY.getTime();
    const app = createApp(
      {},
      {
        now: () => new Date(clock),
        rateLimitSource: async () => { rlCalls++; throw new GitHubRateLimitedError(120); },
        signalSource: async () => makeSignals(),
      },
    );

    const r1 = await post(app, { repo: "a/b", issue: 1 });
    expect(r1.status).toBe(503);
    expect(r1.headers.get("retry-after")).toBe("120");
    expect(rlCalls).toBe(1);

    // 90s later: still inside the 120s backoff -> no fresh GET /rate_limit
    clock += 90_000;
    expect((await post(app, { repo: "a/b", issue: 2 })).status).toBe(503);
    expect(rlCalls).toBe(1);

    // past 120s: a fresh election is allowed again
    clock += 31_000;
    await post(app, { repo: "a/b", issue: 3 });
    expect(rlCalls).toBe(2);
  });
});
