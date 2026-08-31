import type { CompetitorPr, Signals } from "../src/types.ts";

export const TODAY = new Date("2026-08-30T12:00:00Z");

/** ISO string for `days` days before TODAY (or a given anchor). */
export function daysAgo(days: number, anchor: Date = TODAY): string {
  return new Date(anchor.getTime() - days * 86_400_000).toISOString();
}

export function makeSignals(partial: Partial<Signals> = {}): Signals {
  return {
    found: true,
    kind: "issue",
    issueState: "open",
    stateReason: null,
    issueCreatedAt: daysAgo(120),
    issueUpdatedAt: daysAgo(5),
    assignees: [],
    lastAssignedAt: null,
    competitors: [],
    repoArchived: false,
    repoDisabled: false,
    repoPushedAt: daysAgo(3),
    repoDefaultBranchCommitAt: daysAgo(3),
    timelineTruncated: false,
    dataQuality: "ok",
    source: "graphql",
    rateLimit: { cost: 1, remaining: 4999, resetAt: daysAgo(-1) },
    ...partial,
  };
}

export function makeCompetitor(partial: Partial<CompetitorPr> = {}): CompetitorPr {
  return {
    number: 100,
    state: "OPEN",
    isDraft: false,
    merged: false,
    createdAt: daysAgo(10),
    updatedAt: daysAgo(2),
    authorLogin: "someone",
    authorIsIgnoredBot: false,
    highConfidence: false,
    linkKind: "mention",
    ...partial,
  };
}
