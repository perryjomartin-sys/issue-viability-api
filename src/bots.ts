/**
 * Allowlist of automation that files *maintenance* pull requests — dependency
 * bumps, formatting, changelog/coverage housekeeping. These never represent a
 * competing implementation of a feature/bug issue, so they are excluded from
 * competitor logic.
 *
 * An UNKNOWN bot actor is deliberately NOT excluded. An autonomous coding agent
 * may open a genuine competing PR (including an active high-confidence closing
 * PR); treating "it's a bot" as "ignore it" would let such a PR slip past the
 * decision engine and produce a wrong GO. Extend this list deliberately.
 */
const IGNORED_MAINTENANCE_BOTS = new Set<string>([
  "dependabot",
  "dependabot-preview",
  "renovate",
  "renovate-bot",
  "github-actions",
  "mergify",
  "mergify-bot",
  "greenkeeper",
  "codecov",
  "codecov-commenter",
  "imgbot",
  "allcontributors",
  "snyk-bot",
  "pyup-bot",
  "depfu",
  "restyled-io",
  "sourcery-ai",
  "pre-commit-ci",
  "github-merge-queue",
]);

/**
 * True only for automation on the maintenance allowlist above.
 *
 * The GraphQL `__typename === "Bot"` and the `"[bot]"` login suffix are NOT
 * sufficient on their own — they identify "some bot", not "a bot that never
 * competes". The `"[bot]"` suffix is stripped only to match the bare login
 * against the allowlist.
 *
 * @param login author login (may be null for a deleted/ghost account)
 */
export function isIgnoredMaintenanceBot(login: string | null | undefined): boolean {
  if (!login) return false;
  let l = login.toLowerCase();
  if (l.endsWith("[bot]")) l = l.slice(0, -"[bot]".length);
  return IGNORED_MAINTENANCE_BOTS.has(l);
}
