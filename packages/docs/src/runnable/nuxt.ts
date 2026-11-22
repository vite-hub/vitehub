import { mkdir } from "node:fs/promises"
import { basename, resolve } from "node:path"

import { addTemplate, addTypeTemplate } from "@nuxt/kit"
import { ownModule } from "@vite-hub/internal/build/paths"
import { invariantError } from "@vite-hub/internal/invariant"

import { buildRunnableTutorial, noWorkspaceVersions, readWorkspaceVersions } from "./build.ts"
import { tutorialPageFacts } from "./learn.ts"
import { buildPlaygroundTemplates, snapshotSources } from "./playground.ts"
import { buildTutorialSnapshots, readTutorialSnapshots, tutorialSnapshotInputs } from "./snapshots.ts"
import { checkWorkspacePage, learnLessonSource, pageExamples, playgroundExampleSources, renderExamples, workspacePageModule, workspacePages, workspacePageSlug, workspaceTabComponent } from "./workspaces.ts"

import type { RunnableTutorialSource } from "./build.ts"
import type { PlaygroundTemplateSource } from "./playground.ts"
import type { TutorialSnapshot, TutorialSnapshots } from "./snapshots.ts"
import type { RunnableTutorialData } from "./steps.ts"
import type { WorkspaceContentPage, WorkspacePage } from "./workspaces.ts"

export type DocsRunnableLesson = RunnableTutorialSource
export type DocsRunnableExample = PlaygroundTemplateSource

/** `runnable` of the docs module options. */
export interface DocsRunnableOptions {
  /**
   * The folder of the apps that lessons and examples run, relative to the app root. Defaults to `fixtures`. Each app
   * is a folder in it. The npm lockfile that pins its snapshot sits beside it as `<folder>.package-lock.json`.
   */
  fixtures?: string
  /**
   * @deprecated Give each lesson a page with `layout: learn` instead, which sets its `fixture` in the frontmatter. This
   * list is for an app page that renders the workspace itself and imports `#build/runnable-tutorials.mjs`.
   */
  lessons?: DocsRunnableLesson[]
  /**
   * @deprecated List the examples in the frontmatter of a page with `layout: playground` instead. This list is for an
   * app page that renders the workspace itself and imports `#build/playground-templates.mjs`.
   */
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
  options: { rootDir: string, srcDir: string, dev: boolean, app: { baseURL: string }, routeRules?: Record<string, unknown> }
  hook: (name: "app:templates", callback: () => Promise<void> | undefined) => unknown
}

/** The pages of the docs site, as the docs module reads them from `dir` or `sources`. */
export interface RunnableDocsContent {
  /** The URL, the layout, and the workspace fields of each page. */
  pages: () => readonly WorkspaceContentPage[]
  /** The Markdown of the page at a URL, or nothing when the site has no page there. */
  read: (path: string) => string | undefined
}

/** Where Nitro serves the snapshot parts, under the app base. */
const baseURL = "/_tutorials"

/**
 * Runnable lessons and playground examples.
 *
 * The pages with `layout: learn` and `layout: playground` are the lessons and the examples. Their frontmatter is the
 * only list. `lessons` and `examples` of the options add more, for app pages that render a workspace themselves. Both
 * share one snapshot build, so a lesson and an example with the same dependencies share one snapshot.
 *
 * At build time this reads each lesson and its fixture, and writes:
 * - `#build/docs/workspaces/<page>.mjs`: the workspace data of each `learn` and `playground` page. The result's
 *   `workspaces` is the source of `#docs/workspaces`, which loads them by page path.
 * - `#build/runnable-tutorials.mjs`: the files before step 1 and the files that each step writes, for `lessons`.
 * - `#build/playground-templates.mjs`: the files of each example of `examples`, read from its fixture.
 * - `#build/learn-facts.mjs`: the step count and reading time of each page with `layout: tutorial` or `layout: learn`.
 * - `/_tutorials/snapshots/<slug>.<hash>.<part>.bin`: the `node_modules` of the workspace, so the browser skips
 *   `npm install`. An example with the dependencies of a lesson mounts the snapshot of that lesson. `nuxt build` writes
 *   them, pinned by the lockfile beside each fixture. `nuxt dev` reuses the last ones while their dependencies match
 *   (`tutorialSnapshotInputs`). Set `TUTORIAL_SNAPSHOTS=1` to build them in development, or `TUTORIAL_SNAPSHOTS=0` to
 *   skip them in a build. Without them the workspace installs. `nuxi prepare` never builds them.
 */
export async function setupDocsRunnable(options: DocsRunnableOptions, input: { nuxt: RunnableNuxt, content: RunnableDocsContent }): Promise<{ workspaces: string }> {
  const { nuxt, content } = input
  const rootDir = nuxt.options.rootDir
  const fixturesDir = resolve(rootDir, options.fixtures ?? "fixtures")
  const pages = workspacePages(content.pages())
  for (const page of pages) checkWorkspacePage(page, { rootDir, srcDir: nuxt.options.srcDir, fixturesDir })
  const learnPages = pages.filter(page => page.layout === "learn")
  const containerPages = pages.filter(page => page.layout === "playground" && !page.workspace.render)
  const renderPages = pages.filter(page => page.layout === "playground" && page.workspace.render)
  const pageLessons = learnPages.map(learnLessonSource)
  const lessons = [...options.lessons ?? [], ...pageLessons]
  const examples = [...options.examples ?? [], ...containerPages.flatMap(page => playgroundExampleSources(page, rootDir))]
  const workspaceRoot = options.pnpmWorkspace === undefined ? undefined : resolve(rootDir, options.pnpmWorkspace)
  const versions = workspaceRoot ? await readWorkspaceVersions(workspaceRoot) : noWorkspaceVersions

  nuxt.options.routeRules = {
    ...nuxt.options.routeRules,
    // A content hash names each part, so a part never changes.
    [`${baseURL}/snapshots/**`]: { headers: { "cache-control": "public, max-age=31536000, immutable" } },
  }

  const build = (): Promise<RunnableTutorialData[]> => Promise.all(lessons.map(source => buildRunnableTutorial({ source, readPage: content.read, fixturesDir, versions, start: options.start })))
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
      workDir: resolve(rootDir, "node_modules/.cache/runnable-tutorials-work"),
    }).then((result) => { snapshots = result })
    return built
  })

  // The browser fetches the parts from the app, so their URLs start with the app base. `basename` also reads the
  // `snapshots.json` of older builds, which stored root URLs.
  const partsBase = `${nuxt.options.app.baseURL.replace(/\/+$/, "")}${baseURL}/snapshots/`
  const served = (snapshot: TutorialSnapshot | undefined) => snapshot && { ...snapshot, parts: snapshot.parts.map(part => `${partsBase}${basename(part)}`) }
  const snapshotOf = (slug: string, all: TutorialSnapshots | undefined) => served(all?.[slug])

  const currentTutorials = async () => (nuxt.options.dev ? await build() : tutorials).map(tutorial => ({ ...tutorial, snapshot: snapshotOf(tutorial.slug, snapshots) }))
  const currentTemplates = async () => (nuxt.options.dev ? await buildTemplates() : templates).map(template => ({ ...template, snapshot: snapshotOf(template.snapshotOf, snapshots) }))
  const configLessons = new Set((options.lessons ?? []).map(lesson => lesson.slug))
  const configExamples = new Set((options.examples ?? []).map(example => example.id))
  addTemplate({
    filename: "runnable-tutorials.mjs",
    write: true,
    getContents: async () => `export const runnableTutorials = ${JSON.stringify((await currentTutorials()).filter(tutorial => configLessons.has(tutorial.slug)))}\n`,
  })
  addTemplate({
    filename: "playground-templates.mjs",
    write: true,
    getContents: async () => `export const playgroundTemplates = ${JSON.stringify((await currentTemplates()).filter(template => configExamples.has(template.id)).map(({ assets: _assets, ...template }) => template))}\n`,
  })

  const pageModule = async (page: WorkspacePage): Promise<string> => {
    const port = page.workspace.port ?? 3000
    if (page.layout === "learn") {
      const slug = workspacePageSlug(page.path)
      const tutorial = (await currentTutorials()).find(candidate => candidate.slug === slug)
      if (!tutorial) throw invariantError(`the lesson of ${page.path} was built`)
      return workspacePageModule({ layout: "learn", tutorial, guide: page.workspace.guide ?? "side", port, preview: page.workspace.preview })
    }
    const tabs = (page.workspace.tabs ?? []).map(tab => ({ ...tab, file: workspaceTabComponent(nuxt.options.srcDir, tab.value) }))
    if (page.workspace.render) {
      return workspacePageModule({ layout: "playground", examples: await renderExamples(page, rootDir), port }, { render: resolve(rootDir, page.workspace.render), tabs })
    }
    return workspacePageModule({ layout: "playground", examples: pageExamples(page, await currentTemplates()), port, connect: page.workspace.connect }, { tabs })
  }
  const pageFile = (page: WorkspacePage) => `docs/workspaces/${workspacePageSlug(page.path)}.mjs`
  for (const page of [...learnPages, ...containerPages, ...renderPages]) {
    addTemplate({ filename: pageFile(page), write: true, getContents: () => pageModule(page) })
  }

  addTemplate({
    filename: "learn-facts.mjs",
    write: true,
    getContents: () => {
      const facts = Object.fromEntries(content.pages().filter(page => page.layout === "tutorial" || page.layout === "learn").flatMap((page) => {
        const markdown = content.read(page.layout === "learn" ? page.workspace?.lesson ?? page.path : page.path)
        return markdown === undefined ? [] : [[page.path, tutorialPageFacts(markdown)]]
      }))
      return `export const learnFacts = ${JSON.stringify(facts)}\n`
    },
  })
  // The path of this package's module, not its name: an app on `vite-hub/docs/nuxt` does not list `@vite-hub/docs`.
  const types = JSON.stringify(ownModule(import.meta.url, "runnable"))
  addTypeTemplate({
    filename: "types/runnable-tutorials.d.ts",
    getContents: () => [
      `declare module "#build/runnable-tutorials.mjs" {`,
      `  export const runnableTutorials: import(${types}).RunnableTutorialData[]`,
      `}`,
      `declare module "#build/playground-templates.mjs" {`,
      `  export const playgroundTemplates: import(${types}).PlaygroundTemplate[]`,
      `}`,
      `declare module "#build/learn-facts.mjs" {`,
      `  export const learnFacts: Record<string, import(${types}).LearnPageFacts>`,
      `}`,
    ].join("\n"),
  })

  Reflect.apply(nuxt.hook, nuxt, ["nitro:config", (nitro: NitroConfig) => {
    nitro.publicAssets = [...nitro.publicAssets ?? [], { baseURL, dir: assetsDir }]
  }])

  return { workspaces: docsWorkspacesSource(pages) }
}

/** The source of `#docs/workspaces`: a loader of the page module of each workspace page, by page path. */
export function docsWorkspacesSource(pages: readonly WorkspacePage[]): string {
  return `export default {\n${pages.map(page => `  ${JSON.stringify(page.path)}: () => import(${JSON.stringify(`./workspaces/${workspacePageSlug(page.path)}.mjs`)}),`).join("\n")}\n}\n`
}
