import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createDocsRedirectRouteRules, docsLegacyFragmentRedirects } from "../modules/vitehub-docs/redirects";

const comparison = "/docs/compare/nuxthub";
const guide = readFileSync(new URL("../content/docs/compare/nuxthub.md", import.meta.url), "utf8");

it("keeps the NuxtHub migration entry points and renamed bookmarks", () => {
  const rules = createDocsRedirectRouteRules();
  for (const section of ["frameworks-hosts", "getting-started"]) {
    const legacy = `/docs/${section}/migrate-from-nuxthub`;
    expect(rules[legacy]?.redirect.to).toBe(comparison);
    expect(rules[`/raw${legacy}.md`]?.redirect.to).toBe(`/raw${comparison}.md`);
  }

  const fragments: Record<string, Record<string, string>> = docsLegacyFragmentRedirects;
  expect(fragments[comparison]).toEqual({
    "where-nuxthub-is-stronger": `${comparison}#compare-the-features`,
    "what-nuxthub-has-that-vitehub-does-not": `${comparison}#compare-the-features`,
    "move-a-nuxt-app-from-nuxthub": `${comparison}#migrate-from-nuxthub`,
    "keep-a-turso-or-libsql-connection": "/docs/database/configure",
    "keep-the-cache": "/docs/guides/cache-server-results",
    "baseline-an-existing-cloudflare-d1-database": "/docs/database/configure#keep-an-existing-migrations-table",
    "related-guides": `${comparison}#next-steps`,
  });
  expect(guide).toContain("## Compare the features\n");
});
