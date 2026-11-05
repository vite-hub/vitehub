import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildLearnCatalog, filterQuickstarts, learnMeta } from "../app/utils/learn-catalog";
import { readLearnFacts, tutorialMinutes } from "../modules/tutorials/learn";
import { runnableTutorials } from "../modules/tutorials/list";
import { createDocsRedirectRouteRules } from "../modules/vitehub-docs/redirects";

import type { DocsPage, DocsSection } from "@vite-hub/docs";

const docsRoot = resolve(import.meta.dirname, "..");

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>();
  return { ...path, relative: vi.fn(path.relative) };
});

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

  it.each([
    { lineEnding: "LF", newline: "\n", relativePath: "docs/kv/index.md" },
    { lineEnding: "CRLF", newline: "\r\n", relativePath: "docs/kv/index.md" },
    { lineEnding: "LF", newline: "\n", relativePath: "docs\\kv\\index.md" },
    { lineEnding: "CRLF", newline: "\r\n", relativePath: "docs\\kv\\index.md" },
  ])("reads $lineEnding facts at $relativePath using a URL key", async ({ newline, relativePath }) => {
    const contentDir = await mkdtemp(join(tmpdir(), "learn-facts-"));
    try {
      const directory = join(contentDir, "docs", "kv");
      await mkdir(directory, { recursive: true });
      const markdown = [
        "---", "layout: tutorial", "---",
        "word ".repeat(600),
        '::tutorial-step{title="One"}', "::",
        '::tutorial-step{title="Two"}', "::",
        "```ts", "code ".repeat(5000), "```", "",
      ].join(newline);
      await writeFile(join(directory, "index.md"), markdown);
      vi.mocked(relative).mockReturnValueOnce(relativePath);

      expect(await readLearnFacts(contentDir)).toEqual({ "/docs/kv": { steps: 2, minutes: 10 } });
    } finally {
      vi.mocked(relative).mockReset();
      await rm(contentDir, { recursive: true, force: true });
    }
  });

  it("sends the old Blog and Guides paths to Learn", () => {
    const rules = createDocsRedirectRouteRules({});
    expect(rules["/blog"]?.redirect.to).toBe("/learn");
    expect(rules["/guides"]?.redirect.to).toBe("/learn");
  });
});
