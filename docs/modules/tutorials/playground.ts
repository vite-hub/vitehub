import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readTree, resolveManifest } from "./build";

import type { RunnableTutorialSource, WorkspaceVersions } from "./build";
import { dependencyKey } from "./steps";

import type { PlaygroundTemplate } from "./steps";

export interface PlaygroundTemplateSource {
  /** The `?template=` value and the id in share links. */
  id: string;
  label: string;
  description: string;
  /** The folder in `fixtures/tutorials/`, so a template and a tutorial share one copy of the code. */
  fixture: string;
}

/** The templates of `/playground`, in menu order. The first one opens by default. */
export const playgroundTemplates: PlaygroundTemplateSource[] = [
  { id: "kv", label: "KV storage", description: "A Server Primitive that stores settings in KV.", fixture: "server-primitives" },
  { id: "agent", label: "First Agent", description: "An Agent that a route invokes.", fixture: "first-agent" },
];

/**
 * Reads the files of each template from its fixture.
 *
 * A snapshot holds the `dependencies` of a fixture. A template whose fixture has the same dependencies as the fixture
 * of a tutorial names that tutorial in `snapshotOf`, so the playground mounts the same snapshot and the browser keeps
 * one copy. Any other template names `playground-<id>`, and `snapshotSources` adds a snapshot for it.
 */
export async function buildPlaygroundTemplates(input: {
  fixturesDir: string
  versions: WorkspaceVersions
  tutorials: RunnableTutorialSource[]
}): Promise<Omit<PlaygroundTemplate, "snapshot">[]> {
  const manifest = (fixture: string) => readFile(resolve(input.fixturesDir, fixture, "package.json"), "utf8").catch(() => undefined);
  const tutorialKeys = await Promise.all(input.tutorials.map(async tutorial => ({ slug: tutorial.slug, key: dependencyKey(await manifest(tutorial.fixture)) })));
  return Promise.all(playgroundTemplates.map(async (source) => {
    const key = dependencyKey(await manifest(source.fixture));
    const files = await readTree(resolve(input.fixturesDir, source.fixture));
    if (files["package.json"]) files["package.json"] = resolveManifest(files["package.json"], input.versions);
    const snapshotOf = tutorialKeys.find(tutorial => tutorial.key === key)?.slug ?? `playground-${source.id}`;
    return { id: source.id, label: source.label, description: source.description, files, snapshotOf };
  }));
}

/** The tutorials, and a source for each template that shares no snapshot with a tutorial. */
export function snapshotSources(tutorials: RunnableTutorialSource[], templates: Pick<PlaygroundTemplate, "id" | "snapshotOf">[]): RunnableTutorialSource[] {
  const own = templates.filter(template => template.snapshotOf === `playground-${template.id}`);
  return [
    ...tutorials,
    ...own.map(template => ({ slug: template.snapshotOf, page: "/playground", fixture: playgroundTemplates.find(source => source.id === template.id)!.fixture })),
  ];
}
