/** Dev helper: parse + assess every recorded fixture and print a summary. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGraphQL } from "../src/parse.ts";
import { assess } from "../src/decision.ts";
import { GitHubNotAnIssueError, GitHubNotFoundError } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const rawDir = join(here, "../test/fixtures/raw");
const cases = JSON.parse(readFileSync(join(here, "../test/fixtures/cases.json"), "utf8")).cases;

const fixtureName = (repo, issue) => `${repo.replace("/", "__")}__${issue}.json`;

for (const c of cases) {
  const raw = JSON.parse(readFileSync(join(rawDir, fixtureName(c.repo, c.issue)), "utf8"));
  const today = new Date(`${c.recorded_at}T12:00:00Z`);
  let line;
  try {
    const s = parseGraphQL(raw);
    const a = assess(s, today);
    const comp = s.competitors
      .map((x) => `#${x.number}:${x.state}${x.highConfidence ? "!" : ""}${x.authorIsBot ? "(bot)" : ""}`)
      .join(",");
    line = `${a.recommendation.padEnd(8)} risk=${a.risk.padEnd(6)} state=${s.issueState} asg=${s.assignees.length} openPR=${a.open_competing_prs} recentPR=${a.recent_competitors} repoActive=${a.repo_active} dq=${a.data_quality} trunc=${s.timelineTruncated} | comp[${comp}] | ${a.reasons.join(" || ")}`;
  } catch (e) {
    if (e instanceof GitHubNotFoundError) line = "NOT_FOUND";
    else if (e instanceof GitHubNotAnIssueError) line = "NOT_AN_ISSUE";
    else line = `THREW ${e.constructor.name}: ${e.message}`;
  }
  console.log(`${c.slug.padEnd(26)} expect=${String(c.expect).padEnd(13)} => ${line}`);
}
