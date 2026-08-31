import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 8787);

const app = createApp({
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  IVA_DEV_FIXTURES: process.env.IVA_DEV_FIXTURES,
  IVA_NOW: process.env.IVA_NOW,
});

serve({ fetch: app.fetch, port }, (info) => {
  const mode = process.env.IVA_DEV_FIXTURES
    ? `fixtures:${process.env.IVA_DEV_FIXTURES}`
    : process.env.GITHUB_TOKEN
      ? "github"
      : "unconfigured (set GITHUB_TOKEN or IVA_DEV_FIXTURES)";
  console.log(`issue-viability-api listening on http://localhost:${info.port}  [upstream: ${mode}]`);
});
