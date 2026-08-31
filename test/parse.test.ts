import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { parseGraphQL, parseRest } from "../src/parse.ts";
import { GitHubNotAnIssueError, GitHubNotFoundError } from "../src/types.ts";

function repo(issueOrPullRequest: unknown, over: Record<string, unknown> = {}) {
  return {
    data: {
      rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-08-30T13:00:00Z" },
      repository: {
        isArchived: false,
        isDisabled: false,
        pushedAt: "2026-08-20T00:00:00Z",
        updatedAt: "2026-08-25T00:00:00Z",
        defaultBranchRef: { target: { committedDate: "2026-08-20T00:00:00Z" } },
        issueOrPullRequest,
        ...over,
      },
    },
  };
}

function issue(nodes: unknown[], over: Record<string, unknown> = {}) {
  return {
    __typename: "Issue",
    number: 123,
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-08-25T00:00:00Z",
    assignees: { totalCount: 0, nodes: [] },
    timelineItems: { totalCount: nodes.length, pageInfo: { hasPreviousPage: false }, nodes },
    ...over,
  };
}

const pr = (over: Record<string, unknown> = {}) => ({
  __typename: "PullRequest",
  number: 500,
  state: "OPEN",
  isDraft: false,
  merged: false,
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-28T00:00:00Z",
  author: { __typename: "User", login: "dev" },
  ...over,
});

describe("parseGraphQL — errors", () => {
  it("null repository with NOT_FOUND => GitHubNotFoundError", () => {
    expect(() =>
      parseGraphQL({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "x" }] }),
    ).toThrow(GitHubNotFoundError);
  });

  it("null issueOrPullRequest => GitHubNotFoundError", () => {
    expect(() => parseGraphQL(repo(null))).toThrow(GitHubNotFoundError);
  });

  it("node is a PullRequest => GitHubNotAnIssueError", () => {
    expect(() => parseGraphQL(repo({ __typename: "PullRequest", number: 123 }))).toThrow(
      GitHubNotAnIssueError,
    );
  });
});

describe("parseGraphQL — competitors", () => {
  it("cross reference with willCloseTarget=true => high confidence closing-reference", () => {
    const s = parseGraphQL(
      repo(issue([{ __typename: "CrossReferencedEvent", createdAt: "2026-08-20T00:00:00Z", willCloseTarget: true, source: pr({ number: 501 }) }])),
    );
    expect(s.competitors).toHaveLength(1);
    expect(s.competitors[0]).toMatchObject({ number: 501, highConfidence: true, linkKind: "closing-reference" });
  });

  it("bare cross reference (willCloseTarget=false) => low confidence mention", () => {
    const s = parseGraphQL(
      repo(issue([{ __typename: "CrossReferencedEvent", createdAt: "2026-08-20T00:00:00Z", willCloseTarget: false, source: pr({ number: 502 }) }])),
    );
    expect(s.competitors[0]).toMatchObject({ number: 502, highConfidence: false, linkKind: "mention" });
  });

  it("ConnectedEvent => high confidence; later DisconnectedEvent cancels it", () => {
    const connected = { __typename: "ConnectedEvent", createdAt: "2026-08-10T00:00:00Z", subject: pr({ number: 503 }), source: null };
    const disconnected = { __typename: "DisconnectedEvent", createdAt: "2026-08-20T00:00:00Z", subject: { __typename: "PullRequest", number: 503 }, source: null };

    const stillLinked = parseGraphQL(repo(issue([connected])));
    expect(stillLinked.competitors[0]).toMatchObject({ number: 503, highConfidence: true, linkKind: "connected" });

    const cancelled = parseGraphQL(repo(issue([connected, disconnected])));
    expect(cancelled.competitors[0]).toMatchObject({ number: 503, highConfidence: false, linkKind: "mention" });
  });

  it("reconnect after disconnect restores high confidence", () => {
    const nodes = [
      { __typename: "ConnectedEvent", createdAt: "2026-08-01T00:00:00Z", subject: pr({ number: 504 }), source: null },
      { __typename: "DisconnectedEvent", createdAt: "2026-08-05T00:00:00Z", subject: { __typename: "PullRequest", number: 504 }, source: null },
      { __typename: "ConnectedEvent", createdAt: "2026-08-10T00:00:00Z", subject: pr({ number: 504 }), source: null },
    ];
    expect(parseGraphQL(repo(issue(nodes))).competitors[0]).toMatchObject({ highConfidence: true });
  });

  it("merged PR is reported as MERGED even if state field lags", () => {
    const s = parseGraphQL(
      repo(issue([{ __typename: "CrossReferencedEvent", createdAt: "2026-08-20T00:00:00Z", willCloseTarget: true, source: pr({ number: 505, state: "OPEN", merged: true }) }])),
    );
    expect(s.competitors[0]!.state).toBe("MERGED");
    expect(s.competitors[0]!.merged).toBe(true);
  });

  it("known maintenance bot (allowlisted login) => authorIsIgnoredBot true", () => {
    const s = parseGraphQL(
      repo(issue([{ __typename: "CrossReferencedEvent", createdAt: "2026-08-20T00:00:00Z", willCloseTarget: false, source: pr({ number: 506, author: { __typename: "Bot", login: "renovate[bot]" } }) }])),
    );
    expect(s.competitors[0]!.authorIsIgnoredBot).toBe(true);
  });

  it("UNKNOWN bot is NOT ignored — __typename:'Bot' and '[bot]' suffix are not enough", () => {
    const s = parseGraphQL(
      repo(
        issue([
          {
            __typename: "CrossReferencedEvent",
            createdAt: "2026-08-20T00:00:00Z",
            willCloseTarget: true,
            source: pr({ number: 777, author: { __typename: "Bot", login: "some-coding-agent[bot]" } }),
          },
        ]),
      ),
    );
    expect(s.competitors[0]!.authorIsIgnoredBot).toBe(false);
    expect(s.competitors[0]).toMatchObject({ number: 777, highConfidence: true });
  });

  it("deduplicates multiple events for the same PR number", () => {
    const nodes = [
      { __typename: "CrossReferencedEvent", createdAt: "2026-08-18T00:00:00Z", willCloseTarget: false, source: pr({ number: 507 }) },
      { __typename: "ConnectedEvent", createdAt: "2026-08-19T00:00:00Z", subject: pr({ number: 507 }), source: null },
    ];
    const s = parseGraphQL(repo(issue(nodes)));
    expect(s.competitors).toHaveLength(1);
    expect(s.competitors[0]).toMatchObject({ number: 507, highConfidence: true });
  });
});

describe("parseGraphQL — assignees, state, truncation", () => {
  it("lastAssignedAt resolves to the current assignee's AssignedEvent", () => {
    const s = parseGraphQL(
      repo(
        issue(
          [
            { __typename: "AssignedEvent", createdAt: "2026-07-01T00:00:00Z", assignee: { __typename: "User", login: "alice" } },
            { __typename: "AssignedEvent", createdAt: "2026-05-01T00:00:00Z", assignee: { __typename: "User", login: "ghost" } },
            { __typename: "UnassignedEvent", createdAt: "2026-06-01T00:00:00Z", assignee: { __typename: "User", login: "ghost" } },
          ],
          { assignees: { totalCount: 1, nodes: [{ login: "alice" }] } },
        ),
      ),
    );
    expect(s.assignees).toEqual(["alice"]);
    expect(s.lastAssignedAt).toBe("2026-07-01T00:00:00Z");
  });

  it("assignee with no matching AssignedEvent (truncated history) => lastAssignedAt null", () => {
    const s = parseGraphQL(
      repo(issue([], { assignees: { totalCount: 1, nodes: [{ login: "nobodyknows" }] } })),
    );
    expect(s.lastAssignedAt).toBeNull();
  });

  it("hasPreviousPage => timelineTruncated + partial data quality", () => {
    const s = parseGraphQL(
      repo(issue([], { timelineItems: { totalCount: 200, pageInfo: { hasPreviousPage: true }, nodes: [] } })),
    );
    expect(s.timelineTruncated).toBe(true);
    expect(s.dataQuality).toBe("partial");
  });

  it("closed issue with reason is lower-cased", () => {
    const s = parseGraphQL(repo(issue([], { state: "CLOSED", stateReason: "NOT_PLANNED" })));
    expect(s.issueState).toBe("closed");
    expect(s.stateReason).toBe("not_planned");
  });
});

describe("parseRest — fallback", () => {
  const restRepo = { archived: false, disabled: false, pushed_at: "2026-08-20T00:00:00Z" };
  const restIssue = {
    state: "open",
    state_reason: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
    assignees: [],
  };

  it("issue carrying pull_request => GitHubNotAnIssueError", () => {
    expect(() =>
      parseRest({ repo: restRepo, issue: { ...restIssue, pull_request: {} }, timeline: [], timelineTruncated: false }),
    ).toThrow(GitHubNotAnIssueError);
  });

  it("cross-referenced PR becomes a LOW-confidence competitor", () => {
    const s = parseRest({
      repo: restRepo,
      issue: restIssue,
      timeline: [
        {
          event: "cross-referenced",
          created_at: "2026-08-20T00:00:00Z",
          source: {
            type: "issue",
            issue: {
              number: 999,
              state: "open",
              draft: false,
              pull_request: {},
              created_at: "2026-08-10T00:00:00Z",
              updated_at: "2026-08-24T00:00:00Z",
              user: { login: "dev", type: "User" },
            },
          },
        },
      ],
      timelineTruncated: false,
    });
    expect(s.source).toBe("rest");
    expect(s.competitors).toHaveLength(1);
    expect(s.competitors[0]).toMatchObject({ number: 999, highConfidence: false });
  });

  it("REST result is always dataQuality 'partial', even when the timeline is not truncated", () => {
    const s = parseRest({ repo: restRepo, issue: restIssue, timeline: [], timelineTruncated: false });
    expect(s.source).toBe("rest");
    expect(s.dataQuality).toBe("partial");
    expect(s.timelineTruncated).toBe(false); // still reported independently
  });

  it("archived repo flag is read", () => {
    const s = parseRest({
      repo: { ...restRepo, archived: true },
      issue: restIssue,
      timeline: [],
      timelineTruncated: false,
    });
    expect(s.repoArchived).toBe(true);
  });
});
