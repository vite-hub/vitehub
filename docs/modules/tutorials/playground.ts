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
  /** The file that the editor opens first. */
  open: string;
  /** The path that the preview opens when the dev server is ready. */
  preview: string;
}

/** The templates of `/playground`, in menu order. The first one opens by default. */
export const playgroundTemplates: PlaygroundTemplateSource[] = [
  { id: "kv", label: "KV", description: "Store and read a value.", fixture: "server-primitives", open: "server/api/settings.post.ts", preview: "/api/health" },
  { id: "blob", label: "Blob", description: "Write a file and read it back.", fixture: "playground-blob", open: "server/api/note.get.ts", preview: "/api/note" },
  { id: "queue", label: "Queue", description: "Run a job in the background.", fixture: "playground-queue", open: "server/queues/welcome-email.ts", preview: "/api/welcome" },
  { id: "cache", label: "Cache", description: "Cache a route for 10 seconds.", fixture: "playground-cache", open: "server/api/time.get.ts", preview: "/api/time" },
  { id: "rate-limit", label: "Rate Limit", description: "Allow three requests a minute.", fixture: "playground-rate-limit", open: "server/api/upload.get.ts", preview: "/api/upload" },
  { id: "agent", label: "Agent", description: "An Agent that a route invokes.", fixture: "first-agent", open: "server/agents/greeting.ts", preview: "/api/health" },
  { id: "channels", label: "Channels", description: "Chat with an Agent in a simulated Slack.", fixture: "playground-channels", open: "server/agents/support.ts", preview: "/api/_vitehub/agents/support/webhooks/slack" },
  { id: "ui", label: "ViteHub UI", description: "A Vue app with a dialog, tabs, a menu, and toasts.", fixture: "playground-ui", open: "src/App.vue", preview: "/" },
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
    return { id: source.id, label: source.label, description: source.description, open: source.open, preview: source.preview, files, snapshotOf };
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
