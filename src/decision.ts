import { CONFIG } from "./config.ts";
import { ageInDays, maxIso, withinDays, ymd } from "./dates.ts";
import type { Assessment, CompetitorPr, Recommendation, Risk, Signals } from "./types.ts";

const RISK_BY_REC: Record<Recommendation, Risk> = {
  REJECT: "high",
  CAUTION: "medium",
  GO: "low",
};

const SEVERITY_RANK: Record<Recommendation, number> = { REJECT: 0, CAUTION: 1, GO: 2 };

interface DerivedCtx {
  s: Signals;
  today: Date;
  /** competitors excluding bot authors */
  comp: CompetitorPr[];
  openComp: CompetitorPr[];
  highConfMerged: CompetitorPr[];
  incidentalMerged: CompetitorPr[];
  highConfOpenRecent: CompetitorPr[];
  recentCompetitors: CompetitorPr[];
  repoActive: boolean;
  assigned: boolean;
  primaryAssignee: string | null;
  assignmentStale: boolean;
  issueOldAndQuiet: boolean;
  incompleteData: boolean;
  lastActivity: string;
}

function mostRecent(prs: CompetitorPr[]): CompetitorPr | null {
  let best: CompetitorPr | null = null;
  for (const p of prs) {
    if (!best || new Date(p.updatedAt).getTime() > new Date(best.updatedAt).getTime()) best = p;
  }
  return best;
}

function derive(s: Signals, today: Date): DerivedCtx {
  const comp = s.competitors.filter((c) => !c.authorIsIgnoredBot);
  const openComp = comp.filter((c) => c.state === "OPEN");
  const highConf = comp.filter((c) => c.highConfidence);

  const highConfMerged = highConf.filter((c) => c.merged);
  const incidentalMerged = comp.filter((c) => c.merged && !c.highConfidence);
  const highConfOpenRecent = highConf.filter(
    (c) => c.state === "OPEN" && !c.isDraft && withinDays(c.updatedAt, CONFIG.COMPET_DAYS, today),
  );
  const recentCompetitors = openComp.filter(
    (c) => !c.isDraft && withinDays(c.updatedAt, CONFIG.COMPET_DAYS, today),
  );

  const repoActive =
    withinDays(s.repoPushedAt, CONFIG.REPO_DAYS, today) ||
    withinDays(s.repoDefaultBranchCommitAt, CONFIG.REPO_DAYS, today);

  const assigned = s.assignees.length > 0;
  const assignmentStale =
    assigned && !withinDays(s.lastAssignedAt, CONFIG.ASSIGN_STALE_DAYS, today);

  const issueAge = ageInDays(s.issueCreatedAt, today) ?? 0;
  const issueOldAndQuiet =
    issueAge > CONFIG.ISSUE_STALE_DAYS && !withinDays(s.issueUpdatedAt, CONFIG.REPO_DAYS, today);

  const incompleteData = s.dataQuality !== "ok" || s.timelineTruncated;

  const lastActivity =
    maxIso(s.issueUpdatedAt, ...comp.map((c) => c.updatedAt)) ?? s.issueUpdatedAt;

  return {
    s,
    today,
    comp,
    openComp,
    highConfMerged,
    incidentalMerged,
    highConfOpenRecent,
    recentCompetitors,
    repoActive,
    assigned,
    primaryAssignee: s.assignees[0] ?? null,
    assignmentStale,
    issueOldAndQuiet,
    incompleteData,
    lastActivity,
  };
}

interface Rule {
  id: string;
  rec: Exclude<Recommendation, "GO">;
  when: (c: DerivedCtx) => boolean;
  reason: (c: DerivedCtx) => string;
}

/**
 * Rules are evaluated in order. EVERY rule whose `when` is true contributes its
 * `reason`. The recommendation is the `rec` of the FIRST matching rule
 * (REJECT rules are listed before CAUTION rules). If nothing matches => GO.
 *
 * Exported so `assess` (and tests) can refer to rules by stable `id` rather
 * than by matching their human-readable `reason` text.
 */
export const RULES: Rule[] = [
  {
    id: "issue-closed",
    rec: "REJECT",
    when: (c) => c.s.issueState === "closed",
    reason: (c) => `issue is closed (reason: ${c.s.stateReason ?? "unspecified"})`,
  },
  {
    id: "merged-implementation",
    rec: "REJECT",
    when: (c) => c.highConfMerged.length > 0,
    reason: (c) =>
      `merged PR #${mostRecent(c.highConfMerged)!.number} already implements this issue (closing reference)`,
  },
  {
    id: "repo-archived",
    rec: "REJECT",
    when: (c) => c.s.repoArchived || c.s.repoDisabled,
    reason: (c) => (c.s.repoArchived ? "repository is archived" : "repository is disabled"),
  },
  {
    id: "active-competitor",
    rec: "REJECT",
    when: (c) => c.highConfOpenRecent.length > 0,
    reason: (c) =>
      `high-confidence competing PR #${mostRecent(c.highConfOpenRecent)!.number} active within ${CONFIG.COMPET_DAYS} days`,
  },
  {
    id: "incidental-merged",
    rec: "CAUTION",
    when: (c) => c.incidentalMerged.length > 0,
    reason: (c) =>
      `merged PR #${mostRecent(c.incidentalMerged)!.number} references this issue and may already resolve it`,
  },
  {
    id: "open-competitor",
    rec: "CAUTION",
    when: (c) => c.openComp.length > 0,
    reason: (c) => {
      const n = c.openComp.length;
      const pr = mostRecent(c.openComp)!;
      return n === 1
        ? `open PR #${pr.number} references this issue`
        : `${n} open PRs reference this issue (most recent #${pr.number})`;
    },
  },
  {
    id: "assigned-active",
    rec: "CAUTION",
    when: (c) => c.assigned && !c.assignmentStale,
    reason: (c) => `issue is assigned to @${c.primaryAssignee}`,
  },
  {
    id: "assigned-stale",
    rec: "CAUTION",
    when: (c) => c.assigned && c.assignmentStale,
    reason: (c) =>
      `issue is assigned to @${c.primaryAssignee} but the assignment looks stale`,
  },
  {
    id: "repo-inactive",
    rec: "CAUTION",
    when: (c) => !c.repoActive,
    reason: () => `repository has been inactive for more than ${CONFIG.REPO_DAYS} days`,
  },
  {
    id: "issue-stale",
    rec: "CAUTION",
    when: (c) => c.issueOldAndQuiet,
    reason: () => "issue is old and inactive; its requirements may be stale",
  },
  {
    id: "incomplete-data",
    rec: "CAUTION",
    when: (c) => c.incompleteData,
    reason: () => "assessment is based on incomplete data",
  },
];

/** The rule that flags incomplete data; referenced by id in the trim + safety net. */
const INCOMPLETE_DATA_RULE = RULES.find((r) => r.id === "incomplete-data")!;

const GO_REASON = "issue is open, unassigned, has no competing PRs, and the repository is active";

/**
 * Deterministic assessment. Output is a pure function of `(signals, today)`.
 * `today` is injected (never read from the clock here) so tests and cache keys
 * stay stable.
 */
export function assess(signals: Signals, today: Date): Assessment {
  const c = derive(signals, today);

  const matched = RULES.filter((r) => r.when(c));
  let recommendation: Recommendation = matched.length > 0 ? matched[0]!.rec : "GO";

  // Each reason carries the id of the rule that produced it, so downstream
  // trimming keys on rule identity, never on the wording of the reason text.
  let reasonEntries: Array<{ id: string; rec: Recommendation; text: string }> = matched.map((r) => ({
    id: r.id,
    rec: r.rec,
    text: r.reason(c),
  }));
  if (reasonEntries.length === 0) {
    reasonEntries.push({ id: "clean", rec: "GO" as const, text: GO_REASON });
  }

  // A closed issue is a hard REJECT on its own; competing-PR / staleness reasons
  // just add noise. Keep only the closure reason and any data-quality caveat,
  // matched by rule id so reason wording can change freely.
  if (c.s.issueState === "closed") {
    reasonEntries = reasonEntries.filter(
      (e) => e.id === "issue-closed" || e.id === INCOMPLETE_DATA_RULE.id,
    );
  }

  // Safety net: never emit GO on incomplete/stale data.
  if (recommendation === "GO" && c.incompleteData) {
    recommendation = "CAUTION";
    if (!reasonEntries.some((e) => e.id === INCOMPLETE_DATA_RULE.id)) {
      reasonEntries.push({
        id: INCOMPLETE_DATA_RULE.id,
        rec: INCOMPLETE_DATA_RULE.rec,
        text: INCOMPLETE_DATA_RULE.reason(c),
      });
    }
  }

  const reasons = reasonEntries
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.rec] - SEVERITY_RANK[b.rec] || a.text.localeCompare(b.text))
    .map((e) => e.text)
    .filter((t, i, arr) => arr.indexOf(t) === i);

  return {
    issue_state: signals.issueState,
    assigned: c.assigned,
    open_competing_prs: c.openComp.length,
    recent_competitors: c.recentCompetitors.length,
    repo_active: c.repoActive,
    last_activity: c.lastActivity,
    risk: RISK_BY_REC[recommendation],
    recommendation,
    reasons,
    data_quality: signals.dataQuality,
    checked_at: ymd(today),
  };
}
