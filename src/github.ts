import { parseGraphQL, parseRest, type RestInputs } from "./parse.ts";
import { ISSUE_VIABILITY_QUERY } from "./query.ts";
import {
  GitHubNotAnIssueError,
  GitHubNotFoundError,
  GitHubRateLimitedError,
  GitHubUpstreamError,
  type Signals,
} from "./types.ts";
import { CONFIG } from "./config.ts";

const GRAPHQL_URL = "https://api.github.com/graphql";
const REST_ROOT = "https://api.github.com";
const USER_AGENT = "issue-viability-api/0.1 (+https://github.com/)";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchSignalsOptions {
  owner: string;
  name: string;
  number: number;
  token: string;
  fetchImpl?: FetchLike;
  /** Allow more time before falling back / failing. Milliseconds. */
  timeoutMs?: number;
}

export function parseRepoSlug(slug: string): { owner: string; name: string } {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(slug.trim());
  if (!m) throw new Error(`invalid repo slug: ${JSON.stringify(slug)} (expected "owner/name")`);
  return { owner: m[1]!, name: m[2]!.replace(/\.git$/, "") };
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };
}

function retryAfterFrom(res: Response): number {
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra, 3600);
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(1, Math.min(3600, Math.ceil(reset - Date.now() / 1000)));
  }
  return 60;
}

/* ------------------------------- GraphQL path ------------------------------ */

async function tryGraphQL(o: Required<FetchSignalsOptions>): Promise<Signals> {
  const { signal, done } = withTimeout(o.timeoutMs);
  let res: Response;
  try {
    res = await o.fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: { ...headers(o.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: ISSUE_VIABILITY_QUERY,
        variables: { owner: o.owner, name: o.name, number: o.number },
      }),
      signal,
    });
  } finally {
    done();
  }

  if (res.status === 401) throw new GitHubUpstreamError("GitHub rejected the credential (401)");
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(await safeText(res))) {
      throw new GitHubRateLimitedError(retryAfterFrom(res));
    }
    throw new GitHubUpstreamError(`GitHub returned ${res.status}`);
  }
  if (res.status >= 500) throw new GitHubUpstreamError(`GitHub returned ${res.status}`);
  if (!res.ok) throw new GitHubUpstreamError(`GitHub returned ${res.status}`);

  const body = (await res.json()) as { data?: any; errors?: Array<{ type?: string; message?: string }> };

  if (body.errors?.some((e) => e.type === "RATE_LIMITED")) {
    throw new GitHubRateLimitedError(60, "GitHub GraphQL rate limit exhausted");
  }
  // parseGraphQL decides NOT_FOUND vs. usable data; other GraphQL errors with
  // a usable `data.repository` are tolerated (partial fields).
  return parseGraphQL(body);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.clone().text();
  } catch {
    return "";
  }
}

/* -------------------------------- REST path ------------------------------- */

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  signal: AbortSignal,
): Promise<{ status: number; json: any; linkNext: boolean }> {
  const res = await fetchImpl(url, { headers: headers(token), signal });
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get("x-ratelimit-remaining") === "0") throw new GitHubRateLimitedError(retryAfterFrom(res));
  }
  const linkNext = /rel="next"/.test(res.headers.get("link") ?? "");
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* leave null */
  }
  return { status: res.status, json, linkNext };
}

async function tryRest(o: Required<FetchSignalsOptions>): Promise<Signals> {
  const { signal, done } = withTimeout(o.timeoutMs);
  const base = `${REST_ROOT}/repos/${o.owner}/${o.name}`;
  try {
    const [repo, issue] = await Promise.all([
      getJson(o.fetchImpl, base, o.token, signal),
      getJson(o.fetchImpl, `${base}/issues/${o.number}`, o.token, signal),
    ]);

    if (repo.status === 404 || issue.status === 404) throw new GitHubNotFoundError();
    if (repo.status >= 500 || issue.status >= 500 || !repo.json || !issue.json) {
      throw new GitHubUpstreamError("GitHub REST unavailable");
    }
    if (issue.json.pull_request) throw new GitHubNotAnIssueError();

    const [timeline, commits] = await Promise.all([
      getJson(
        o.fetchImpl,
        `${base}/issues/${o.number}/timeline?per_page=${CONFIG.TIMELINE_PAGE_SIZE}`,
        o.token,
        signal,
      ),
      getJson(o.fetchImpl, `${base}/commits?per_page=1`, o.token, signal),
    ]);

    const inputs: RestInputs = {
      repo: repo.json,
      issue: issue.json,
      timeline: Array.isArray(timeline.json) ? timeline.json : [],
      timelineTruncated: timeline.linkNext,
      commits: Array.isArray(commits.json) ? commits.json : undefined,
    };
    return parseRest(inputs);
  } finally {
    done();
  }
}

/* -------------------------------- orchestrator ---------------------------- */

/**
 * Fetch and normalise every signal for one issue.
 * GraphQL first (1 request). On transport failure (not "not found", not
 * "rate limited", not "is a PR") fall back to REST. Propagate typed errors.
 */
export async function fetchSignals(opts: FetchSignalsOptions): Promise<Signals> {
  const o: Required<FetchSignalsOptions> = {
    fetchImpl: opts.fetchImpl ?? (globalThis.fetch as FetchLike),
    timeoutMs: opts.timeoutMs ?? 6000,
    ...opts,
  };
  if (!o.token) throw new GitHubUpstreamError("no GitHub token configured");

  try {
    return await tryGraphQL(o);
  } catch (err) {
    if (
      err instanceof GitHubNotFoundError ||
      err instanceof GitHubNotAnIssueError ||
      err instanceof GitHubRateLimitedError
    ) {
      throw err;
    }
    // GitHubUpstreamError, AbortError, network error -> REST fallback
    try {
      return await tryRest(o);
    } catch (restErr) {
      if (
        restErr instanceof GitHubNotFoundError ||
        restErr instanceof GitHubNotAnIssueError ||
        restErr instanceof GitHubRateLimitedError
      ) {
        throw restErr;
      }
      throw new GitHubUpstreamError(
        `GitHub unavailable via GraphQL and REST: ${(err as Error).message}`,
      );
    }
  }
}
