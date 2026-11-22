import type { DocsAppPage, DocsSection } from "@vite-hub/docs";

export interface LearnFacts {
  steps: number;
  minutes: number;
}

export interface LearnEntry {
  title: string;
  description: string;
  /** The section of the docs, such as `Queue`. */
  product: string;
  icon: string | null;
  to: string;
  /** The docs page, for a runnable tutorial that opens on Learn. */
  page: string;
  steps: number;
  minutes: number;
}

/** A group of quickstarts with the primitive that they teach. */
export interface LearnQuickstartGroup {
  product: string;
  icon: string | null;
  entries: LearnEntry[];
}

export interface LearnCatalog {
  /** Tutorials that run beside a live workspace on their `layout: learn` page. */
  browser: LearnEntry[];
  /** Complete projects on the reader's machine. */
  projects: LearnEntry[];
  /** Short quickstarts, one group per docs section, in docs order. */
  quickstarts: LearnQuickstartGroup[];
}

/** Sorts the tutorial pages of the docs into the groups of the Learn page. */
export function buildLearnCatalog(input: {
  sections: readonly DocsSection<DocsAppPage>[]
  /** The `layout: learn` pages, in the order to take them: `path` runs the steps of the docs page `lesson`. */
  runnable: readonly { path: string, lesson: string }[]
  facts: Readonly<Record<string, LearnFacts>>
}): LearnCatalog {
  const runnable = new Map(input.runnable.map(tutorial => [tutorial.lesson, tutorial.path]));
  const catalog: LearnCatalog = { browser: [], projects: [], quickstarts: [] };
  for (const section of input.sections) {
    const entries: LearnEntry[] = [];
    for (const page of section.pages) {
      if (page.layout !== "tutorial" || !page.navigation) continue;
      const learn = runnable.get(page.path);
      const facts = input.facts[page.path] ?? { steps: 0, minutes: 5 };
      const entry: LearnEntry = {
        title: page.sourceTitle || page.title,
        description: page.description ?? "",
        product: section.title,
        icon: page.icon ?? section.icon,
        to: learn ?? page.path,
        page: page.path,
        ...facts,
      };
      if (learn) catalog.browser.push(entry);
      else if (page.tutorial === "project") catalog.projects.push(entry);
      else entries.push(entry);
    }
    if (entries.length) catalog.quickstarts.push({ product: section.title, icon: section.icon, entries });
  }
  // The runnable tutorials follow the order of their learn pages, which is the order to take them in.
  const order = input.runnable.map(tutorial => tutorial.lesson);
  catalog.browser.sort((a, b) => order.indexOf(a.page) - order.indexOf(b.page));
  return catalog;
}

/** Keeps the quickstart groups and entries whose text has every word of the query. */
export function filterQuickstarts(groups: readonly LearnQuickstartGroup[], query: string): LearnQuickstartGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...groups];
  return groups.flatMap((group) => {
    const entries = group.entries.filter((entry) => {
      const text = `${entry.title} ${entry.description} ${entry.product}`.toLowerCase();
      return words.every(word => text.includes(word));
    });
    return entries.length ? [{ ...group, entries }] : [];
  });
}

/** "3 steps · About 10 min" */
export function learnMeta(entry: Pick<LearnEntry, "steps" | "minutes">): string {
  const parts = entry.steps ? [`${entry.steps} ${entry.steps === 1 ? "step" : "steps"}`] : [];
  return [...parts, `About ${entry.minutes} min`].join(" · ");
}
