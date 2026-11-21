import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import { addTemplate, addTypeTemplate } from "@nuxt/kit"

import { buildRunnableTutorial, noWorkspaceVersions, readWorkspaceVersions } from "./build.ts"
import { readLearnFacts } from "./learn.ts"
import { buildPlaygroundTemplates, snapshotSources } from "./playground.ts"
import { buildTutorialSnapshots, readTutorialSnapshots, tutorialSnapshotInputs } from "./snapshots.ts"


import type { RunnableTutorialSource } from "./build.ts"
import type { PlaygroundTemplateSource } from "./playground.ts"
import type { RunnableTutorialData } from "./steps.ts"

export type DocsRunnableLesson = RunnableTutorialSource
export type DocsRunnableExample = PlaygroundTemplateSource

/** `runnable` of the docs module options. */
export interface DocsRunnableOptions {
  /**
   * The folder of the apps that lessons and examples run, relative to the app root. Defaults to `fixtures`. Each app
   * is a folder in it. The npm lockfile that pins its snapshot sits beside it as `<folder>.package-lock.json`.
   */
  fixtures?: string
  /** Lessons that run in the reader's browser. The lesson text is a docs page with `::tutorial-step` blocks. */
  lessons?: DocsRunnableLesson[]
  /** Starting apps of the playground, in menu order. */
  examples?: DocsRunnableExample[]
  /**
   * A docs page, such as `/docs/getting-started/installation`, whose code blocks give the version of a file before the
   * lesson step that writes it. Without it, a file that a step writes does not exist before that step.
   */
  start?: string
  /**
   * The folder of `pnpm-workspace.yaml`, relative to the app root, when fixtures use `catalog:` or `workspace:`
   * specifiers. The workspace packages that a fixture uses are built and packed into its snapshot. Without it, fixtures
   * install from npm only.
   */
  pnpmWorkspace?: string
}

interface NitroConfig {
  publicAssets?: Array<{ baseURL?: string, dir: string }>
}

/** Only the host fields used here: Nuxt and @nuxt/kit can load different compatible schema versions. */
interface RunnableNuxt {
  options: { rootDir: string, dev: boolean, routeRules?: Record<string, unknown> }
  hook: (name: "app:templates", callback: () => Promise<void> | undefined) => unknown
}

const baseURL = "/_tutorials"

/**
 * Runnable lessons and playground examples.
 *
 * At build time this reads each lesson and its fixture, and writes:
 * - `#build/runnable-tutorials.mjs`: the files before step 1 and the files that each step writes.
 * - `#build/playground-templates.mjs`: the files of each example, read from its fixture.
 * - `#build/learn-facts.mjs`: the step count and reading time of each page with `layout: tutorial`.
 * - `/_tutorials/snapshots/<slug>.<hash>.<part>.bin`: the `node_modules` of the workspace, so the browser skips
 *   `npm install`. An example with the dependencies of a lesson mounts the snapshot of that lesson. `nuxt build` writes
 *   them, pinned by the lockfile beside each fixture. `nuxt dev` reuses the last ones while their dependencies match
 *   (`tutorialSnapshotInputs`). Set `TUTORIAL_SNAPSHOTS=1` to build them in development, or `TUTORIAL_SNAPSHOTS=0` to
 *   skip them in a build. Without them the workspace installs. `nuxi prepare` never builds them.
 */
export async function setupDocsRunnable(options: DocsRunnableOptions, input: { nuxt: RunnableNuxt, contentDir: string }): Promise<void> {
  const { nuxt, contentDir } = input
  const rootDir = nuxt.options.rootDir
  const lessons = options.lessons ?? []
  const examples = options.examples ?? []
  const fixturesDir = resolve(rootDir, options.fixtures ?? "fixtures")
  const workspaceRoot = options.pnpmWorkspace === undefined ? undefined : resolve(rootDir, options.pnpmWorkspace)
  const versions = workspaceRoot ? await readWorkspaceVersions(workspaceRoot) : noWorkspaceVersions

  nuxt.options.routeRules = {
    ...nuxt.options.routeRules,
    // A content hash names each part, so a part never changes.
    [`${baseURL}/snapshots/**`]: { headers: { "cache-control": "public, max-age=31536000, immutable" } },
  }

  const build = (): Promise<RunnableTutorialData[]> => Promise.all(lessons.map(source => buildRunnableTutorial({ source, contentDir, fixturesDir, versions, start: options.start })))
  const buildTemplates = () => buildPlaygroundTemplates({ fixturesDir, versions, tutorials: lessons, examples })
  const tutorials = await build()
  const templates = await buildTemplates()
  // Not in buildDir: Nuxt empties it after modules set up, before Nitro copies public assets.
  const assetsDir = resolve(rootDir, "node_modules/.cache/runnable-tutorials")
  await mkdir(assetsDir, { recursive: true })

  const sources = snapshotSources(lessons, examples, templates)
  const inputs = await tutorialSnapshotInputs({ tutorials: sources, workspaceRoot, fixturesDir, versions })
  let snapshots = await readTutorialSnapshots(assetsDir, { inputs, disabled: process.env.TUTORIAL_SNAPSHOTS === "0" })
  if (!snapshots && sources.length > 0 && nuxt.options.dev && process.env.TUTORIAL_SNAPSHOTS !== "1" && process.env.TUTORIAL_SNAPSHOTS !== "0") {
    console.info("[docs] No snapshots of the runnable lessons for the current dependencies, so the workspace runs npm install. Start with TUTORIAL_SNAPSHOTS=1 to build them.")
  }
  // `nuxi prepare` calls `app:templates` too, and it runs on every install and test.
  const buildSnapshots = sources.length > 0 && !Reflect.get(nuxt.options, "_prepare") && (process.env.TUTORIAL_SNAPSHOTS ?? (nuxt.options.dev ? "0" : "1")) === "1"
  // `app:templates` runs before Nuxt reads the templates, and `nuxi preview` does not call it. A later hook does not
  // work: outside dev, `updateTemplates()` does not write the templates again. Dev calls this hook on each change, so build once.
  let built: Promise<void> | undefined
  nuxt.hook("app:templates", () => {
    if (!buildSnapshots) return
    built ??= buildTutorialSnapshots({
      tutorials: sources,
      workspaceRoot,
      fixturesDir,
      versions,
      outDir: assetsDir,
      baseURL,
      workDir: resolve(rootDir, "node_modules/.cache/runnable-tutorials-work"),
    }).then((result) => { snapshots = result })
    return built
  })

  addTemplate({
    filename: "runnable-tutorials.mjs",
    write: true,
    // The lesson or the fixture can change in development, so read them again on each write.
    getContents: async () => {
      const data = (nuxt.options.dev ? await build() : tutorials).map(tutorial => ({ ...tutorial, snapshot: snapshots?.[tutorial.slug] }))
      return `export const runnableTutorials = ${JSON.stringify(data)}\n`
    },
  })
  addTemplate({
    filename: "playground-templates.mjs",
    write: true,
    getContents: async () => {
      const data = (nuxt.options.dev ? await buildTemplates() : templates).map(template => ({ ...template, snapshot: snapshots?.[template.snapshotOf] }))
      return `export const playgroundTemplates = ${JSON.stringify(data)}\n`
    },
  })
  addTemplate({
    filename: "learn-facts.mjs",
    write: true,
    getContents: async () => `export const learnFacts = ${JSON.stringify(await readLearnFacts(contentDir))}\n`,
  })
  addTypeTemplate({
    filename: "types/runnable-tutorials.d.ts",
    getContents: () => [
      `declare module "#build/runnable-tutorials.mjs" {`,
      `  export const runnableTutorials: import("@vite-hub/docs/runnable").RunnableTutorialData[]`,
      `}`,
      `declare module "#build/playground-templates.mjs" {`,
      `  export const playgroundTemplates: import("@vite-hub/docs/runnable").PlaygroundTemplate[]`,
      `}`,
      `declare module "#build/learn-facts.mjs" {`,
      `  export const learnFacts: Record<string, import("@vite-hub/docs/runnable").LearnPageFacts>`,
      `}`,
    ].join("\n"),
  })

  Reflect.apply(nuxt.hook, nuxt, ["nitro:config", (nitro: NitroConfig) => {
    nitro.publicAssets = [...nitro.publicAssets ?? [], { baseURL, dir: assetsDir }]
  }])
}
