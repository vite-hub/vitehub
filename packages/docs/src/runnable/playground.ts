import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { invariantError } from "@vite-hub/internal/invariant"

import { readTree, resolveManifest } from "./build.ts"
import { dependencyKey } from "./steps.ts"

import type { RunnableTutorialSource, WorkspaceVersions } from "./build.ts"
import type { PlaygroundTemplate } from "./steps.ts"

/** A starting app of the playground. */
export interface PlaygroundTemplateSource {
  /** The `?template=` value and the id in share links. */
  id: string
  label: string
  description?: string
  /** The heading of the example in the examples menu. */
  group?: string
  /**
   * The folder in the fixtures folder, so an example and a lesson can share one copy of the code. An absolute path,
   * such as the `dir` of a `layout: playground` example, works too.
   */
  fixture: string
  /** The file that the editor opens first. */
  open?: string
  /** The path that the preview opens when the dev server is ready. */
  preview?: string
}

/**
 * Reads the files of each example from its fixture.
 *
 * A snapshot holds the `dependencies` of a fixture. An example whose fixture has the same dependencies as the fixture
 * of a lesson names that lesson in `snapshotOf`, so the playground mounts the same snapshot and the browser keeps one
 * copy. Any other example names `playground-<id>` of the first example with its dependencies, and `snapshotSources`
 * adds a snapshot for it.
 */
export async function buildPlaygroundTemplates(input: {
  fixturesDir: string
  versions: WorkspaceVersions
  tutorials: RunnableTutorialSource[]
  examples: PlaygroundTemplateSource[]
}): Promise<Omit<PlaygroundTemplate, "snapshot">[]> {
  const manifest = (fixture: string) => readFile(resolve(input.fixturesDir, fixture, "package.json"), "utf8").catch(() => undefined)
  const tutorialKeys = await Promise.all(input.tutorials.map(async tutorial => ({ slug: tutorial.slug, key: dependencyKey(await manifest(tutorial.fixture)) })))
  const read = await Promise.all(input.examples.map(async (source) => {
    const files = await readTree(resolve(input.fixturesDir, source.fixture))
    if (files["package.json"]) files["package.json"] = resolveManifest(files["package.json"], input.versions)
    return { source, files, key: dependencyKey(await manifest(source.fixture)) }
  }))
  const shared = new Map(tutorialKeys.toReversed().map(tutorial => [tutorial.key, tutorial.slug]))
  return read.map(({ source, files, key }) => {
    const snapshotOf = shared.get(key) ?? `playground-${source.id}`
    shared.set(key, snapshotOf)
    const { id, label, description, group, open, preview } = source
    return { id, label, description, group, open, preview, files, snapshotOf }
  })
}

/** The lessons, and a source for each example that shares no snapshot with a lesson. */
export function snapshotSources(tutorials: RunnableTutorialSource[], examples: PlaygroundTemplateSource[], templates: Pick<PlaygroundTemplate, "id" | "snapshotOf">[]): RunnableTutorialSource[] {
  const own = templates.filter(template => template.snapshotOf === `playground-${template.id}`)
  return [
    ...tutorials,
    ...own.map((template) => {
      const example = examples.find(source => source.id === template.id)
      if (!example) throw invariantError(`a playground template comes from an example (${template.id})`)
      return { slug: template.snapshotOf, page: "/playground", fixture: example.fixture }
    }),
  ]
}
