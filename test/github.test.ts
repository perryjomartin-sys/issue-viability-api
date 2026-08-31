import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { fetchSignals, parseRepoSlug, type FetchLike } from "../src/github.ts";
import {
  GitHubNotAnIssueError,
  GitHubNotFoundError,
  GitHubRateLimitedError,
  GitHubUpstreamError,
} from "../src/types.ts";

const realGraphqlBody = readFileSync(
  new URL("./fixtures/raw/rust-lang__rust__44975.json", import.meta.url),
  "utf8",
);

function res(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "application/json" },
  });
}

const opts = (fetchImpl: FetchLike) => ({
  owner: "rust-lang",
  name: "rust",
  number: 44975,
  token: "t",
  fetchImpl,
});

describe("parseRepoSlug", () => {
  it("accepts owner/name and strips .git", () => {
    expect(parseRepoSlug("cli/cli")).toEqual({ owner: "cli", name: "cli" });
    expect(parseRepoSlug(" facebook/react.git ")).toEqual({ owner: "facebook", name: "react" });
  });
  it("rejects malformed slugs", () => {
    expect(() => parseRepoSlug("nope")).toThrow();
    expect(() => parseRepoSlug("a/b/c")).toThrow();
  });
});

describe("fetchSignals — orchestration", () => {
  it("uses the GraphQL result when the call succeeds", async () => {
    const s = await fetchSignals(opts(async () => res(realGraphqlBody)));
    expect(s.source).toBe("graphql");
    expect(s.issueState).toBe("open");
  });

  it("propagates NOT_FOUND without attempting REST", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return res({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "x" }] });
    };
    let threw: unknown;
    try {
      await fetchSignals(opts(fetchImpl));
    } catch (e) {
      threw = e;
    }
    expect(threw instanceof GitHubNotFoundError).toBe(true);
    expect(calls).toBe(1); // GraphQL only; no REST fan-out on NOT_FOUND
  });

  it("maps 403 with x-ratelimit-remaining:0 to GitHubRateLimitedError", async () => {
    const fetchImpl: FetchLike = async () =>
      res("rate limit exceeded", { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "30" } });
    let threw: unknown;
    try {
      await fetchSignals(opts(fetchImpl));
    } catch (e) {
      threw = e;
    }
    expect(threw instanceof GitHubRateLimitedError).toBe(true);
    expect((threw as GitHubRateLimitedError).retryAfterSeconds).toBe(30);
  });

  it("falls back to REST when GraphQL returns 5xx", async () => {
    const restRepo = { archived: false, disabled: false, pushed_at: "2026-08-20T00:00:00Z" };
    const restIssue = {
      state: "open",
      state_reason: null,
      created_at: "2020-01-01T00:00:00Z",
      updated_at: "2026-08-25T00:00:00Z",
      assignees: [],
    };
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/graphql")) return res("boom", { status: 502, headers: {} });
      if (url.endsWith("/repos/rust-lang/rust")) return res(restRepo);
      if (url.includes("/issues/44975/timeline")) return res([]);
      if (url.includes("/issues/44975")) return res(restIssue);
      if (url.includes("/commits")) return res([]);
      return res("nope", { status: 404, headers: {} });
    };
    const s = await fetchSignals(opts(fetchImpl));
    expect(s.source).toBe("rest");
    expect(s.issueState).toBe("open");
  });

  it("throws GitHubUpstreamError when both GraphQL and REST fail", async () => {
    const fetchImpl: FetchLike = async () => res("down", { status: 503, headers: {} });
    let threw: unknown;
    try {
      await fetchSignals(opts(fetchImpl));
    } catch (e) {
      threw = e;
    }
    expect(threw instanceof GitHubUpstreamError).toBe(true);
  });

  it("REST fallback still surfaces 'number is a PR'", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/graphql")) return res("boom", { status: 500, headers: {} });
      if (url.endsWith("/repos/rust-lang/rust")) return res({ archived: false, disabled: false, pushed_at: "2026-08-20T00:00:00Z" });
      if (url.includes("/issues/44975")) return res({ state: "open", pull_request: { url: "x" }, assignees: [] });
      return res([]);
    };
    let threw: unknown;
    try {
      await fetchSignals(opts(fetchImpl));
    } catch (e) {
      threw = e;
    }
    expect(threw instanceof GitHubNotAnIssueError).toBe(true);
  });
});
