import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { RULES, assess } from "../src/decision.ts";
import { TODAY, daysAgo, makeCompetitor, makeSignals } from "./helpers.ts";

describe("decision engine — recommendations", () => {
  it("clean open unassigned issue in an active repo => GO", () => {
    const a = assess(makeSignals(), TODAY);
    expect(a.recommendation).toBe("GO");
    expect(a.risk).toBe("low");
    expect(a.assigned).toBe(false);
    expect(a.open_competing_prs).toBe(0);
    expect(a.reasons).toHaveLength(1);
  });

  it("closed issue => REJECT regardless of other signals", () => {
    const a = assess(
      makeSignals({ issueState: "closed", stateReason: "completed", assignees: ["x"] }),
      TODAY,
    );
    expect(a.recommendation).toBe("REJECT");
    expect(a.risk).toBe("high");
    expect(a.reasons[0]).toContain("closed");
  });

  it("archived repository => REJECT", () => {
    const a = assess(makeSignals({ repoArchived: true }), TODAY);
    expect(a.recommendation).toBe("REJECT");
    expect(a.reasons).toContain("repository is archived");
  });

  it("merged high-confidence (closing-reference) PR => REJECT", () => {
    const a = assess(
      makeSignals({
        competitors: [
          makeCompetitor({
            number: 42,
            state: "MERGED",
            merged: true,
            highConfidence: true,
            linkKind: "closing-reference",
          }),
        ],
      }),
      TODAY,
    );
    expect(a.recommendation).toBe("REJECT");
    expect(a.reasons[0]).toContain("#42");
  });

  it("active high-confidence open PR (updated within 14d) => REJECT", () => {
    const a = assess(
      makeSignals({
        competitors: [
          makeCompetitor({ number: 7, highConfidence: true, linkKind: "connected", updatedAt: daysAgo(3) }),
        ],
      }),
      TODAY,
    );
    expect(a.recommendation).toBe("REJECT");
    expect(a.recent_competitors).toBe(1);
    expect(a.reasons[0]).toContain("high-confidence competing PR #7");
  });

  it("bare mention (willCloseTarget=false) does NOT hard-REJECT — only CAUTION", () => {
    const a = assess(
      makeSignals({
        competitors: [
          makeCompetitor({ number: 9, highConfidence: false, linkKind: "mention", updatedAt: daysAgo(1) }),
        ],
      }),
      TODAY,
    );
    expect(a.recommendation).toBe("CAUTION");
    expect(a.reasons.some((r) => r.includes("#9"))).toBe(true);
  });

  it("incidental merged reference => CAUTION (not REJECT)", () => {
    const a = assess(
      makeSignals({
        competitors: [
          makeCompetitor({ number: 15, state: "MERGED", merged: true, highConfidence: false }),
        ],
      }),
      TODAY,
    );
    expect(a.recommendation).toBe("CAUTION");
    expect(a.reasons.some((r) => r.includes("#15"))).toBe(true);
  });

  it("stale/draft high-confidence PR (not recent) => CAUTION, still counted open", () => {
    const a = assess(
      makeSignals({
        competitors: [
          makeCompetitor({
            number: 21,
            isDraft: true,
            highConfidence: true,
            linkKind: "connected",
            updatedAt: daysAgo(60),
          }),
        ],
      }),
      TODAY,
    );
    expect(a.recommendation).toBe("CAUTION");
    expect(a.open_competing_prs).toBe(1);
    expect(a.recent_competitors).toBe(0);
  });

  it("assigned recently => CAUTION with assignee reason", () => {
    const a = assess(
      makeSignals({ assignees: ["alice"], lastAssignedAt: daysAgo(10) }),
      TODAY,
    );
    expect(a.recommendation).toBe("CAUTION");
    expect(a.assigned).toBe(true);
    expect(a.reasons).toContain("issue is assigned to @alice");
  });

  it("assigned long ago => CAUTION with 'stale' assignee reason", () => {
    const a = assess(
      makeSignals({ assignees: ["bob"], lastAssignedAt: daysAgo(200) }),
      TODAY,
    );
    expect(a.recommendation).toBe("CAUTION");
    expect(a.reasons.some((r) => r.includes("bob") && r.includes("stale"))).toBe(true);
  });

  it("assigned with unknown assignment date (truncated) => CAUTION stale + incomplete", () => {
    const a = assess(
      makeSignals({ assignees: ["carol"], lastAssignedAt: null, timelineTruncated: true }),
      TODAY,
    );
    expect(a.recommendation).toBe("CAUTION");
    expect(a.reasons.some((r) => r.includes("incomplete data"))).toBe(true);
  });

  it("inactive repository => CAUTION", () => {
    const a = assess(
      makeSignals({ repoPushedAt: daysAgo(200), repoDefaultBranchCommitAt: daysAgo(200) }),
      TODAY,
    );
    expect(a.recommendation).toBe("CAUTION");
    expect(a.repo_active).toBe(false);
    expect(a.reasons.some((r) => r.includes("inactive"))).toBe(true);
  });

  it("old + quiet issue => CAUTION", () => {
    const a = assess(
      makeSignals({ issueCreatedAt: daysAgo(500), issueUpdatedAt: daysAgo(200) }),
      TODAY,
    );
    expect(a.recommendation).toBe("CAUTION");
    expect(a.reasons.some((r) => r.includes("old and inactive"))).toBe(true);
  });

  it("would-be GO but partial data => downgraded to CAUTION", () => {
    const a = assess(makeSignals({ dataQuality: "partial", timelineTruncated: true }), TODAY);
    expect(a.recommendation).toBe("CAUTION");
    expect(a.reasons).toContain("assessment is based on incomplete data");
  });

  it("maintenance-bot LOW-confidence incidental mention stays ignored => GO", () => {
    const a = assess(
      makeSignals({
        competitors: [
          makeCompetitor({
            number: 99,
            authorLogin: "dependabot[bot]",
            authorIsIgnoredBot: true,
            highConfidence: false,
            linkKind: "mention",
          }),
        ],
      }),
      TODAY,
    );
    expect(a.recommendation).toBe("GO");
    expect(a.open_competing_prs).toBe(0);
  });

  it("maintenance-bot HIGH-confidence closing PR is NOT ignored => not GO (G0)", () => {
    for (const login of ["dependabot[bot]", "github-actions[bot]"]) {
      const a = assess(
        makeSignals({
          competitors: [
            makeCompetitor({
              number: 42,
              authorLogin: login,
              authorIsIgnoredBot: true,
              highConfidence: true,
              linkKind: "closing-reference",
              updatedAt: daysAgo(2),
            }),
          ],
        }),
        TODAY,
      );
      expect(a.recommendation).toBe("REJECT");
      expect(a.open_competing_prs).toBe(1);
      expect(a.recent_competitors).toBe(1);
    }
  });

  it("maintenance-bot MERGED high-confidence PR is NOT ignored => REJECT (G0)", () => {
    const a = assess(
      makeSignals({
        competitors: [
          makeCompetitor({
            number: 43,
            authorLogin: "dependabot[bot]",
            authorIsIgnoredBot: true,
            highConfidence: true,
            state: "MERGED",
            merged: true,
            linkKind: "closing-reference",
          }),
        ],
      }),
      TODAY,
    );
    expect(a.recommendation).toBe("REJECT");
    expect(a.reasons[0]).toContain("#43");
  });

  it("UNKNOWN bot's active high-confidence closing PR still drives REJECT (not ignored)", () => {
    const a = assess(
      makeSignals({
        competitors: [
          makeCompetitor({
            number: 123,
            authorLogin: "some-coding-agent[bot]",
            authorIsIgnoredBot: false, // unknown bot: parser does NOT put it on the allowlist
            highConfidence: true,
            linkKind: "closing-reference",
            updatedAt: daysAgo(2),
          }),
        ],
      }),
      TODAY,
    );
    expect(a.recommendation).toBe("REJECT");
    expect(a.open_competing_prs).toBe(1);
    expect(a.recent_competitors).toBe(1);
  });
});

describe("decision engine — determinism & output shape", () => {
  it("is a pure function: identical inputs => deeply equal output", () => {
    const s = makeSignals({ assignees: ["z"], lastAssignedAt: daysAgo(3) });
    expect(assess(s, TODAY)).toEqual(assess(s, TODAY));
  });

  it("only the injected date changes time-windowed fields", () => {
    const s = makeSignals({
      competitors: [makeCompetitor({ number: 5, highConfidence: true, updatedAt: daysAgo(13) })],
    });
    // day 13 after last update: still within 14d
    expect(assess(s, TODAY).recommendation).toBe("REJECT");
    // two days later the same PR update is 15 days old: no longer "recent"
    const later = new Date(TODAY.getTime() + 2 * 86_400_000);
    const a2 = assess(s, later);
    expect(a2.recommendation).toBe("CAUTION");
    expect(a2.recent_competitors).toBe(0);
  });

  it("reasons are non-empty, deduped and severity-sorted", () => {
    const a = assess(
      makeSignals({
        assignees: ["a"],
        lastAssignedAt: daysAgo(5),
        repoPushedAt: daysAgo(300),
        repoDefaultBranchCommitAt: daysAgo(300),
        competitors: [makeCompetitor({ number: 3, state: "MERGED", merged: true, highConfidence: true })],
      }),
      TODAY,
    );
    expect(a.recommendation).toBe("REJECT");
    expect(a.reasons.length).toBeGreaterThan(1);
    expect(new Set(a.reasons).size).toBe(a.reasons.length);
    // first reason comes from a REJECT-severity rule
    expect(a.reasons[0]).toContain("#3");
  });

  it("checked_at is the UTC date of the injected clock", () => {
    const a = assess(makeSignals(), new Date("2026-08-30T23:30:00Z"));
    expect(a.checked_at).toBe("2026-08-30");
  });

  it("risk maps 1:1 to recommendation", () => {
    expect(assess(makeSignals(), TODAY).risk).toBe("low");
    expect(assess(makeSignals({ assignees: ["x"], lastAssignedAt: daysAgo(1) }), TODAY).risk).toBe("medium");
    expect(assess(makeSignals({ issueState: "closed" }), TODAY).risk).toBe("high");
  });
});

describe("decision engine — closed-issue reason trimming keys on rule id, not wording", () => {
  /** Swap a rule's `reason` fn for the duration of `fn`, then restore it. */
  function withRewordedReason(id: string, text: string, fn: () => void) {
    const rule = RULES.find((r) => r.id === id);
    if (!rule) throw new Error(`no rule ${id}`);
    const original = rule.reason;
    rule.reason = () => text;
    try {
      fn();
    } finally {
      rule.reason = original;
    }
  }

  it("keeps the closure reason even if its wording no longer starts with 'issue is closed'", () => {
    withRewordedReason("issue-closed", "this issue was resolved upstream", () => {
      const a = assess(
        makeSignals({
          issueState: "closed",
          stateReason: "completed",
          assignees: ["x"],
          lastAssignedAt: daysAgo(2),
          competitors: [makeCompetitor({ number: 7, state: "OPEN" })],
        }),
        TODAY,
      );
      expect(a.recommendation).toBe("REJECT");
      // Only the closure reason survives the trim; the assignee / open-PR noise is dropped.
      expect(a.reasons).toEqual(["this issue was resolved upstream"]);
    });
  });

  it("keeps the data-quality caveat for a closed issue even if its wording changes", () => {
    withRewordedReason("incomplete-data", "some evidence was unavailable", () => {
      const a = assess(
        makeSignals({
          issueState: "closed",
          stateReason: "completed",
          timelineTruncated: true,
          dataQuality: "partial",
          competitors: [makeCompetitor({ number: 8, state: "OPEN" })],
        }),
        TODAY,
      );
      expect(a.recommendation).toBe("REJECT");
      expect(a.reasons).toContain("some evidence was unavailable");
      expect(a.reasons.some((r) => r.startsWith("issue is closed"))).toBe(true);
      // still exactly the two id-selected reasons, nothing else
      expect(a.reasons).toHaveLength(2);
    });
  });
});
