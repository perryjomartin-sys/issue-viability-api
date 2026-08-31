/** Shared types for the Issue Viability API. */

export type Recommendation = "GO" | "CAUTION" | "REJECT";
export type Risk = "low" | "medium" | "high";
export type IssueState = "open" | "closed";
export type DataQuality = "ok" | "partial" | "stale";
export type PrState = "OPEN" | "CLOSED" | "MERGED";

/**
 * A pull request that references the target issue.
 * `highConfidence` = GitHub officially links it (ConnectedEvent) OR a cross
 * reference whose `willCloseTarget` is true (a "Fixes #N" style closing ref).
 * A bare mention with willCloseTarget=false is low confidence.
 */
export interface CompetitorPr {
  number: number;
  state: PrState;
  isDraft: boolean;
  merged: boolean;
  createdAt: string;
  updatedAt: string;
  authorLogin: string | null;
  authorIsBot: boolean;
  highConfidence: boolean;
  /** How this PR became linked, for debugging / reasons text. */
  linkKind: "connected" | "closing-reference" | "mention";
}

/** Normalised signals extracted from GitHub, transport-independent. */
export interface Signals {
  found: boolean;
  kind: "issue" | "pull_request" | "not_found";

  issueState: IssueState;
  /** "completed" | "not_planned" | "reopened" | null (lower-cased). */
  stateReason: string | null;
  issueCreatedAt: string;
  issueUpdatedAt: string;

  assignees: string[];
  /** Most recent AssignedEvent date for a current assignee, or null if unknown. */
  lastAssignedAt: string | null;

  competitors: CompetitorPr[];

  repoArchived: boolean;
  repoDisabled: boolean;
  repoPushedAt: string;
  repoDefaultBranchCommitAt: string | null;

  /** Older timeline items than we fetched exist (data may be incomplete). */
  timelineTruncated: boolean;
  dataQuality: DataQuality;
  source: "graphql" | "rest";

  rateLimit: { cost: number; remaining: number; resetAt: string } | null;
}

/** The public assessment response body. */
export interface Assessment {
  issue_state: IssueState;
  assigned: boolean;
  open_competing_prs: number;
  recent_competitors: number;
  repo_active: boolean;
  last_activity: string;
  risk: Risk;
  recommendation: Recommendation;
  reasons: string[];
  data_quality: DataQuality;
  /** UTC date (YYYY-MM-DD) the age windows were evaluated against. */
  checked_at: string;
}

export class GitHubNotFoundError extends Error {
  constructor(message = "repository or issue not found") {
    super(message);
    this.name = "GitHubNotFoundError";
  }
}

export class GitHubNotAnIssueError extends Error {
  constructor(message = "the given number is a pull request, not an issue") {
    super(message);
    this.name = "GitHubNotAnIssueError";
  }
}

export class GitHubRateLimitedError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = "GitHub rate limit exhausted") {
    super(message);
    this.name = "GitHubRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GitHubUpstreamError extends Error {
  constructor(message = "GitHub upstream unavailable") {
    super(message);
    this.name = "GitHubUpstreamError";
  }
}
