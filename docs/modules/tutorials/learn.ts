import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** What the Learn page shows about one tutorial page, read from its Markdown. */
export interface LearnPageFacts {
  /** The `::tutorial-step` blocks. */
  steps: number;
  /** About how long the tutorial takes, in minutes. */
  minutes: number;
}

/**
 * Reading at 200 words a minute, plus 2 minutes to do each step, rounded up to 5 minutes.
 * Code blocks do not count as reading, because the reader copies or opens them.
 */
export function tutorialMinutes(markdown: string): number {
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, "").replace(/^---[\s\S]*?^---/m, "");
  const words = prose.split(/\s+/).filter(Boolean).length;
  const steps = tutorialSteps(markdown);
  return Math.max(5, Math.ceil((words / 200 + steps * 2) / 5) * 5);
}

export function tutorialSteps(markdown: string): number {
  return markdown.match(/^::tutorial-step\b/gm)?.length ?? 0;
}

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? markdownFiles(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith(".md") ? [join(dir, entry.name)] : [])));
  return nested.flat();
}

/** Facts for each page with `layout: tutorial`, by URL, such as `/docs/kv/get-started`. */
export async function readLearnFacts(contentDir: string): Promise<Record<string, LearnPageFacts>> {
  const facts: Record<string, LearnPageFacts> = {};
  for (const file of await markdownFiles(contentDir)) {
    const markdown = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
    if (!/^layout:\s*tutorial\s*$/m.test(frontmatter)) continue;
    const path = `/${relative(contentDir, file).replace(/\\/g, "/").replace(/\.md$/, "").replace(/\/index$/, "")}`;
    facts[path] = { steps: tutorialSteps(markdown), minutes: tutorialMinutes(markdown) };
  }
  return facts;
}
