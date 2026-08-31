/**
 * Static bot-author allowlist. Bot-authored PRs (Dependabot, Renovate, etc.)
 * must not inflate competitor counts. Versioned in code so the decision stays
 * deterministic; extend deliberately.
 */
const BOT_LOGINS = new Set<string>([
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
 * @param login   author login (may be null for a deleted/ghost account)
 * @param typename GraphQL __typename of the author node, if known ("Bot" | "User" | "Organisation")
 */
export function isBotAuthor(login: string | null | undefined, typename?: string | null): boolean {
  if (typename === "Bot") return true;
  if (!login) return false;
  const l = login.toLowerCase();
  if (l.endsWith("[bot]")) return true;
  return BOT_LOGINS.has(l);
}
