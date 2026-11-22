import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";

import { docsPageOf } from "../../packages/docs/src/page";
import { docsFrontmatter, docsPageSchema } from "../../packages/docs/src/schema";
import { learnLessonSource, playgroundExampleSources } from "../../packages/docs/src/runnable/workspaces";

import type { RunnableTutorialSource } from "../../packages/docs/src/runnable/build";
import type { PlaygroundTemplateSource } from "../../packages/docs/src/runnable/playground";
import type { WorkspacePage } from "../../packages/docs/src/runnable/workspaces";

// The lessons and the playground of vitehub.dev are `layout: learn` and `layout: playground` pages. The tests read
// their frontmatter and build them as the docs module does.
const docsRoot = resolve(import.meta.dirname, "..");

async function workspacePage(file: string): Promise<WorkspacePage & { order: number }> {
  const source = await readFile(resolve(docsRoot, "content", file), "utf8");
  const frontmatter = docsPageSchema.parse(docsFrontmatter(parse(source.split(/^---$/m)[1] ?? "")));
  const id = file.replace(/\.md$/, "");
  const page = docsPageOf(frontmatter, { id, path: `/${id}`, file });
  if ((page.layout !== "learn" && page.layout !== "playground") || !page.workspace) throw new Error(`${file} is not a workspace page`);
  return { path: page.path, layout: page.layout, workspace: page.workspace, order: page.order };
}

/** The `layout: learn` pages, in their `navigation.order`, which is the order to take them in. */
export async function learnPages(): Promise<WorkspacePage[]> {
  const files = (await readdir(resolve(docsRoot, "content/learn"))).filter(file => file.endsWith(".md"));
  const pages = await Promise.all(files.map(file => workspacePage(`learn/${file}`)));
  return pages.sort((a, b) => a.order - b.order);
}

/** The lessons that the docs module builds from the learn pages. */
export async function runnableLessons(): Promise<RunnableTutorialSource[]> {
  return (await learnPages()).map(learnLessonSource);
}

/** The `/playground` page. */
export function playgroundPage(): Promise<WorkspacePage> {
  return workspacePage("playground.md");
}

/** The examples of `/playground`, as the docs module builds them. */
export async function playgroundExamples(): Promise<PlaygroundTemplateSource[]> {
  return playgroundExampleSources(await playgroundPage(), docsRoot);
}
