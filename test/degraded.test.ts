/**
 * Step-F remediation — degraded-path regression tests.
 *
 * The product must never emit a clean `GO` from evidence it could not fully
 * gather. Two degraded sources are covered end to end (fetch/parse -> assess):
 *   F1 — a REST fallback result (no `willCloseTarget`, opaque connect events)
 *   F2 — a GraphQL response that carried `data.repository` alongside `errors`
 */
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { assess } from "../src/decision.ts";
import { fetchSignals, type FetchLike } from "../src/github.ts";
import { parseGraphQL } from "../src/parse.ts";

const TODAY = new Date("2026-08-30T12:00:00Z");
const iso = (daysAgo: number) => new Date(TODAY.getTime() - daysAgo * 86_400_000).toISOString();

describe("degraded paths never produce a clean GO", () => {
  it("F1: an otherwise-clean REST fallback result assesses to CAUTION, not GO", async () => {
    const restRepo = { archived: false, disabled: false, pushed_at: iso(3) };
    const restIssue = {
      state: "open",
      state_reason: null,
      created_at: iso(40),
      updated_at: iso(4),
      assignees: [],
    };
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/graphql")) return new Response("boom", { status: 503 });
      if (url.endsWith("/repos/o/r")) return new Response(JSON.stringify(restRepo));
      if (url.includes("/issues/5/timeline")) return new Response("[]");
      if (url.includes("/issues/5")) return new Response(JSON.stringify(restIssue));
      if (url.includes("/commits")) return new Response("[]");
      return new Response("nope", { status: 404 });
    };

    const signals = await fetchSignals({ owner: "o", name: "r", number: 5, token: "t", fetchImpl });
    expect(signals.source).toBe("rest");
    expect(signals.dataQuality).toBe("partial");
    expect(signals.timelineTruncated).toBe(false); // independent of data quality

    const a = assess(signals, TODAY);
    expect(a.recommendation).toBe("CAUTION");
    expect(a.reasons).toContain("assessment is based on incomplete data");
  });

  it("F2: GraphQL repository present + non-empty errors + timeline unavailable => never GO", () => {
    const body = {
      data: {
        rateLimit: { cost: 1, remaining: 4999, resetAt: iso(-1) },
        repository: {
          isArchived: false,
          isDisabled: false,
          pushedAt: iso(2),
          updatedAt: iso(3),
          defaultBranchRef: { target: { committedDate: iso(2) } },
          issueOrPullRequest: {
            __typename: "Issue",
            number: 9,
            state: "OPEN",
            stateReason: null,
            createdAt: iso(30),
            updatedAt: iso(3),
            assignees: { totalCount: 0, nodes: [] },
            timelineItems: null, // GitHub nulled the field...
          },
        },
      },
      errors: [
        {
          type: "SERVICE_UNAVAILABLE",
          message: "timeline temporarily unavailable",
          path: ["repository", "issueOrPullRequest", "timelineItems"],
        },
      ],
    };

    const signals = parseGraphQL(body);
    expect(signals.dataQuality).toBe("partial");

    const a = assess(signals, TODAY);
    expect(a.recommendation).toBe("CAUTION");
    expect(a.reasons).toContain("assessment is based on incomplete data");
  });

  it("F2: a completely clean GraphQL response (no errors) still reaches GO", () => {
    const body = {
      data: {
        rateLimit: { cost: 1, remaining: 4999, resetAt: iso(-1) },
        repository: {
          isArchived: false,
          isDisabled: false,
          pushedAt: iso(2),
          updatedAt: iso(3),
          defaultBranchRef: { target: { committedDate: iso(2) } },
          issueOrPullRequest: {
            __typename: "Issue",
            number: 9,
            state: "OPEN",
            stateReason: null,
            createdAt: iso(30),
            updatedAt: iso(3),
            assignees: { totalCount: 0, nodes: [] },
            timelineItems: { totalCount: 0, pageInfo: { hasPreviousPage: false }, nodes: [] },
          },
        },
      },
    };
    const a = assess(parseGraphQL(body), TODAY);
    expect(a.recommendation).toBe("GO");
    expect(a.data_quality).toBe("ok");
  });
});
