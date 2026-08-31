import { CONFIG } from "./config.ts";

/**
 * One GraphQL query returns every signal we need:
 *  - repo activity + archived/disabled
 *  - issue vs pull-request disambiguation (issueOrPullRequest union)
 *  - issue state + state reason + timestamps
 *  - current assignees
 *  - timeline: cross references (with willCloseTarget), connect/disconnect,
 *    assign/unassign
 *
 * `last: N` fetches the most recent N timeline items; `hasPreviousPage` tells us
 * whether older items were dropped (=> data may be incomplete).
 */
export const ISSUE_VIABILITY_QUERY = `
query IssueViability($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    isArchived
    isDisabled
    pushedAt
    updatedAt
    defaultBranchRef { target { ... on Commit { committedDate } } }
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest { number }
      ... on Issue {
        number
        state
        stateReason
        createdAt
        updatedAt
        assignees(first: 10) { totalCount nodes { login } }
        timelineItems(
          last: ${CONFIG.TIMELINE_PAGE_SIZE}
          itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT, DISCONNECTED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT]
        ) {
          totalCount
          pageInfo { hasPreviousPage }
          nodes {
            __typename
            ... on CrossReferencedEvent {
              createdAt
              willCloseTarget
              source {
                __typename
                ... on PullRequest { ...PrBits }
              }
            }
            ... on ConnectedEvent {
              createdAt
              subject { __typename ... on PullRequest { ...PrBits } }
              source  { __typename ... on PullRequest { ...PrBits } }
            }
            ... on DisconnectedEvent {
              createdAt
              subject { __typename ... on PullRequest { number } }
              source  { __typename ... on PullRequest { number } }
            }
            ... on AssignedEvent {
              createdAt
              assignee { __typename ... on User { login } ... on Bot { login } }
            }
            ... on UnassignedEvent {
              createdAt
              assignee { __typename ... on User { login } ... on Bot { login } }
            }
          }
        }
      }
    }
  }
}

fragment PrBits on PullRequest {
  number
  state
  isDraft
  merged
  createdAt
  updatedAt
  author { __typename login }
}
`;

export interface QueryVariables {
  owner: string;
  name: string;
  number: number;
}
