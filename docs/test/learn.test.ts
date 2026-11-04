import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildLearnCatalog, filterQuickstarts, learnMeta } from "../app/utils/learn-catalog";
import { readLearnFacts, tutorialMinutes } from "../modules/tutorials/learn";
import { runnableTutorials } from "../modules/tutorials/list";
import { createDocsRedirectRouteRules } from "../modules/vitehub-docs/redirects";

import type { DocsPage, DocsSection } from "@vite-hub/docs";

const docsRoot = resolve(import.meta.dirname, "..");

function page(path: string, extra: Partial<DocsPage> = {}): DocsPage {
  return {
    id: path, path, file: `${path}.md`, title: path, sourceTitle: path, description: `About ${path}`, icon: null,
    layout: "tutorial", sidebar: true, toc: true, kind: null, group: null, navigation: true, order: 0, ...extra,
  };
}
function section(title: string, pages: DocsPage[]): DocsSection {
  return { id: title.toLowerCase(), path: `/docs/${title.toLowerCase()}`, title, description: null, icon: `i-${title}`, category: null, related: [], order: 0, pages };
}

describe("Learn", () => {
  it("sorts tutorial pages into browser tutorials, projects, and quickstarts by primitive", () => {
    const catalog = buildLearnCatalog({
      sections: [
        section("Start", [page("/docs/start/agent"), page("/docs/start/kv"), page("/docs/start/overview", { layout: "docs" })]),
        section("Agents", [page("/docs/agents/chat", { tutorial: "project" }), page("/docs/agents/sandbox")]),
        section("Queue", [page("/docs/queue/get-started"), page("/docs/queue/hidden", { navigation: false })]),
      ],
      runnable: [{ slug: "kv", page: "/docs/start/kv" }, { slug: "agent", page: "/docs/start/agent" }],
      facts: { "/docs/start/kv": { steps: 3, minutes: 10 } },
    });
    // Browser tutorials keep the order of the runnable list and open on Learn.
    expect(catalog.browser.map(entry => entry.to)).toEqual(["/learn/kv", "/learn/agent"]);
    expect(catalog.browser[0]).toMatchObject({ steps: 3, minutes: 10 });
    expect(catalog.projects.map(entry => entry.to)).toEqual(["/docs/agents/chat"]);
    // A page without facts still shows a time, and hidden or non-tutorial pages stay out.
    expect(catalog.quickstarts).toEqual([
      { product: "Agents", icon: "i-Agents", entries: [expect.objectContaining({ to: "/docs/agents/sandbox", minutes: 5 })] },
      { product: "Queue", icon: "i-Queue", entries: [expect.objectContaining({ to: "/docs/queue/get-started" })] },
    ]);
    expect(filterQuickstarts(catalog.quickstarts, "queue").map(group => group.product)).toEqual(["Queue"]);
    expect(filterQuickstarts(catalog.quickstarts, "nothing here")).toEqual([]);
    expect(learnMeta({ steps: 1, minutes: 5 })).toBe("1 step · About 5 min");
    expect(learnMeta({ steps: 0, minutes: 5 })).toBe("About 5 min");
  });

  it("estimates time from the prose and the steps, without code blocks", () => {
    const prose = (words: number) => Array.from({ length: words }, () => "word").join(" ");
    expect(tutorialMinutes(prose(10))).toBe(5);
    // 1000 words is 5 minutes of reading, and 3 steps add 6 minutes: 11, rounded up to 15.
    const lesson = `---\ntitle: T\n---\n${prose(1000)}\n::tutorial-step{title="a"}\n::\n::tutorial-step{title="b"}\n::\n::tutorial-step{title="c"}\n::\n`;
    expect(tutorialMinutes(lesson)).toBe(15);
    expect(tutorialMinutes(`${lesson}\n\`\`\`ts\n${prose(5000)}\n\`\`\`\n`)).toBe(15);
  });

  it("reads facts for every runnable tutorial from the docs content", async () => {
    const facts = await readLearnFacts(resolve(docsRoot, "content"));
    for (const tutorial of runnableTutorials) expect(facts[tutorial.page]?.steps, tutorial.page).toBeGreaterThan(0);
    expect(facts["/docs/kv/get-started"]).toBeDefined();
  });

  it("sends the old Blog and Guides paths to Learn", () => {
    const rules = createDocsRedirectRouteRules({});
    expect(rules["/blog"]?.redirect.to).toBe("/learn");
    expect(rules["/guides"]?.redirect.to).toBe("/learn");
  });
});
