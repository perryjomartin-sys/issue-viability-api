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

const TODAY = new Date("2026-08-30T12:00:00Z");

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
    const app = createApp(
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
    const app = createApp({}, { signalSource: async () => { throw new GitHubNotFoundError(); } });
    const res = await post(app, { repo: "a/b", issue: 1 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("not_found");
  });

  it("maps is-a-PR to 422", async () => {
    const app = createApp({}, { signalSource: async () => { throw new GitHubNotAnIssueError(); } });
    const res = await post(app, { repo: "a/b", issue: 1 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error).toBe("not_an_issue");
  });

  it("maps rate-limit with no cache to 503 + Retry-After", async () => {
    const app = createApp({}, { signalSource: async () => { throw new GitHubRateLimitedError(42); } });
    const res = await post(app, { repo: "a/b", issue: 1 });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("42");
  });

  it("maps upstream failure with no cache to 502", async () => {
    const app = createApp({}, { signalSource: async () => { throw new GitHubUpstreamError(); } });
    const res = await post(app, { repo: "a/b", issue: 1 });
    expect(res.status).toBe(502);
  });

  it("serves stale cache (GO downgraded to CAUTION) when GitHub later fails", async () => {
    const cache = new MemoryCache();
    let clock = TODAY.getTime();
    let mode: "ok" | "fail" = "ok";
    const app = createApp(
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
