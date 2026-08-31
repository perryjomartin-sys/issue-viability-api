/**
 * Record real GitHub GraphQL responses as offline fixtures for the evaluation
 * suite (step D). Uses the authenticated `gh` CLI so no raw token is handled
 * here.
 *
 *   node --experimental-strip-types scripts/record-fixtures.mjs [slug ...]
 *
 * Reads test/fixtures/cases.json, writes test/fixtures/raw/<slug>.json, and
 * stamps `recorded_at` (UTC date) back into cases.json so the evaluation
 * evaluates age windows against the day the data was captured.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ISSUE_VIABILITY_QUERY } from "../src/query.ts";

const here = dirname(fileURLToPath(import.meta.url));
const casesPath = join(here, "../test/fixtures/cases.json");
const rawDir = join(here, "../test/fixtures/raw");

const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const only = process.argv.slice(2);
const today = new Date().toISOString().slice(0, 10);

/** Canonical fixture filename, shared with the app's fixture loader. */
const fixtureName = (repo, issue) => `${repo.replace("/", "__")}__${issue}.json`;

let ok = 0;
let failed = 0;

for (const c of cases.cases) {
  if (only.length && !only.includes(c.slug)) continue;
  const [owner, name] = c.repo.split("/");
  try {
    const out = execFileSync(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${ISSUE_VIABILITY_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${c.issue}`,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    JSON.parse(out); // sanity
    writeFileSync(join(rawDir, fixtureName(c.repo, c.issue)), out.trim() + "\n");
    c.recorded_at = today;
    console.log(`ok   ${c.slug.padEnd(28)} ${c.repo}#${c.issue}`);
    ok++;
  } catch (err) {
    // gh exits non-zero on GraphQL errors (e.g. NOT_FOUND); capture the body so
    // "repository not found" style cases can still be fixtures.
    const body = err.stdout?.toString?.() ?? "";
    if (body.trim().startsWith("{")) {
      writeFileSync(join(rawDir, fixtureName(c.repo, c.issue)), body.trim() + "\n");
      c.recorded_at = today;
      console.log(`ok*  ${c.slug.padEnd(28)} ${c.repo}#${c.issue}  (GraphQL errors captured)`);
      ok++;
    } else {
      console.error(`FAIL ${c.slug.padEnd(28)} ${c.repo}#${c.issue}: ${err.message.split("\n")[0]}`);
      failed++;
    }
  }
}

writeFileSync(casesPath, JSON.stringify(cases, null, 2) + "\n");
console.log(`\nrecorded ${ok}, failed ${failed}`);
process.exit(failed ? 1 : 0);
