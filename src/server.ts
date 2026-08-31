import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 8787);

const app = createApp({
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  IVA_DEV_FIXTURES: process.env.IVA_DEV_FIXTURES,
  IVA_NOW: process.env.IVA_NOW,
  X402_ENABLED: process.env.X402_ENABLED,
  X402_PAY_TO: process.env.X402_PAY_TO,
  X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL,
  X402_PRICE: process.env.X402_PRICE,
  X402_RESOURCE_URL: process.env.X402_RESOURCE_URL,
  X402_BAZAAR: process.env.X402_BAZAAR,
});

serve({ fetch: app.fetch, port }, (info) => {
  const mode = process.env.IVA_DEV_FIXTURES
    ? `fixtures:${process.env.IVA_DEV_FIXTURES}`
    : process.env.GITHUB_TOKEN
      ? "github"
      : "unconfigured (set GITHUB_TOKEN or IVA_DEV_FIXTURES)";
  console.log(`issue-viability-api listening on http://localhost:${info.port}  [upstream: ${mode}]`);
});
