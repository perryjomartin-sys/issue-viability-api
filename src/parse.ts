import { isIgnoredMaintenanceBot } from "./bots.ts";
import {
  GitHubNotAnIssueError,
  GitHubNotFoundError,
  type CompetitorPr,
  type DataQuality,
  type PrState,
  type Signals,
} from "./types.ts";

/* --------------------------------- GraphQL --------------------------------- */

interface GqlResponse {
  data?: any;
  errors?: Array<{ type?: string; message?: string; path?: unknown }>;
}

interface WorkingPr {
  number: number;
  state: PrState;
  isDraft: boolean;
  merged: boolean;
  createdAt: string;
  updatedAt: string;
  authorLogin: string | null;
  authorIsIgnoredBot: boolean;
  hadConnected: boolean;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  hadClosingRef: boolean;
}

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function prStateFrom(raw: any): PrState {
  if (raw?.merged === true) return "MERGED";
  const s = String(raw?.state ?? "").toUpperCase();
  return s === "OPEN" || s === "CLOSED" || s === "MERGED" ? (s as PrState) : "OPEN";
}

function applyPrBits(entry: WorkingPr, pr: any): void {
  entry.state = prStateFrom(pr);
  entry.isDraft = pr?.isDraft === true;
  entry.merged = pr?.merged === true;
  if (typeof pr?.createdAt === "string") entry.createdAt = pr.createdAt;
  if (typeof pr?.updatedAt === "string") entry.updatedAt = pr.updatedAt;
  const login: string | null = pr?.author?.login ?? null;
  entry.authorLogin = login;
  entry.authorIsIgnoredBot = isIgnoredMaintenanceBot(login);
}

function ensurePr(map: Map<number, WorkingPr>, pr: any): WorkingPr | null {
  const number = pr?.number;
  if (typeof number !== "number") return null;
  let entry = map.get(number);
  if (!entry) {
    entry = {
      number,
      state: "OPEN",
      isDraft: false,
      merged: false,
      createdAt: pr?.createdAt ?? "",
      updatedAt: pr?.updatedAt ?? "",
      authorLogin: null,
      authorIsIgnoredBot: false,
      hadConnected: false,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      hadClosingRef: false,
    };
    map.set(number, entry);
  }
  applyPrBits(entry, pr);
  return entry;
}

function pickPr(node: any): any | null {
  for (const key of ["source", "subject"]) {
    const v = node?.[key];
    if (v && v.__typename === "PullRequest") return v;
  }
  return null;
}

function finaliseCompetitors(map: Map<number, WorkingPr>): CompetitorPr[] {
  const out: CompetitorPr[] = [];
  for (const e of map.values()) {
    const connectedActive =
      e.hadConnected &&
      (!e.lastDisconnectedAt ||
        (e.lastConnectedAt !== null &&
          new Date(e.lastConnectedAt).getTime() >= new Date(e.lastDisconnectedAt).getTime()));
    const highConfidence = e.hadClosingRef || connectedActive;
    const linkKind: CompetitorPr["linkKind"] = e.hadClosingRef
      ? "closing-reference"
      : connectedActive
        ? "connected"
        : "mention";
    out.push({
      number: e.number,
      state: e.state,
      isDraft: e.isDraft,
      merged: e.merged,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      authorLogin: e.authorLogin,
      authorIsIgnoredBot: e.authorIsIgnoredBot,
      highConfidence,
      linkKind,
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

function computeLastAssignedAt(events: any[], currentAssignees: Set<string>): string | null {
  if (currentAssignees.size === 0) return null;
  const chronological = events
    .filter((n) => n.__typename === "AssignedEvent" || n.__typename === "UnassignedEvent")
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const assignedAt = new Map<string, string>();
  for (const ev of chronological) {
    const login: string | undefined = ev.assignee?.login;
    if (!login) continue;
    if (ev.__typename === "AssignedEvent") assignedAt.set(login, ev.createdAt);
    else assignedAt.delete(login);
  }
  let latest: string | null = null;
  for (const [login, at] of assignedAt) {
    if (currentAssignees.has(login)) latest = laterIso(latest, at);
  }
  return latest;
}

/**
 * Parse a raw GitHub GraphQL response (the `{ data, errors }` envelope, or a
 * bare `data` object) into normalised Signals.
 *
 * @throws GitHubNotFoundError    repo or issue does not exist / not visible
 * @throws GitHubNotAnIssueError  the number is a pull request
 */
export function parseGraphQL(raw: GqlResponse | { repository?: unknown }): Signals {
  const data: any = "data" in raw && raw.data ? raw.data : raw;
  const errors = "errors" in raw ? raw.errors : undefined;

  const repo = data?.repository ?? null;
  if (!repo) {
    const notFound = errors?.some((e) => e.type === "NOT_FOUND");
    if (notFound || errors == null || errors.length === 0) throw new GitHubNotFoundError();
    throw new GitHubNotFoundError(errors.map((e) => e.message).filter(Boolean).join("; "));
  }

  const iop = repo.issueOrPullRequest ?? null;
  if (!iop) throw new GitHubNotFoundError("issue not found in repository");
  if (iop.__typename === "PullRequest") throw new GitHubNotAnIssueError();
  if (iop.__typename !== "Issue") throw new GitHubNotFoundError("unexpected node type");

  const timeline = iop.timelineItems?.nodes ?? [];
  const prMap = new Map<number, WorkingPr>();

  for (const node of timeline) {
    switch (node?.__typename) {
      case "CrossReferencedEvent": {
        const pr = node.source?.__typename === "PullRequest" ? node.source : null;
        if (!pr) break;
        const entry = ensurePr(prMap, pr);
        if (!entry) break;
        if (node.willCloseTarget === true) entry.hadClosingRef = true;
        break;
      }
      case "ConnectedEvent": {
        const pr = pickPr(node);
        if (!pr) break;
        const entry = ensurePr(prMap, pr);
        if (!entry) break;
        entry.hadConnected = true;
        entry.lastConnectedAt = laterIso(entry.lastConnectedAt, node.createdAt ?? null);
        break;
      }
      case "DisconnectedEvent": {
        const num =
          (node.source?.__typename === "PullRequest" && node.source.number) ||
          (node.subject?.__typename === "PullRequest" && node.subject.number) ||
          null;
        if (typeof num !== "number") break;
        const entry = prMap.get(num);
        if (entry) entry.lastDisconnectedAt = laterIso(entry.lastDisconnectedAt, node.createdAt ?? null);
        break;
      }
      default:
        break; // assign/unassign handled separately
    }
  }

  const currentAssignees: string[] = (iop.assignees?.nodes ?? [])
    .map((n: any) => n?.login)
    .filter((x: unknown): x is string => typeof x === "string");

  const lastAssignedAt = computeLastAssignedAt(timeline, new Set(currentAssignees));
  const timelineTruncated = iop.timelineItems?.pageInfo?.hasPreviousPage === true;

  // A GraphQL response can carry a usable `data.repository` AND an `errors`
  // array: GitHub nulled some field(s). We must not treat the resulting
  // empty/default values as clean evidence. Any such error, or a required
  // collection that came back null (not merely empty), degrades the result to
  // "partial" — which forces a would-be GO down to CAUTION in the engine.
  const hasGraphErrors = Array.isArray(errors) && errors.length > 0;
  const timelineFieldMissing = iop.timelineItems == null || iop.timelineItems.nodes == null;
  const assigneesFieldMissing = iop.assignees == null || iop.assignees.nodes == null;
  const dataQuality: DataQuality =
    timelineTruncated || hasGraphErrors || timelineFieldMissing || assigneesFieldMissing
      ? "partial"
      : "ok";

  return {
    found: true,
    kind: "issue",
    issueState: String(iop.state).toUpperCase() === "CLOSED" ? "closed" : "open",
    stateReason: iop.stateReason ? String(iop.stateReason).toLowerCase() : null,
    issueCreatedAt: iop.createdAt,
    issueUpdatedAt: iop.updatedAt,
    assignees: currentAssignees,
    lastAssignedAt,
    competitors: finaliseCompetitors(prMap),
    repoArchived: repo.isArchived === true,
    repoDisabled: repo.isDisabled === true,
    repoPushedAt: repo.pushedAt,
    repoDefaultBranchCommitAt: repo.defaultBranchRef?.target?.committedDate ?? null,
    timelineTruncated,
    dataQuality,
    source: "graphql",
    rateLimit: data.rateLimit
      ? {
          cost: Number(data.rateLimit.cost ?? 0),
          remaining: Number(data.rateLimit.remaining ?? 0),
          resetAt: String(data.rateLimit.resetAt ?? ""),
        }
      : null,
  };
}

/* ----------------------------------- REST ---------------------------------- */

export interface RestInputs {
  repo: any;
  issue: any;
  timeline: any[];
  /** Link header indicated more timeline pages. */
  timelineTruncated: boolean;
  /** Optional: GET /commits?per_page=1 result for the default branch. */
  commits?: any[];
}

/**
 * REST fallback parser. REST timeline `connected` events do NOT identify the PR
 * and REST has no `willCloseTarget`, so every competitor found here is LOW
 * confidence: the decision engine will never hard-REJECT on a REST competitor,
 * only CAUTION.
 */
export function parseRest(inp: RestInputs): Signals {
  const { repo, issue, timeline } = inp;
  if (!repo || !issue) throw new GitHubNotFoundError();
  if (issue.pull_request) throw new GitHubNotAnIssueError();

  const prMap = new Map<number, WorkingPr>();
  const assignEvents: any[] = [];

  for (const ev of timeline) {
    if (ev?.event === "cross-referenced") {
      const src = ev.source?.issue;
      if (!src || !src.pull_request) continue;
      const number = src.number;
      if (typeof number !== "number") continue;
      const merged = Boolean(src.pull_request.merged_at);
      const state: PrState = merged
        ? "MERGED"
        : String(src.state).toUpperCase() === "CLOSED"
          ? "CLOSED"
          : "OPEN";
      const login: string | null = src.user?.login ?? null;
      prMap.set(number, {
        number,
        state,
        isDraft: src.draft === true,
        merged,
        createdAt: src.created_at ?? "",
        updatedAt: src.updated_at ?? src.created_at ?? "",
        authorLogin: login,
        authorIsIgnoredBot: isIgnoredMaintenanceBot(login),
        hadConnected: false,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        hadClosingRef: false, // REST cannot tell us this
      });
    } else if (ev?.event === "assigned" || ev?.event === "unassigned") {
      assignEvents.push({
        __typename: ev.event === "assigned" ? "AssignedEvent" : "UnassignedEvent",
        createdAt: ev.created_at,
        assignee: { login: ev.assignee?.login },
      });
    }
  }

  const currentAssignees: string[] = (issue.assignees ?? [])
    .map((a: any) => a?.login)
    .filter((x: unknown): x is string => typeof x === "string");

  // REST is structurally degraded for this product: it has no `willCloseTarget`
  // and its `connected` events do not identify the PR, so it can never supply
  // high-confidence competitor evidence. Every REST-derived result is therefore
  // "partial" regardless of pagination — an otherwise-clean REST result assesses
  // to CAUTION, never GO. `timelineTruncated` is still reported independently.
  const dataQuality: DataQuality = "partial";
  const commitDate: string | null = inp.commits?.[0]?.commit?.committer?.date ?? null;

  return {
    found: true,
    kind: "issue",
    issueState: String(issue.state).toUpperCase() === "CLOSED" ? "closed" : "open",
    stateReason: issue.state_reason ? String(issue.state_reason).toLowerCase() : null,
    issueCreatedAt: issue.created_at,
    issueUpdatedAt: issue.updated_at,
    assignees: currentAssignees,
    lastAssignedAt: computeLastAssignedAt(assignEvents, new Set(currentAssignees)),
    competitors: finaliseCompetitors(prMap),
    repoArchived: repo.archived === true,
    repoDisabled: repo.disabled === true,
    repoPushedAt: repo.pushed_at,
    repoDefaultBranchCommitAt: commitDate,
    timelineTruncated: inp.timelineTruncated,
    dataQuality,
    source: "rest",
    rateLimit: null,
  };
}
