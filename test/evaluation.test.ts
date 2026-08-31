/**
 * Step D — real-world evaluation.
 *
 * Replays recorded GitHub GraphQL responses (test/fixtures/raw/*.json) through
 * the real parser + decision engine and checks the verdict against a human
 * label recorded from the same data. The hard gate is `false_go === 0`:
 * the engine must never say GO when a human sees a blocker.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { assess } from "../src/decision.ts";
import { parseGraphQL } from "../src/parse.ts";
import { GitHubNotAnIssueError, GitHubNotFoundError } from "../src/types.ts";

interface Case {
  slug: string;
  repo: string;
  issue: number;
  recorded_at: string;
  scenario: string;
  expect: string;
}

const cases: Case[] = JSON.parse(
  readFileSync(new URL("./fixtures/cases.json", import.meta.url), "utf8"),
).cases;

const fixtureName = (repo: string, issue: number) => `${repo.replace("/", "__")}__${issue}.json`;

function outcomeOf(c: Case): string {
  const raw = JSON.parse(
    readFileSync(new URL(`./fixtures/raw/${fixtureName(c.repo, c.issue)}`, import.meta.url), "utf8"),
  );
  const today = new Date(`${c.recorded_at}T12:00:00Z`);
  try {
    return assess(parseGraphQL(raw), today).recommendation;
  } catch (err) {
    if (err instanceof GitHubNotFoundError) return "NOT_FOUND";
    if (err instanceof GitHubNotAnIssueError) return "NOT_AN_ISSUE";
    throw err;
  }
}

const BLOCKERS = new Set(["CAUTION", "REJECT", "NOT_FOUND", "NOT_AN_ISSUE"]);

describe("evaluation — real GitHub fixtures", () => {
  for (const c of cases) {
    it(`${c.slug} (${c.scenario}) => ${c.expect}`, () => {
      expect(outcomeOf(c)).toBe(c.expect);
    });
  }

  it("summary — false_go is 0 and all labels match", () => {
    // Recompute independently so this check stands even if an above test threw.
    let falseGo = 0;
    let falseReject = 0;
    let mismatches = 0;
    const rows: string[] = [];
    for (const c of cases) {
      const actual = outcomeOf(c);
      if (actual !== c.expect) mismatches++;
      if (BLOCKERS.has(c.expect) && actual === "GO") falseGo++;
      if (c.expect === "GO" && actual === "REJECT") falseReject++;
      rows.push(
        `  ${c.slug.padEnd(24)} expect=${c.expect.padEnd(13)} actual=${actual.padEnd(13)} ${actual === c.expect ? "ok" : "MISMATCH"}`,
      );
    }
    const goCount = cases.filter((c) => c.expect === "GO").length;
    console.log(
      [
        "",
        `evaluation: ${cases.length} real cases`,
        ...rows,
        "",
        `  true-GO cases:   ${goCount}`,
        `  false GO:        ${falseGo}   (blocker present but engine said GO)`,
        `  false REJECT:    ${falseReject}   (clean issue but engine said REJECT)`,
        `  label mismatches:${mismatches}`,
        "",
      ].join("\n"),
    );
    expect(falseGo).toBe(0);
    expect(mismatches).toBe(0);
  });
});
