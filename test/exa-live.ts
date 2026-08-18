import { searchExa } from "../src/tools/web-search";

const apiKey = process.env.EXA_API_KEY?.trim();
if (!apiKey) throw new Error("EXA_API_KEY is required for the live Exa smoke test");

const result = await searchExa(
  {
    apiKey,
    baseUrl: process.env.EXA_BASE_URL?.trim() || "https://api.exa.ai",
  },
  {
    query: "Bun JavaScript runtime official documentation",
    numResults: 1,
    includeDomains: ["bun.sh/docs"],
  },
);

const first = result.results[0];
if (!first) throw new Error("Exa live smoke test returned no results");
console.log(`Exa live search passed: ${first.title} (${first.url})`);
